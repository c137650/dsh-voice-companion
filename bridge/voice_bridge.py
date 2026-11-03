"""
Voice bridge — reuse the speech-to-speech STT / TTS handlers as a local HTTP
service for the DSH voice plugin.

Pipeline of the original backend (VAD -> STT -> LLM -> TTS) is NOT started:
this service instantiates only the STT and TTS handlers and exposes them over
HTTP, so the DSH agent itself plays the LLM role.

Buildout (see DSH-语音接入-设计方案.md):
  T1  skeleton + /api/health                          done
  T2  /api/stt   (WhisperSTTHandler, lazy load)       done
  T3  /api/tts   (Qwen3TTSHandler, lazy load)         done
  T8  /api/media/* lists + /media/* static mounts     <- current step

Run:
  D:\\speech-to-speech\\venv-speech\\Scripts\\python.exe -m uvicorn voice_bridge:app \
      --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from uuid import uuid4

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "bridge-config.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("voice_bridge")

# 日志同时落盘：桥接平时跑在自己的控制台窗口里，窗口一关/没看着就无法回看，
# 「任务到底提交了没有、失败在哪一步」只能靠猜。这里额外挂一个轮转文件日志
# （logs/bridge.log, 4MB × 4）。写盘失败只告警，不影响服务。
try:
    from logging.handlers import RotatingFileHandler

    _log_dir = HERE / "logs"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _file_handler = RotatingFileHandler(
        _log_dir / "bridge.log", maxBytes=4 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    _file_handler.setFormatter(
        logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    )
    logging.getLogger().addHandler(_file_handler)
    logger.info("bridge log file -> %s", _log_dir / "bridge.log")
except Exception:  # noqa: BLE001
    logger.exception("bridge log file setup failed (console logging continues)")


def load_config() -> dict:
    # utf-8-sig 容忍 BOM（某些工具如 PowerShell 5.1 Set-Content 会写 BOM）
    with open(CONFIG_PATH, encoding="utf-8-sig") as f:
        return json.load(f)


CONFIG = load_config()

app = FastAPI(title="voice-bridge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CONFIG.get("cors_origins", ["http://127.0.0.1:3080"]),
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _allow_private_network(request, call_next):
    """DSH 桌面端渲染进程使用 dsh-app:// 自定义协议，访问本机 127.0.0.1 时
    Chromium 会发 Private Network Access 预检并要求该响应头；缺了它浏览器会
    直接拦截响应，插件就永远判定「未检测到 voice bridge」。"""
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


class ModelManager:
    """Owns the two lazily-loaded model handlers.

    Handlers are loaded on first use (heavy: whisper-large-v3 + qwen3-tts,
    plus TTS warmup ~10-60s), guarded by a lock so concurrent requests queue
    instead of double-loading. A shared `infer_lock` serializes ALL model
    work (STT + TTS share the one GPU; single-user local service).
    """

    def __init__(self) -> None:
        self._stt = None
        self._tts = None
        self._stt_error: str | None = None
        self._tts_error: str | None = None
        self._load_lock = asyncio.Lock()
        # Serializes every model inference call (STT + TTS) on the shared GPU.
        self.infer_lock = asyncio.Lock()

    @property
    def stt_ready(self) -> bool:
        return self._stt is not None

    @property
    def tts_ready(self) -> bool:
        return self._tts is not None

    @property
    def stt_error(self) -> str | None:
        return self._stt_error

    @property
    def tts_error(self) -> str | None:
        return self._tts_error

    async def ensure_stt(self):
        """Lazily load the Whisper STT handler once (thread off the event loop)."""
        async with self._load_lock:
            if self._stt is not None:
                return self._stt
            if self._stt_error is not None:
                raise HTTPException(status_code=503, detail=f"STT model failed to load: {self._stt_error}")
            try:
                self._stt = await asyncio.to_thread(_load_stt_handler)
            except Exception as exc:  # noqa: BLE001 - surfaced to the client
                logger.exception("STT model load failed")
                self._stt_error = f"{type(exc).__name__}: {exc}"
                raise HTTPException(status_code=503, detail=f"STT model load failed: {self._stt_error}")
        return self._stt

    async def ensure_tts(self):
        """Lazily load the Qwen3 TTS handler once (T3)."""
        async with self._load_lock:
            if self._tts is not None:
                return self._tts
            if self._tts_error is not None:
                raise HTTPException(status_code=503, detail=f"TTS model failed to load: {self._tts_error}")
            try:
                self._tts = await asyncio.to_thread(_load_tts_handler)
            except Exception as exc:  # noqa: BLE001 - surfaced to the client
                logger.exception("TTS model load failed")
                self._tts_error = f"{type(exc).__name__}: {exc}"
                raise HTTPException(status_code=503, detail=f"TTS model load failed: {self._tts_error}")
        return self._tts


def _load_stt_handler():
    """Instantiate the configured STT backend: 'funasr' (Chinese ASR, default
    when configured) or the original WhisperSTTHandler fallback."""
    backend = CONFIG["stt"].get("backend", "whisper")
    if backend == "funasr":
        return _load_funasr_handler()

    from queue import Empty, Queue
    from threading import Event

    from speech_to_speech.STT.whisper_stt_handler import WhisperSTTHandler

    cfg = dict(CONFIG["stt"])
    cfg.pop("backend", None)
    handler = WhisperSTTHandler(
        Event(),
        queue_in=Queue(),
        queue_out=Queue(),
        setup_args=(),
        setup_kwargs=cfg,
    )
    return handler


def _load_funasr_handler():
    """Lazily load the FunASR Chinese ASR model (Paraformer-large, 16k).

    Returns the funasr AutoModel; transcribing goes through _transcribe_funasr.
    The FunASR AutoModel caches its own singleton, so repeated loads are cheap.
    """
    from funasr import AutoModel

    model_name = CONFIG["stt"].get(
        "model_name",
        "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    )
    device = CONFIG["stt"].get("device", "cuda")
    dtype = CONFIG["stt"].get("torch_dtype", "float16")
    return AutoModel(
        model=model_name,
        trust_remote_code=True,
        device=device,
        dtype=dtype,
    )


def _load_tts_handler():
    """Instantiate Qwen3TTSHandler with bridge-config.json['tts'] settings (T3)."""
    from queue import Queue
    from threading import Event

    from speech_to_speech.TTS.qwen3_tts_handler import Qwen3TTSHandler

    # tts 段里除模型参数外还有本 bridge 自己的引擎开关（engine / gptsovits），
    # 透传给 Qwen3TTSHandler 会让它的 setup() 因未知关键字抛 TypeError。
    cfg = {k: v for k, v in CONFIG["tts"].items() if k not in ("engine", "gptsovits")}
    handler = Qwen3TTSHandler(
        Event(),
        queue_in=Queue(),
        queue_out=Queue(),
        setup_args=(Event(),),  # should_listen
        setup_kwargs=cfg,
    )
    return handler


def decode_audio(body: bytes, content_type: str) -> np.ndarray:
    """Decode request audio to float32 mono at 16 kHz.

    Accepts WAV (any rate/channels soundfile can read) or raw little-endian
    16-bit PCM mono at 16 kHz (the mic-capture worklet output)."""
    if content_type == "audio/wav" or body[:4] == b"RIFF":
        import soundfile as sf

        data, sr = sf.read(io.BytesIO(body), dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
    else:
        raw = np.frombuffer(body, dtype="<i2")
        data = raw.astype(np.float32) / 32768.0
        sr = 16000
    if sr != 16000:
        from scipy.signal import resample_poly

        gcd = int(np.gcd(sr, 16000))
        data = resample_poly(data, up=16000 // gcd, down=sr // gcd)
    return np.ascontiguousarray(data, dtype=np.float32)


def decode_wav_native(body: bytes) -> tuple[np.ndarray, int]:
    """解码 WAV 并保留原始采样率（不重采样）。

    TTS 输出必须走这条路：GPT-SoVITS 产出 32 kHz，若强行降到 16 kHz，奈奎斯
    特上限只剩 8 kHz，高频被削掉，听感就是"闷、糊"。"""
    import soundfile as sf

    data, sr = sf.read(io.BytesIO(body), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    return np.ascontiguousarray(data, dtype=np.float32), int(sr)


def _transcribe(handler, audio: np.ndarray) -> tuple[str, str | None]:
    if CONFIG["stt"].get("backend", "whisper") == "funasr":
        return _transcribe_funasr(handler, audio)

    from speech_to_speech.pipeline.messages import VADAudio

    try:
        transcription = next(iter(handler.process(VADAudio(audio=audio))))
    except IndexError:
        # Upstream whisper handler assumes >= 2 generated tokens (language
        # token + content) and reads pred_ids[0, 1]; a near-silent or very
        # short utterance can produce a single token and crash. Guard: treat
        # it as an empty transcription so continuous listening never breaks.
        logger.warning("STT: whisper returned a degenerate (1-token) generation; treating as empty")
        return "", None
    return transcription.text, transcription.language_code


def _transcribe_funasr(model, audio: np.ndarray) -> tuple[str, str | None]:
    """Transcribe 16 kHz mono float32 audio with the FunASR model."""
    try:
        result = model.generate(input=audio, cache={})
        text = (result[0].get("text") or "").strip() if result else ""
        if not text:
            logger.warning("STT: funasr returned empty result; treating as empty")
        return text, "zh"
    except Exception:  # noqa: BLE001 - surfaced to the client
        logger.exception("STT: funasr transcribe failed")
        return "", None


models = ModelManager()


@app.post("/api/warmup")
async def warmup() -> dict:
    """Preload the models so the first real request is already hot.

    DSH 启动时插件会调这里：STT 直接加载 FunASR；TTS 若是 GPT-SoVITS 引擎，
    就把外部服务拉起来并推好权重。返回时只保证"已经尝试"，失败原因写进字段，
    不抛异常——预热失败不该让任何一个客户端拿不到服务。
    """
    result: dict = {"stt": "skipped", "tts": "skipped"}
    try:
        await models.ensure_stt()
        result["stt"] = "ready"
    except Exception as exc:  # noqa: BLE001
        logger.exception("warmup: STT 加载失败")
        result["stt"] = f"error: {exc}"

    try:
        if str(CONFIG.get("tts", {}).get("engine", "qwen3")).lower() == "gptsovits":
            await asyncio.to_thread(_ensure_sovits)
            result["tts"] = "ready (gptsovits)"
        else:
            await models.ensure_tts()
            result["tts"] = "ready"
    except Exception as exc:  # noqa: BLE001
        logger.exception("warmup: TTS 加载失败")
        result["tts"] = f"error: {exc}"

    logger.info("warmup result: %s", result)
    return result


@app.get("/api/health")
async def health() -> dict:
    """Model readiness probe. Overall status is 'ok' once the app serves;
    stt/tts flags reflect lazy model load state (false until first use).
    GPT-SoVITS 是外部进程后端，tts 标志直接反映那个服务在不在。"""
    tts_ready = models.tts_ready
    tts_error = models.tts_error
    if str(CONFIG.get("tts", {}).get("engine", "qwen3")).lower() == "gptsovits":
        base = str(_sovits_cfg().get("base") or "").rstrip("/")
        # 探活结果缓存几秒：插件每 30s 轮询一次，用 0.5s 的硬超时既容易被
        # 连接抖动打成假失败，也没必要每次健康检查都真的打一遍下游。
        tts_ready = _sovits_cached_probe(base)
        tts_error = None if tts_ready else f"GPT-SoVITS 不可达：{base}"
    return {
        "status": "ok",
        "stt": models.stt_ready,
        "tts": tts_ready,
        "stt_error": models.stt_error,
        "tts_error": tts_error,
    }


@app.post("/api/stt")
async def stt(request: Request) -> dict:
    """Speech to text: 16 kHz PCM16 (raw or WAV) -> { text, language }."""
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    audio = await asyncio.to_thread(decode_audio, body, request.headers.get("content-type", ""))
    duration = len(audio) / 16000.0
    max_sec = float(request.headers.get("X-Max-Audio-Sec", "30") or "30")
    if duration > max_sec:
        raise HTTPException(
            status_code=422,
            detail=f"Audio too long: {duration:.1f}s exceeds X-Max-Audio-Sec {max_sec}s",
        )
    async with models.infer_lock:
        handler = await models.ensure_stt()
        text, language = await asyncio.to_thread(_transcribe, handler, audio)
    return {"text": text, "language": language}


# ── GPT-SoVITS 引擎（第三种可选后端）────────────────────────────────────────
# 与 Qwen3 / OmniVoice 并列：把合成委托给本机的 GPT-SoVITS api_v2 服务
# （默认 127.0.0.1:9880），用训练好的音色权重做克隆。收益是自然度与延迟，
# 代价是另有一个进程常驻显存。开关：bridge-config.json 的 tts.engine。
_SOVITS_STATE: dict = {"ready": False, "proc": None}
_SOVITS_LOCK = threading.Lock()
# 探活与合成共用一个长连接的客户端。以前每次 httpx.get 都新建客户端却不关闭，
# 插件每 30 秒探一次健康检查，几十次之后 Windows 上句柄与端口耗尽，探活就会
# 假失败（服务明明活着却报不可达）。
_SOVITS_CLIENT: httpx.Client | None = None


def _sovits_client() -> httpx.Client:
    global _SOVITS_CLIENT
    if _SOVITS_CLIENT is None:
        _SOVITS_CLIENT = httpx.Client(
            timeout=httpx.Timeout(float(_sovits_cfg().get("timeout_sec", 300)), connect=5.0),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )
    return _SOVITS_CLIENT


def _sovits_cfg() -> dict:
    return CONFIG.get("tts", {}).get("gptsovits", {}) or {}


def _sovits_reachable(base: str, timeout: float = 2.0) -> bool:
    """端口层探活：只做 TCP 连接，不发 HTTP 请求。

    早先用 httpx 探 /docs，而健康检查跑在事件循环线程、合成跑在 worker 线程，
    两边共用一个连接池时会在跨线程复用上偶发失败，表现成"服务明明活着却报
    不可达"。TCP 握手既便宜又不受连接池影响，正好回答"进程还在不在"。
    """
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(base)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _sovits_cached_probe(base: str, ttl: float = 10.0) -> bool:
    """带缓存的探活：ttl 秒内复用上一次结果，避免健康检查把下游打爆。"""
    if not base:
        return False
    now = time.time()
    cache = _SOVITS_STATE.get("probe")
    if cache and now - cache[0] < ttl:
        return cache[1]
    ok = _sovits_reachable(base, 3.0)
    _SOVITS_STATE["probe"] = (now, ok)
    if not ok:
        _SOVITS_STATE["probe"] = (now, ok)
    return ok


def _sovits_autostart(base: str) -> None:
    """按配置拉起 api_v2.py（detached，不占用桥接的控制台）。"""
    cfg = _sovits_cfg()
    if not cfg.get("autostart", False):
        raise RuntimeError(f"GPT-SoVITS 不可达：{base}，且未开启 autostart")
    python = cfg.get("python")
    cwd = cfg.get("cwd")
    args = cfg.get("args") or []
    if not python or not cwd:
        raise RuntimeError("GPT-SoVITS autostart 需要 tts.gptsovits.python 与 .cwd")
    logger.info("GPT-SoVITS 不可达，自动启动：%s %s", python, " ".join(args))
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        # 提权：合成延迟的抖动很大一部分来自 CPU 争抢（浏览器、编辑器抢核时
        # 分词与特征提取会变慢）。把推理进程提到 HIGH 优先级能把抖动压下来。
        if str(cfg.get("priority", "")).lower() == "high":
            flags |= getattr(subprocess, "HIGH_PRIORITY_CLASS", 0)
    _SOVITS_STATE["proc"] = subprocess.Popen(
        [python, *args],
        cwd=cwd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
        close_fds=True,
    )
    deadline = time.time() + float(cfg.get("startup_timeout_sec", 240))
    while time.time() < deadline:
        if _sovits_reachable(base, 1.0):
            logger.info("GPT-SoVITS 已就绪：%s", base)
            return
        time.sleep(2)
    raise RuntimeError("GPT-SoVITS 启动超时")


def _sovits_set_weights(base: str) -> None:
    """把配置里的音色权重推到 GPT-SoVITS（服务重启后需要重设）。"""
    cfg = _sovits_cfg()
    for key, endpoint in (("gpt_weights", "set_gpt_weights"), ("sovits_weights", "set_sovits_weights")):
        path = cfg.get(key)
        if not path:
            continue
        try:
            resp = _sovits_client().get(f"{base}/{endpoint}", params={"weights_path": path}, timeout=180)
            if resp.status_code != 200:
                logger.warning("GPT-SoVITS %s -> %s %s", endpoint, resp.status_code, resp.text[:200])
        except Exception:  # noqa: BLE001
            logger.exception("GPT-SoVITS %s 失败", endpoint)


def _ensure_sovits() -> str:
    base = str(_sovits_cfg().get("base") or "").rstrip("/")
    if not base:
        raise RuntimeError("bridge-config.json 缺 tts.gptsovits.base")
    with _SOVITS_LOCK:
        if not _SOVITS_STATE["ready"]:
            if not _sovits_reachable(base):
                _sovits_autostart(base)
            _sovits_set_weights(base)
            _SOVITS_STATE["ready"] = True
    return base


def _clean_for_tts(text: str) -> str:
    """把 TTS 引擎处理不了的字符剔掉，只留下能正常朗读的内容。

    GPT-SoVITS 的分词链遇到 emoji、markdown 符号（* ` #）、控制字符时可能
    直接返回 400，而插件侧只会记一条控制台错误、那一句就不出声了。
    """
    keep_extra = set("，。！？、；：“”‘’（）《》…—,.!?;:()[]'\"- ")
    out = []
    for ch in text:
        if ch.isalnum() or ch in keep_extra:
            out.append(ch)
    return "".join(out).strip()


def _synthesize_gptsovits(text: str, cancel: threading.Event | None = None) -> np.ndarray:
    """用 GPT-SoVITS 合成一整句，返回 16 kHz int16 采样。"""
    cfg = _sovits_cfg()
    tts_cfg = CONFIG.get("tts", {})
    base = _ensure_sovits()
    persona = PERSONAS.get(_current_persona, {})
    ref_audio = cfg.get("ref_audio") or persona.get("ref_audio") or tts_cfg.get("ref_audio", "")
    prompt_text = cfg.get("prompt_text") or persona.get("ref_text") or tts_cfg.get("ref_text", "")
    # 参考文本文件可能带 UTF-8 BOM（PowerShell 的 Set-Content 默认会写），
    # GPT-SoVITS 内部按 GBK 分词时遇到 \ufeff 会直接报错，这里统一剥掉。
    prompt_text = str(prompt_text).replace("\ufeff", "").strip()
    payload = {
        "text": text,
        "text_lang": cfg.get("text_lang", "zh"),
        "ref_audio_path": str(ref_audio).replace("\\", "/"),
        "prompt_text": prompt_text,
        "prompt_lang": cfg.get("prompt_lang", "zh"),
        "text_split_method": cfg.get("text_split_method", "cut5"),
        "batch_size": int(cfg.get("batch_size", 1)),
        "media_type": "wav",
        "streaming_mode": False,
        "speed_factor": float(cfg.get("speed_factor", 1.0)),
    }
    if cancel is not None and cancel.is_set():
        return np.zeros(0, dtype=np.int16)

    def _post(url: str):
        return _sovits_client().post(f"{url}/tts", json=payload)

    try:
        resp = _post(base)
    except httpx.HTTPError:
        # GPT-SoVITS 进程可能被关掉/崩溃了：清掉就绪标记，重新拉起再试一次。
        logger.warning("GPT-SoVITS 请求失败，准备重启后重试")
        with _SOVITS_LOCK:
            _SOVITS_STATE["ready"] = False
        base = _ensure_sovits()
        resp = _post(base)
    if resp.status_code != 200:
        # 400 多半是文本里有 GPT-SoVITS 处理不了的东西（emoji、markdown 符号、
        # 生僻控制字符）。先记下来，再清洗一遍重试一次，避免整句被静默丢掉。
        logger.warning("GPT-SoVITS /tts %s: %s | text=%r", resp.status_code, resp.text[:200], text[:80])
        cleaned = _clean_for_tts(text)
        if cleaned and cleaned != text:
            payload["text"] = cleaned
            resp = _post(base)
            if resp.status_code == 200:
                logger.info("GPT-SoVITS 清洗后重试成功：%r -> %r", text[:40], cleaned[:40])
        if resp.status_code != 200:
            raise RuntimeError(f"GPT-SoVITS /tts {resp.status_code}: {resp.text[:300]}")
    audio, sr = decode_wav_native(resp.content)
    return (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16), sr


class TTSRequest(BaseModel):
    text: str


@app.post("/api/tts")
async def tts(req: TTSRequest, request: Request) -> Response:
    """Text to speech: { text } -> 16 kHz mono PCM16 WAV (Xiaoya voice clone).

    Cooperative cancellation: while the client aborts its fetch (the voice
    toggle turned off), the request disconnects here; a watchdog sets a
    threading event and the synthesis loop stops between chunks, so the GPU
    is freed immediately instead of draining the queue."""
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    if len(text) > 512:
        logger.warning("TTS text truncated from %d to 512 chars", len(text))
        text = text[:512]

    cancel = threading.Event()

    async def watch_disconnect() -> None:
        while True:
            if await request.is_disconnected():
                cancel.set()
                return
            await asyncio.sleep(0.2)

    watcher = asyncio.create_task(watch_disconnect())
    engine = str(CONFIG.get("tts", {}).get("engine", "qwen3")).lower()
    sample_rate = 16000
    try:
        if engine == "gptsovits":
            # 独立进程后端：不占桥接内的 Qwen handler，也不需要 infer_lock。
            # 原生采样率（通常 32 kHz）原样返回，不降到 16k，避免听感发闷。
            samples, sample_rate = await asyncio.to_thread(_synthesize_gptsovits, text, cancel)
        else:
            async with models.infer_lock:
                handler = await models.ensure_tts()
                samples = await asyncio.to_thread(_synthesize, handler, text, cancel)
    finally:
        watcher.cancel()

    if cancel.is_set():
        logger.info("TTS cancelled by client disconnect")
        # 499 是客户端断连，属于"用户主动打断"，不是故障。原实现抛 499 让前端
        # 的 fetch 直接 reject，插件把它当错误打红点；这里改成带着已合成部分
        # 正常返回，前端拿到的是合法 WAV，听感上是干净地停住而不是报错。
        if len(samples) > 0:
            wav = _pcm16_to_wav(samples, sample_rate)
            logger.info("TTS partial: %d chars -> %.2fs wav (%d bytes)", len(text), len(samples) / sample_rate, len(wav))
            return Response(content=wav, media_type="audio/wav", headers={"X-TTS-Cancelled": "1"})
        return Response(content=b"", media_type="audio/wav", headers={"X-TTS-Cancelled": "1"})
    wav = _pcm16_to_wav(samples, sample_rate)
    logger.info("TTS OK: %d chars -> %.2fs wav (%d bytes, %d Hz)", len(text), len(samples) / sample_rate, len(wav), sample_rate)
    return Response(content=wav, media_type="audio/wav")


def _synthesize(handler, text: str, cancel: threading.Event | None = None) -> np.ndarray:
    """Run TTS for one utterance, concatenating int16 chunks.

    Stops early between chunks when `cancel` is set (client disconnect).
    本地 Qwen3 handler，用固定的一份参考音频克隆音色。
    """
    from speech_to_speech.pipeline.messages import TTSInput

    chunks = []
    for chunk in handler.process(TTSInput(text=text, language_code="zh")):
        if cancel is not None and cancel.is_set():
            logger.info("TTS: cancelled mid-synthesis")
            break
        if isinstance(chunk, bytes):
            chunks.append(np.frombuffer(chunk, dtype=np.int16))
        else:
            chunks.append(np.asarray(chunk, dtype=np.int16))
    if not chunks:
        raise HTTPException(status_code=500, detail="TTS produced no audio")
    return np.concatenate(chunks)


def _pcm16_to_wav(samples: np.ndarray, sample_rate: int = 16000) -> bytes:
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(samples.astype("<i2").tobytes())
    return buf.getvalue()


# ── Companion media hosting (T8) ────────────────────────────────────────────

BG_IMAGES_DIR = Path(CONFIG["media"]["bg_images_dir"])
TASK_VIDEOS_DIR = Path(CONFIG["media"]["task_videos_dir"])
VIDEO_EXTS = {".mp4", ".webm", ".ogg", ".mov", ".m4v"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}

# ── 待机动画组预设（统一从 bg-images 下子文件夹读取，动态扫描）──────────────
# 约定：BG_IMAGES_DIR（bg-images）下的每个【子文件夹】= 一个待机动画组，
# 文件夹名即组名；bg-images 根目录直接放的文件 = 默认组 "default"。
# 新增待机组：在 bg-images 下新建子文件夹放视频/图片即可，**即时生效**——
# 每次查询都重新扫描（不需要重启桥接）。没有文件的组自动隐藏。
def _idle_groups() -> dict[str, Path]:
    groups: dict[str, Path] = {"default": BG_IMAGES_DIR}
    if BG_IMAGES_DIR.is_dir():
        for entry in sorted(BG_IMAGES_DIR.iterdir()):
            if entry.is_dir():
                groups[entry.name] = entry
    # 隐藏空组（default 根目录空也隐藏，避免切到空背景）
    return {name: path for name, path in groups.items() if _list_media(path)}


_current_idle: str = "default"


def _idle_dir() -> Path:
    return _idle_groups().get(_current_idle, BG_IMAGES_DIR)


def _list_media(directory: Path) -> list[dict]:
    if not directory.is_dir():
        return []
    entries = []
    for name in sorted(os.listdir(directory)):
        ext = Path(name).suffix.lower()
        if ext in VIDEO_EXTS:
            entries.append({"name": name, "type": "video"})
        elif ext in IMAGE_EXTS:
            entries.append({"name": name, "type": "image"})
    return entries


# 默认待机动画组：优先 bridge-config persona.default_idle（组存在时），
# 否则回退 "default"（bg-images 根目录）。须在 _idle_groups/_list_media
# 定义之后解析（模块级顺序）。
_PERSONA_CFG = CONFIG.get("persona", {})
_default_idle_cfg = str(_PERSONA_CFG.get("default_idle", "") or "")
_current_idle: str = _default_idle_cfg if _default_idle_cfg in _idle_groups() else "default"


@app.get("/api/media/bg-images")
async def media_bg_images() -> dict:
    """Idle/background media list (current idle group, name-sorted)."""
    return {"media": _list_media(_idle_dir())}


@app.get("/api/media/task-videos")
async def media_task_videos() -> dict:
    """Speaking-animation video list (videos only, name-sorted)."""
    return {
        "videos": [
            entry["name"]
            for entry in _list_media(TASK_VIDEOS_DIR)
            if entry["type"] == "video"
        ]
    }


# Static mounts (Range-capable) for the companion window's <video> sources.
# bg 用动态路由：文件从「当前待机组」目录读，切换组时 URL 不变、内容跟随。
if TASK_VIDEOS_DIR.is_dir():
    app.mount("/media/task-videos", StaticFiles(directory=str(TASK_VIDEOS_DIR)), name="media-task")


@app.get("/media/bg-images/{name:path}")
async def media_bg_file(name: str):
    from fastapi.responses import FileResponse

    base = _idle_dir()
    target = (base / name).resolve()
    # 防目录穿越：必须落在当前待机组目录内
    if not str(target).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="forbidden")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(target)


# ── 数字人 DUIX 集成 ────────────────────────────────────────────────────────
#
# 回复结束 → 插件调 /api/dh/speak {text} → 桥接用 Qwen3 TTS 整段合成 →
# 写入共享卷 temp（宿主 D:\duix_avatar_data\face2face\temp = 容器 /code/data/temp）
# → POST DUIX /easy/submit（audio_url=裸文件名, video_url=形象文件名）→
# 轮询 /easy/query 直到 success → 最终视频 <uuid>-r.mp4 落在宿主 temp 下，
# 容器已把 TTS 声音混入视频（ffmpeg -c:a aac），播放该 mp4 即音画同步。
#
# 约束：DUIX 单任务互斥（忙碌时 submit 返回 10001 busy）→ worker 串行处理；
# 排队期间来了新回复则丢弃未开始的任务，只保留最新一条（对话中只有最后的
# 回复值得生成视频）。query 查询成功/失败后任务即被服务端删除（一次性）。

DH_CFG = CONFIG.get("digital_human", {})
# ⚠️ 数字人运行时开关（2026-09-14 改）：DH_ENABLED 曾是启动时读配置的静态值，
# 且启动就无条件开 worker + 预热；插件端把数字人关掉（localStorage
# s2s.voice.digitalHuman=0）只让前端不再调 /api/dh/speak，桥接完全不知情——
# DUIX 没起时预热还会对着它连续重试提交（60 次 × 5s），就是「数字人关着、
# 桥接却一直敲 DUIX」的根因。
# 现在：_dh_enabled 运行时可热切（POST /api/dh/enable，并持久化回
# bridge-config.json）；关闭时 worker 空转、不预热、在途任务立即作废，桥接
# 不产生任何 DUIX 流量，TTS 朗读链完全不受影响。
# DH_ENABLED 仅表示「启动时的配置默认值」，运行时判断一律用 _dh_enabled()。
DH_ENABLED = bool(DH_CFG.get("enabled", False))
_dh_enabled: bool = DH_ENABLED


def _dh_enabled_now() -> bool:
    """当前数字人开关状态（运行时可热切，见 POST /api/dh/enable）。"""
    return _dh_enabled


def _persist_dh_enabled(enabled: bool) -> None:
    """把开关写回 bridge-config.json（写入失败只告警，不影响本次运行）。"""
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        raw.setdefault("digital_human", {})["enabled"] = bool(enabled)
        CONFIG_PATH.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        logger.info("DH switch persisted: digital_human.enabled=%s", enabled)
    except Exception:  # noqa: BLE001
        logger.exception("DH switch persist failed (runtime value still applied)")


DH_DUIX_BASE = DH_CFG.get("duix_base", "http://127.0.0.1:8383").rstrip("/")
DH_DATA_DIR = Path(DH_CFG.get("data_dir", "D:/duix_avatar_data/face2face"))
DH_TEMP_DIR = DH_DATA_DIR / DH_CFG.get("temp_dir", "temp")
# 生成产物子目录：数字人成品视频（<uuid>-r.mp4）统一放这里，与 temp 根目录的
# 形象素材 / 输入音频分开。形象文件（avatar*.mp4 / 自定义名.mp4）仍在 temp 根。
DH_OUTPUT_DIR = DH_TEMP_DIR / "output"
DH_AVATAR = DH_CFG.get("avatar_video", "")
DH_SUBMIT_RETRY_SEC = float(DH_CFG.get("submit_retry_sec", 5))
# 连续提交失败（DUIX 连不上）多少次后判死并回退 TTS：6 × 5s ≈ 30s 宽限，
# 够容器启动/预热用，又不会像以前那样闷头重试 15 分钟。
DH_SUBMIT_CONN_FAILS = int(DH_CFG.get("submit_conn_fails", 6))
DH_QUERY_INTERVAL = float(DH_CFG.get("query_interval_sec", 2))
DH_QUERY_TIMEOUT = float(DH_CFG.get("query_timeout_sec", 240))
DH_MAX_KEEP = int(DH_CFG.get("max_keep", 10))
# 每段音频的文本上限：~48 字 ≈ 8~10s 音频（用户实测 10s 视频十几秒出片）
DH_SEGMENT_CHARS = int(DH_CFG.get("segment_chars", 48))
DH_MAX_TEXT = 1000

# ── DUIX 容器生命周期（2026-09-14：关掉数字人 = 连容器一起停，把显存还回去）──
# 以前开关只管「桥接不再提交」，DUIX 容器仍常驻占着显存（模型十几 GB）。
# 现在关闭时顺手 docker stop 容器（release_gpu=true），打开时 docker start
# 并等它就绪（冷启动要加载模型，1-3 分钟）再预热。
DH_CONTAINER = str(DH_CFG.get("container_name", "duix-avatar-gen-video"))
DH_DOCKER_CLI = str(DH_CFG.get("docker_cli", "docker"))
DH_RELEASE_GPU = bool(DH_CFG.get("stop_container_on_disable", True))

# DUIX 容器/服务状态（status 里回给插件，卡片可以显示「容器启动中…」）
_dh_duix: dict = {"container": DH_CONTAINER, "state": "unknown", "message": "", "checked_at": 0.0}

# 可观测性：以前「任务到底提交了没有」无从查证（日志只在控制台窗口里）。
# 这些计数随 /api/dh/status 一起返回，前端/人工都能一眼确认。
_dh_stats: dict = {
    "submits": 0,           # /api/dh/speak 被成功受理的次数（插件真的提交了）
    "rejected": 0,          # 被拒次数（开关关着 / 空文本）
    "last_submit_at": 0.0,
    "last_reject": "",
    "segment_submits": 0,   # 真正提交给 DUIX 的段次数（分段逐批提交）
    "status_polls": 0,      # 状态轮询次数（证明前端在连着、在轮询）
    "last_poll_at": 0.0,
}


def _dh_duix_set(state: str, message: str = "") -> None:
    _dh_duix.update({"state": state, "message": message, "checked_at": time.time()})


def _dh_stat(key: str, delta: int = 1) -> None:
    _dh_stats[key] = int(_dh_stats.get(key, 0)) + delta


def _docker(args: list[str], timeout: float = 120.0) -> tuple[bool, str]:
    """在宿主上跑一条 docker 命令（Docker Desktop）。返回 (成功, 输出摘要)。"""
    try:
        proc = subprocess.run(
            [DH_DOCKER_CLI, *args],
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError:
        return False, f"docker CLI 不可用（{DH_DOCKER_CLI} 不在 PATH）"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"
    out = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    return proc.returncode == 0, out

# ── TTS 参考音色（固定一份，不再提供切换）────────────────────────────────
# 约定：VOICES_DIR（voices）下的每个【子文件夹】= 一份参考音色，文件夹名即
# 音色名，内容为 参考音频 + ref_text.txt。桥接只认 bridge-config 里
# persona.default_voice 指定的这一份（一般就是 "reference"），不再让插件切换：
# 合成走本机 GPT-SoVITS，参考音频是固定的。
VOICES_DIR = Path("D:/speech-to-speech/voices")
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}
TEXT_EXTS = {".txt", ".text"}


def _scan_voices() -> dict[str, dict]:
    """Scan the voices folder: every sub-folder is one reference voice."""
    voices: dict[str, dict] = {}
    if VOICES_DIR.is_dir():
        for entry in sorted(VOICES_DIR.iterdir()):
            if not entry.is_dir():
                continue
            name = entry.name
            audio = next((f for f in entry.iterdir() if f.suffix.lower() in AUDIO_EXTS), None)
            if audio is None:
                continue
            # 参考文本只认 ref_text.txt/.text（iterdir 无序，别匹配所有 .txt）。
            text = next((f for f in entry.iterdir() if f.name.lower() in ("ref_text.txt", "ref_text.text")), None)
            ref_text = text.read_text(encoding="utf-8", errors="ignore").strip() if text is not None else ""
            voices[name] = {
                "label": name,
                "engine": "qwen3",
                "ref_audio": str(audio),
                "ref_text": ref_text,
            }
    return voices


PERSONAS: dict[str, dict] = _scan_voices()
# 固定音色：bridge-config 的 persona.default_voice（一般就是 "reference"），
# 找不到就回退到扫描到的第一份。
_default_cfg = str(_PERSONA_CFG.get("default_voice", "") or "")
if _default_cfg in PERSONAS:
    _default_voice = _default_cfg
else:
    _default_voice = next(iter(PERSONAS), "")
_current_persona: str = _default_voice
# 运行时形象覆盖（POST /api/persona/set {avatar} 手动指定时设置；None = 默认
# 用配置 avatar_video 或 temp 下第一个可用形象）。音色与形象完全独立切换。
_avatar_override: str | None = None


def _persona_avatar() -> str:
    """当前数字人形象视频文件名（提交 DUIX 时用）。

    优先级：运行时覆盖 → 配置 avatar_video → temp 下第一个非产物/非备份的
    mp4（用户放的形象素材）。都不存在时返回空（调用方会报错提示放形象）。
    素材文件（avatar*.mp4 / 自定义名.mp4）由用户放入 temp，不随代码分发。
    """
    if _avatar_override is not None:
        return _avatar_override
    configured = DH_CFG.get("avatar_video", "")
    if configured and (DH_TEMP_DIR / configured).is_file():
        return configured
    if DH_TEMP_DIR.is_dir():
        for f in sorted(DH_TEMP_DIR.iterdir()):
            if not f.is_file() or f.suffix.lower() != ".mp4":
                continue
            if f.name.endswith("-r.mp4") or f.name.endswith(".bak.mp4"):
                continue
            return f.name
    return configured

# 生成的成品视频保留策略：磁盘上最多保留最近 max_keep 个 <uuid>-r.mp4，
# 超出删除最旧的（不碰形象素材 / 输入音频）。
# 内存里存一份最近完成任务的 {code,file,url,text,time} 供 /api/dh/history 回放。
_dh_history: list[dict] = []


def _dh_move_to_output(host_path: Path) -> str | None:
    """把 DUIX 产物（temp 根下的 -r.mp4）挪到 output 子目录；返回文件名或 None。"""
    if not host_path.is_file():
        return None
    try:
        DH_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        target = DH_OUTPUT_DIR / host_path.name
        if target.exists():
            target.unlink()
        host_path.replace(target)
        return target.name
    except Exception:  # noqa: BLE001
        logger.exception("DH move to output failed on %s", host_path)
        return host_path.name


def _dh_prune_videos() -> None:
    """把 output 子目录下的成品视频修剪到最近 max_keep 个（新的在前，删旧的）。"""
    if not DH_OUTPUT_DIR.is_dir():
        return
    files = sorted(
        (p for p in DH_OUTPUT_DIR.glob("*-r.mp4") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in files[DH_MAX_KEEP:]:
        try:
            old.unlink()
            logger.info("DH prune: deleted old result %s", old.name)
        except Exception:  # noqa: BLE001
            logger.exception("DH prune failed on %s", old)
    # 顺带清理 temp 根下的 DH 中间合成音频（*.wav）：DUIX 消费生成视频后
    # 这些 wav 就没用了。保留最近 DH_MAX_KEEP 个（流水线在途的 wav 最多
    # 个位数，200 个余量充足），删更旧的，防止长期运行无限累积。
    if DH_TEMP_DIR.is_dir():
        wavs = sorted(
            (p for p in DH_TEMP_DIR.glob("*.wav") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for old in wavs[DH_MAX_KEEP:]:
            try:
                old.unlink()
                logger.info("DH prune: deleted old temp wav %s", old.name)
            except Exception:  # noqa: BLE001
                logger.exception("DH prune wav failed on %s", old)


def _dh_record_history(code: str, video_file: str, text: str) -> None:
    """把刚完成的视频记入内存历史（新→旧，最多 max_keep 条）。"""
    with _dh_lock:
        _dh_history.insert(
            0,
            {
                "code": code,
                "video_file": video_file,
                "video_url": f"/media/dh/{video_file}",
                "text": text,
                "created_at": time.time(),
            },
        )
        del _dh_history[DH_MAX_KEEP:]

_dh_state: dict = {
    "enabled": DH_ENABLED,
    "state": "idle",       # idle | tts | generating | done | error | discarded
    "message": "",
    "progress": 0,
    "video_file": "",      # 最近一段成品文件名（temp 下）
    "video_url": "",       # 最近一段成品媒体 URL（桥接 /media/dh/<file>）
    "videos": [],          # 本回复已产出的小段视频列表 [{video_file, video_url}]
    "total_segments": 0,   # 本回复总段数
    "done_segments": 0,    # 已产出段数
    "code": "",            # 当前（或最近完成）任务的 code
    "text": "",            # 当前（或最近完成）任务的回复文本
    "pending": 0,          # 排队中（未开始）的任务数
    "updated_at": 0.0,
}
_dh_lock = threading.Lock()
_dh_queue: list[dict] = []  # {code, text, started}
_dh_discarded: set[str] = set()  # 已作废（打断/超时）的任务 code


def _dh_set(**kw) -> None:
    with _dh_lock:
        _dh_state.update(kw)
        _dh_state["updated_at"] = time.time()


def _dh_get() -> dict:
    with _dh_lock:
        state = dict(_dh_state)
        state["pending"] = sum(1 for t in _dh_queue if not t["started"])
        # 容器状态 + 计数（前端卡片显示「容器启动中…」，人工核对「提交了没有」）
        state["duix"] = dict(_dh_duix)
        state["stats"] = dict(_dh_stats)
        return state


def _dh_pop_next() -> dict | None:
    """取下一个未开始的任务；已处理的清理掉，未开始的只保留最新一条。"""
    with _dh_lock:
        _dh_queue[:] = [t for t in _dh_queue if not t["started"]]
        if not _dh_queue:
            return None
        _dh_queue[:] = _dh_queue[-1:]
        item = _dh_queue[0]
        item["started"] = True
        return item


def _dh_has_newer_pending() -> bool:
    """是否已有更新的回复在排队（段级抢占判断）。

    队列里只保留最新一条未开始任务（见 _dh_pop_next），所以存在未开始任务
    就意味着有更新的回复在等——当前任务应停止剩余段，把 DUIX 让给最新回复。
    """
    with _dh_lock:
        return any(not t["started"] for t in _dh_queue)


class DHSpeakRequest(BaseModel):
    text: str


@app.post("/api/dh/speak")
async def dh_speak(req: DHSpeakRequest) -> dict:
    """提交一段回复文本，生成数字人口播视频（后台排队，最新替换未开始任务）。"""
    if not _dh_enabled_now():
        _dh_stat("rejected")
        _dh_stats["last_reject"] = "数字人开关关闭（/api/dh/enable {enabled:true} 可打开）"
        raise HTTPException(status_code=400, detail="digital_human disabled (POST /api/dh/enable {enabled:true} to turn on)")
    text = (req.text or "").strip()
    if not text:
        _dh_stat("rejected")
        _dh_stats["last_reject"] = "空文本"
        raise HTTPException(status_code=400, detail="Empty text")
    if len(text) > DH_MAX_TEXT:
        logger.warning("DH text truncated from %d to %d chars", len(text), DH_MAX_TEXT)
        text = text[:DH_MAX_TEXT]
    code = str(uuid4())
    with _dh_lock:
        # 只保留正在运行的任务，未开始的旧排队任务被最新提交替换
        _dh_queue[:] = [t for t in _dh_queue if t["started"]]
        _dh_queue.append({"code": code, "text": text, "started": False})
        pending = sum(1 for t in _dh_queue if not t["started"])
    logger.info("DH enqueue: %s (%d chars), pending=%d", code, len(text), pending)
    _dh_stat("submits")
    _dh_stats["last_submit_at"] = time.time()
    return {"ok": True, "code": code}


class DHDiscardRequest(BaseModel):
    code: str


@app.post("/api/dh/discard")
async def dh_discard(req: DHDiscardRequest) -> dict:
    """作废一个已提交的数字人任务（用户打断/放弃该回复）：结果不再播放。"""
    code = (req.code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Empty code")
    with _dh_lock:
        _dh_discarded.add(code)
        # 若它还在排队，直接移除
        _dh_queue[:] = [t for t in _dh_queue if t.get("code") != code]
    logger.info("DH discard: %s", code)
    return {"ok": True}


@app.get("/api/dh/status")
async def dh_status() -> dict:
    """数字人任务状态：插件轮询；done 时带 video_url。"""
    _dh_stat("status_polls")
    _dh_stats["last_poll_at"] = time.time()
    return _dh_get()


class DHEnableRequest(BaseModel):
    enabled: bool


@app.post("/api/dh/enable")
async def dh_enable(req: DHEnableRequest) -> dict:
    """运行时开关数字人（热切换，无需重启桥接；并持久化到 bridge-config.json）。

    ON  ：起 worker、确保 DUIX 容器在跑（必要时 docker start + 等就绪）、预热
    OFF ：清空队列 + 在途任务全部作废、状态复位、worker 空转（零 DUIX 流量），
          并 docker stop 掉 DUIX 容器把显存还回去（release_gpu=true 时）
    这就是插件端数字人开关的桥接侧落点：关掉=桥接停手 + 容器也停。
    """
    global _dh_enabled
    enabled = bool(req.enabled)
    with _dh_lock:
        if enabled == _dh_enabled:
            return {"ok": True, "enabled": _dh_enabled, "changed": False}
        _dh_enabled = enabled
        if not enabled:
            # 在途 + 排队任务全部作废（结果不再播放、不再提交新段）
            for t in _dh_queue:
                _dh_discarded.add(t["code"])
            _dh_queue.clear()
            current = _dh_state.get("code") or ""
            if current:
                _dh_discarded.add(current)
    # 复位状态字段（两种方向都清干净，避免插件端读到上一轮的残留视频）
    _dh_set(
        enabled=enabled, state="idle", message="", progress=0,
        video_file="", video_url="", videos=[], total_segments=0,
        done_segments=0, code="", text="",
    )
    if enabled:
        DH_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        _dh_prune_videos()
        _dh_ensure_worker()
        # 0.1.3 级联动：先确保 DUIX 容器在跑（冷启动可能要 1-3 分钟），就绪后再预热
        asyncio.create_task(_dh_bring_up())
    elif DH_RELEASE_GPU:
        # 关掉数字人 = 连容器一起停，把显存还给别的服务（如 OmniVoice / LLM）
        asyncio.create_task(_dh_container_stop())
    else:
        _dh_duix_set("running", "容器保持运行（release_gpu=false）")
    _persist_dh_enabled(enabled)
    logger.info("DH runtime switch: %s (container stop=%s)", "ON" if enabled else "OFF", DH_RELEASE_GPU)
    return {"ok": True, "enabled": enabled, "changed": True, "duix": dict(_dh_duix)}


@app.get("/api/dh/history")
async def dh_history() -> dict:
    """最近保留的成品视频列表（新→旧，最多 max_keep 条），供回放/查看。"""
    videos = []
    with _dh_lock:
        for entry in _dh_history:
            videos.append(dict(entry))
    if not videos and DH_TEMP_DIR.is_dir():
        # 进程重启后从磁盘重建
        files = sorted(
            (p for p in DH_TEMP_DIR.glob("*-r.mp4") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:DH_MAX_KEEP]
        videos = [
            {
                "code": "",
                "video_file": p.name,
                "video_url": f"/media/dh/{p.name}",
                "text": "",
                "created_at": p.stat().st_mtime,
            }
            for p in files
        ]
    return {"videos": videos, "max_keep": DH_MAX_KEEP}


def _split_segments(text: str, max_len: int = 48) -> list[str]:
    """把文本按标点切成语义完整的段。

    规则：先按句末标点（。！？!?；;）切出完整句子，句子尽量不劈开——
    累积句子成段，若下一句放不下（超过 max_len）就收尾本段、下句开新段；
    只有单句本身超长（无标点）才硬切。时长是软参考，不刻意控制。
    """
    import re

    parts = re.split(r"(?<=[。！？!?；;])", text)
    sentences: list[str] = [p.strip() for p in parts if p.strip()]

    out: list[str] = []
    cur = ""

    def flush() -> None:
        nonlocal cur
        if cur.strip():
            out.append(cur.strip())
        cur = ""

    for sent in sentences:
        # 单句超长（无标点长句）：句内硬切，尽量在次级标点后切。
        while len(sent) > max_len:
            head = sent[:max_len]
            pos = max((head.rfind(c) for c in "，、：；:,. "), default=-1)
            cut = pos + 1 if pos > 0 else max_len
            piece = head[:cut].strip()
            if piece:
                flush() if cur else None
                out.append(piece)
            sent = sent[cut:].strip()
            if not sent:
                break
        # 句子完整累积：放不下就收尾本段（不拆句）。
        if cur and len(cur) + len(sent) > max_len:
            flush()
        cur += sent
    flush()
    return out


def _synthesize_full(handler, text: str) -> np.ndarray:
    """整段回复 TTS：超长文本分块合成后拼接为一条连续 int16 音频。"""
    from speech_to_speech.pipeline.messages import TTSInput

    chunks: list[np.ndarray] = []
    for part in _split_segments(text, 400):
        for chunk in handler.process(TTSInput(text=part, language_code="zh")):
            if isinstance(chunk, bytes):
                chunks.append(np.frombuffer(chunk, dtype=np.int16))
            else:
                chunks.append(np.asarray(chunk, dtype=np.int16))
    if not chunks:
        raise RuntimeError("DH TTS produced no audio")
    return np.concatenate(chunks)


async def _dh_submit(client: httpx.AsyncClient, payload: dict) -> dict:
    resp = await client.post(f"{DH_DUIX_BASE}/easy/submit", json=payload)
    resp.raise_for_status()
    return resp.json()


async def _dh_query(client: httpx.AsyncClient, code: str) -> dict | None:
    resp = await client.get(f"{DH_DUIX_BASE}/easy/query", params={"code": code})
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") == 10004:  # 任务不存在（可能刚提交或已被消费）
        return None
    return body.get("data") or {}


async def _dh_run(item: dict) -> None:
    """处理一个数字人回复：切成 <=10s 的小段 → 逐段 TTS + 提交 DUIX。

    流水线：当前段在 DUIX 生成期间，后台预合成下一段的 TTS 音频；DUIX
    一空闲立即提交下一段。各段成品视频按顺序收进 status.videos，插件端
    逐个续接播放（一段播完马上接下一段）。段太长时 DUIX 单任务排队。
    """
    code, text = item["code"], item["text"]
    segments = [s for s in _split_segments(text, DH_SEGMENT_CHARS) if s]
    if not segments:
        _dh_set(state="error", message="文本为空", code=code, text=text)
        return
    total = len(segments)
    try:
        _dh_set(
            state="tts", message="语音合成中…", code=code, text=text,
            video_file="", video_url="", videos=[], total_segments=total,
            done_segments=0, progress=0,
        )
        async with httpx.AsyncClient(timeout=20) as client:
            pending_synth: asyncio.Task | None = None
            for i, seg_text in enumerate(segments):
                if code in _dh_discarded:
                    _dh_set(state="discarded", message="已取消（被打断）", progress=0, code=code, text=text, videos=[])
                    logger.info("DH %s: discarded before segment %d", code, i)
                    return
                if _dh_has_newer_pending():
                    # 更新的回复已提交：停止本任务剩余段，把 DUIX 让给最新回复。
                    # 已生成的段视频保留在磁盘（存取不受影响）；新任务开始后
                    # （code 变化）companion 自动切到新任务的播放列表。
                    _dh_set(
                        state="discarded", message="被新回复取代",
                        progress=round(i / total * 100),
                        code=code, text=text, done_segments=i,
                    )
                    logger.info("DH %s: preempted by newer task at segment %d/%d", code, i, total)
                    return
                _dh_set(
                    state="generating",
                    message=f"数字人生成中 {i + 1}/{total}…",
                    code=code, text=text, done_segments=i,
                    progress=round(i / total * 100),
                )
                # 当前段音频：优先用流水线预合成好的；否则现合成
                if pending_synth is not None:
                    wav_path = await pending_synth
                    pending_synth = None
                else:
                    wav_path = await _dh_synth_segment(seg_text)
                # 预合成下一段（当前段在 DUIX 生成期间并行跑）
                next_synth: asyncio.Task | None = None
                if i + 1 < total:
                    next_synth = asyncio.create_task(_dh_synth_segment(segments[i + 1]))
                # 提交 + 轮询当前段，拿到成品文件名
                seg_code = f"{code}-s{i}"
                fname = await _dh_submit_and_wait(client, seg_code, wav_path, code, text)
                if fname is None:
                    if next_synth is not None:
                        next_synth.cancel()
                    if code in _dh_discarded:
                        _dh_set(state="discarded", message="已取消（被打断）", progress=0, code=code, text=text, videos=[])
                    return  # 错误/超时状态已由 _dh_submit_and_wait 设置
                with _dh_lock:
                    videos = _dh_state.get("videos", [])
                    videos = videos + [{"video_file": fname, "video_url": f"/media/dh/{fname}"}]
                    _dh_state["videos"] = videos
                _dh_record_history(seg_code, fname, seg_text)
                if next_synth is not None:
                    try:
                        await next_synth
                    except Exception:  # noqa: BLE001
                        logger.exception("DH %s: next synth failed", code)
                _dh_set(
                    state="generating",
                    message=f"数字人生成中 {i + 2}/{total}…",
                    code=code, text=text, done_segments=i + 1,
                    progress=round((i + 1) / total * 100),
                )
            # 全部段落完成
            with _dh_lock:
                videos = list(_dh_state.get("videos", []))
            first = videos[0] if videos else {}
            _dh_set(
                state="done", message="数字人视频已就绪", progress=100,
                video_file=first.get("video_file", ""),
                video_url=first.get("video_url", ""),
                code=code, text=text, total_segments=total, done_segments=total,
            )
            _dh_prune_videos()
            logger.info(
                "DH %s: done, %d segment(s): %s",
                code, total, [v["video_file"] for v in videos],
            )
    except Exception as exc:  # noqa: BLE001 - surfaced to the plugin
        logger.exception("DH %s: task failed", code)
        if code in _dh_discarded:
            _dh_set(state="discarded", message="已取消（被打断）", progress=0, code=code, text=text, videos=[])
        else:
            _dh_set(state="error", message=f"任务异常: {type(exc).__name__}", code=code, text=text)


async def _dh_synth_segment(seg_text: str) -> Path:
    """合成一小段音频到 temp 目录，返回宿主路径。"""
    async with models.infer_lock:
        handler = await models.ensure_tts()
        samples = await asyncio.to_thread(_synthesize_full, handler, seg_text)
    ts = datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3]
    wav_path = DH_TEMP_DIR / f"{ts}.wav"
    wav_path.write_bytes(_pcm16_to_wav(samples))
    logger.info("DH synth: %.2fs audio -> %s", len(samples) / 16000.0, wav_path.name)
    return wav_path


async def _dh_submit_and_wait(
    client: httpx.AsyncClient,
    seg_code: str,
    wav_path: Path,
    reply_code: str,
    reply_text: str,
) -> str | None:
    """提交一段到 DUIX 并轮询到成品视频；返回文件名，失败返回 None。

    状态已设置（error/超时）时返回 None，由调用方收尾。DUIX Status 是数字
    枚举：1=处理中（带进度 msg）、2=任务完成（带 result）、3=失败（推测）；
    同时兼容字符串 "s"/"e"/"r"/"success"/...。
    """
    payload = {
        "code": seg_code,
        "audio_url": wav_path.name,
        "video_url": _persona_avatar(),
        "watermark_switch": 0,
        "digital_auth": 0,
        "chaofen": 0,
        "pn": 1,
    }
    submitted = False
    submit_fails = 0
    max_fails = DH_SUBMIT_CONN_FAILS
    for _ in range(180):  # 最多等 15 分钟 busy 释放
        if not _dh_enabled_now():
            # 开关关掉：立刻停手，不再提交/占用 DUIX
            logger.info("DH %s: aborted (digital human switched off)", seg_code)
            return None
        try:
            resp = await _dh_submit(client, payload)
        except Exception as exc:  # noqa: BLE001
            # DUIX 不可达（容器没起/正在冷启动）：前几次静默重试，连续失败到
            # 阈值就判死回退 TTS。容器正在 starting/stopping 时给足宽限
            # （冷启动要加载模型 1-3 分钟），别把正常启动误判成故障。
            if _dh_duix.get("state") in ("starting", "stopping"):
                max_fails = max(DH_SUBMIT_CONN_FAILS, int(240 / max(DH_SUBMIT_RETRY_SEC, 1)))
            submit_fails += 1
            if submit_fails == 1:
                logger.warning(
                    "DH %s: DUIX unreachable at %s (%s) — retrying up to %d×",
                    seg_code, DH_DUIX_BASE, type(exc).__name__, max_fails,
                )
            if submit_fails >= max_fails:
                _dh_set(
                    state="error",
                    message=f"DUIX 不可达（{DH_DUIX_BASE} 未响应）",
                    code=reply_code, text=reply_text,
                )
                return None
            await asyncio.sleep(DH_SUBMIT_RETRY_SEC)
            continue
        submit_fails = 0
        if resp.get("code") == 10000:
            submitted = True
            _dh_stat("segment_submits")
            break
        if resp.get("code") == 10001:  # busy
            await asyncio.sleep(DH_SUBMIT_RETRY_SEC)
            continue
        _dh_set(state="error", message=f"提交失败: {resp.get('msg')}", code=reply_code, text=reply_text)
        return None
    if not submitted:
        _dh_set(state="error", message="提交超时（DUIX 持续忙碌）", code=reply_code, text=reply_text)
        return None

    deadline = time.time() + DH_QUERY_TIMEOUT
    while time.time() < deadline:
        if not _dh_enabled_now():
            logger.info("DH %s: polling aborted (digital human switched off)", seg_code)
            return None
        await asyncio.sleep(DH_QUERY_INTERVAL)
        q = await _dh_query(client, seg_code)
        if q is None:
            continue
        status = str(q.get("status"))
        if status in ("2", "success", "s", "done", "finished", "成功"):
            fname = str(q.get("result") or "").rsplit("/", 1)[-1]
            host = DH_TEMP_DIR / fname
            for _ in range(15):  # 等文件落盘（最多 15s）
                if host.is_file():
                    break
                await asyncio.sleep(1)
            moved = _dh_move_to_output(host)
            logger.info("DH %s: segment done -> %s", seg_code, moved or fname)
            return moved or fname
        if status in ("3", "error", "e", "failed", "失败"):
            _dh_set(state="error", message=f"生成失败: {q.get('msg')}", code=reply_code, text=reply_text)
            return None
        # 1 / run / 未知：生成中的中间状态绝不误判失败；带 result 时视为成功
        if status not in ("1", "run", "r", "running", "运行") and q.get("result"):
            fname = str(q.get("result")).rsplit("/", 1)[-1]
            if (DH_TEMP_DIR / fname).is_file():
                moved = _dh_move_to_output(DH_TEMP_DIR / fname)
                logger.info("DH %s: segment done (result field) -> %s", seg_code, moved or fname)
                return moved or fname
    _dh_set(state="error", message="生成超时", code=reply_code, text=reply_text)
    return None


async def _dh_worker() -> None:
    """后台队列 worker：串行消费 /api/dh/speak 提交的任务。

    完成后保留 done/error/discarded 状态（含 video_url），供插件取用；
    新任务开始时才清空旧结果（见 _dh_run 开头）。
    数字人开关关闭时空转（不消费队列、不碰 DUIX）——开关一关，桥接零 DUIX 流量。"""
    while True:
        if not _dh_enabled_now():
            await asyncio.sleep(1.0)
            continue
        item = _dh_pop_next()
        if item is None:
            await asyncio.sleep(1.0)
            continue
        try:
            await _dh_run(item)
        except Exception:  # noqa: BLE001
            logger.exception("DH worker crashed on %s", item.get("code"))
            _dh_set(state="error", message="worker 异常", code=item.get("code", ""), text=item.get("text", ""))


_dh_worker_task: "asyncio.Task | None" = None


def _dh_ensure_worker() -> None:
    """确保 worker 在跑（运行时可反复开关，重复调用安全）。"""
    global _dh_worker_task
    if _dh_worker_task is None or _dh_worker_task.done():
        _dh_worker_task = asyncio.create_task(_dh_worker())
        logger.info("DH worker started")


async def _dh_reachable(timeout: float = 3.0) -> bool:
    """DUIX 是否可达：GET /easy/query 探活（容器没起时立刻 False，不重试）。"""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{DH_DUIX_BASE}/easy/query", params={"code": "probe"})
            return resp.status_code < 500
    except Exception:  # noqa: BLE001
        return False


async def _dh_container_stop() -> None:
    """停掉 DUIX 容器，把显存真的还回去（关数字人 = 连 GPU 一起放）。"""
    _dh_duix_set("stopping", "正在停止 DUIX 容器…")
    ok, out = await asyncio.to_thread(_docker, ["stop", DH_CONTAINER], 180)
    if ok:
        _dh_duix_set("stopped", "DUIX 已停止，显存已释放")
        logger.info("DH container stopped (%s): %s", DH_CONTAINER, out)
    else:
        _dh_duix_set("unknown", f"停止容器失败: {out[:160]}")
        logger.warning("DH container stop failed: %s", out)


async def _dh_wait_duix_ready(timeout: float = 240.0) -> bool:
    """等 DUIX 真的能应答（冷启动要加载模型，可能 1-3 分钟）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _dh_enabled_now():
            return False
        if await _dh_reachable():
            return True
        await asyncio.sleep(3)
    return False


async def _dh_container_start() -> None:
    """启动 DUIX 容器并等它就绪；失败/超时只更新状态，不阻塞其它功能。"""
    _dh_duix_set("starting", "正在启动 DUIX 容器…")
    ok, out = await asyncio.to_thread(_docker, ["start", DH_CONTAINER], 120)
    if not ok:
        _dh_duix_set("unavailable", f"启动容器失败: {out[:160]}")
        logger.warning("DH container start failed: %s", out)
        return
    logger.info("DH container starting (%s)…", DH_CONTAINER)
    if await _dh_wait_duix_ready():
        _dh_duix_set("running", "DUIX 就绪")
        logger.info("DH container ready at %s", DH_DUIX_BASE)
    else:
        _dh_duix_set("unavailable", "DUIX 容器未在超时内就绪")
        logger.warning("DH container did not become ready in time")


async def _dh_bring_up() -> None:
    """打开数字人：确保容器在跑 → 真正就绪后再预热。"""
    if not _dh_enabled_now():
        return
    if await _dh_reachable():
        _dh_duix_set("running", "DUIX 就绪")
    else:
        await _dh_container_start()
    if _dh_enabled_now() and _dh_duix.get("state") == "running":
        await _dh_warmup()


@app.on_event("startup")
async def _dh_start_worker() -> None:
    if _dh_enabled_now():
        _dh_prune_videos()  # 启动时把成品视频修剪到最近 max_keep 个
        _dh_ensure_worker()
        # 预热前先确保容器在跑（DUIX 不可达时预热会直接跳过，不再空转重试）；
        # 预热让 wenet 特征提取 / init_wh / 模型加载 / TRT engine 走一遍热路径，
        # 首条真实回复的等待时间显著缩短。预热独立于 _dh_queue，结果直接丢弃。
        asyncio.create_task(_dh_bring_up())
        logger.info("DH worker started (DUIX %s, container=%s, temp=%s, avatar=%s, max_keep=%d)", DH_DUIX_BASE, DH_CONTAINER, DH_TEMP_DIR, DH_AVATAR, DH_MAX_KEEP)
    else:
        logger.info("DH disabled — no worker, no warmup, zero DUIX traffic")


async def _dh_warmup() -> None:
    """后台预热：跑一次完整的「TTS → 特征 → init_wh → 生成」链路。

    预热输出是「数字人没有说话」的占位短句（或仅预合成音频 + 提交），
    完成即删，不进入播放列表、不污染 max_keep 历史。
    DUIX 不可达时直接跳过（旧版会在这里对着空气重试 60×5s，是「关着数字人
    还一直敲 DUIX」的元凶之一）。"""
    try:
        if not _dh_enabled_now():
            return
        if not await _dh_reachable():
            logger.info("DH warmup skipped: DUIX unreachable at %s", DH_DUIX_BASE)
            return
        logger.info("DH warmup: synthesizing warmup audio…")
        wav = await _dh_synth_segment("数字人系统预热完成")
        code = f"warmup-{uuid4()}"
        payload = {
            "code": code,
            "audio_url": wav.name,
            "video_url": _persona_avatar(),
            "watermark_switch": 0,
            "digital_auth": 0,
            "chaofen": 0,
            "pn": 1,
        }
        async with httpx.AsyncClient(timeout=20) as client:
            # 预热不写 _dh_state：直接提交 + 轮询，完成即删，失败静默。
            warm_fails = 0
            for _ in range(60):  # 最多等 5 分钟 busy 释放
                if not _dh_enabled_now():
                    logger.info("DH warmup: aborted (switched off)")
                    wav.unlink(missing_ok=True)
                    return
                try:
                    resp = await _dh_submit(client, payload)
                except Exception:  # noqa: BLE001
                    # DUIX 掉线：连续失败到阈值就放弃预热（旧版在这里闷头重试
                    # 5 分钟，每次都是一条到 :9000 的连接尝试 → 日志/连接刷屏）
                    warm_fails += 1
                    if warm_fails >= DH_SUBMIT_CONN_FAILS:
                        logger.warning("DH warmup: DUIX unreachable, skipping warmup")
                        wav.unlink(missing_ok=True)
                        return
                    await asyncio.sleep(DH_SUBMIT_RETRY_SEC)
                    continue
                warm_fails = 0
                if resp.get("code") == 10000:
                    break
                if resp.get("code") == 10001:  # busy（真实任务在跑，跳过预热）
                    logger.info("DH warmup: DUIX busy, skipping warmup")
                    wav.unlink(missing_ok=True)
                    return
                await asyncio.sleep(DH_SUBMIT_RETRY_SEC)
            else:
                logger.warning("DH warmup: DUIX busy too long, skipping")
                wav.unlink(missing_ok=True)
                return
            deadline = time.time() + 120
            fname = ""
            while time.time() < deadline:
                await asyncio.sleep(DH_QUERY_INTERVAL)
                q = await _dh_query(client, code)
                if q is None:
                    continue
                status = str(q.get("status"))
                if status in ("2", "success", "s", "done", "finished", "成功"):
                    fname = str(q.get("result") or "").rsplit("/", 1)[-1]
                    break
            host = DH_TEMP_DIR / fname if fname else None
            if host is not None:
                # 挪到 output 子目录再删（保持 temp 根只有形象素材）
                moved = _dh_move_to_output(host)
                if moved is not None:
                    (DH_OUTPUT_DIR / moved).unlink(missing_ok=True)
            wav.unlink(missing_ok=True)
            logger.info("DH warmup: done (prewarmed TTS/wenet/DUIX)%s", f" {fname} cleaned" if fname else "")
    except Exception:  # noqa: BLE001
        logger.exception("DH warmup failed (non-fatal)")


# 结果视频静态挂载：插件 video 元素直接播 /media/dh/<uuid>-r.mp4（Range 支持）。
# 产物统一在 output 子目录（与形象素材分离）。
# 注意：不按 DH_ENABLED 门控 —— 开关现在是运行时可切的，若这里跳过挂载，
# 之后再把数字人打开时 /media/dh 会 404（视频生成了却播不出来）。
if DH_TEMP_DIR.is_dir():
    DH_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/media/dh", StaticFiles(directory=str(DH_OUTPUT_DIR)), name="media-dh")


# ── 人设/预设切换（数字人形象 + 待机动画，两类独立）───────────────────────
#
# GET  /api/persona/list  → 两类预设列表 + 当前选择
# POST /api/persona/set   → 可选字段 {avatar?, idle?} 分别切换
#    avatar : 数字人形象视频文件名（后续 /api/dh/* 提交用新形象）
#    idle   : 待机动画组名（/api/media/bg-images 与静态文件动态跟随）
# 音色是固定的（bridge-config persona.default_voice），不再提供切换。


class PersonaSetRequest(BaseModel):
    avatar: str | None = None
    idle: str | None = None


@app.get("/api/persona/list")
async def persona_list() -> dict:
    # 形象：扫描 temp 目录下的 mp4 形象文件（任意命名，排除生成产物 -r.mp4
    # 与备份 .bak.mp4）。名字即文件名（去扩展名）。
    avatar_files = []
    if DH_TEMP_DIR.is_dir():
        for f in sorted(DH_TEMP_DIR.iterdir()):
            if not f.is_file() or f.suffix.lower() != ".mp4":
                continue
            if f.name.endswith("-r.mp4") or f.name.endswith(".bak.mp4"):
                continue  # 跳过生成产物与备份
            avatar_files.append({
                "name": f.name,
                "label": f.stem,
                "current": f.name == _persona_avatar(),
            })
    idles = [{"name": n, "label": n, "current": n == _current_idle} for n in _idle_groups()]
    return {
        "avatars": avatar_files,
        "idles": idles,
        "current": {
            "avatar": _persona_avatar(),
            "idle": _current_idle,
        },
    }


@app.post("/api/persona/set")
async def persona_set(req: PersonaSetRequest) -> dict:
    global _current_idle, _avatar_override
    result: dict = {"ok": True}

    # 形象切换
    if req.avatar is not None:
        av = req.avatar.strip()
        if not (DH_TEMP_DIR / av).is_file():
            raise HTTPException(status_code=404, detail=f"Avatar file not found: {av}")
        _avatar_override = av
        result["avatar"] = av
        logger.info("avatar switched to %s", av)

    # 待机动画切换
    if req.idle is not None:
        name = req.idle.strip()
        if name not in _idle_groups():
            raise HTTPException(status_code=404, detail=f"Unknown idle group: {name}")
        _current_idle = name
        result["idle"] = name
        logger.info("idle switched to %s", name)

    if not result.get("avatar") and not result.get("idle"):
        raise HTTPException(status_code=400, detail="Nothing to set")
    return result


# ── DeepSeek 余额（低开销：10 分钟内存缓存，挂载/点击才查）────────────────────
#
# 调官方 GET https://api.deepseek.com/user/balance（Bearer 鉴权），返回
# CNY/USD 总余额 + 赠金 + 充值。key 来源：bridge-config.json 的
# deepseek.api_key 优先，否则环境变量 DEEPSEEK_API_KEY。缓存期内重复请求
# 不再打官方接口，日常零轮询、零开销。

_balance_cache: dict = {"data": None, "at": 0.0}
BALANCE_CACHE_SEC = 600


@app.get("/api/balance")
async def api_balance() -> dict:
    now = time.time()
    if _balance_cache["data"] is not None and now - _balance_cache["at"] < BALANCE_CACHE_SEC:
        cached = dict(_balance_cache["data"])
        cached["cached"] = True
        return cached
    key = (CONFIG.get("deepseek") or {}).get("api_key") or os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="DEEPSEEK_API_KEY not configured (bridge-config deepseek.api_key or env)")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://api.deepseek.com/user/balance",
                headers={"Authorization": f"Bearer {key}"},
            )
            resp.raise_for_status()
            body = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("balance query failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"DeepSeek balance query failed: {exc}") from exc
    result = {
        "is_available": body.get("is_available"),
        "balance_infos": body.get("balance_infos", []),
        "cached": False,
        "at": now,
    }
    _balance_cache["data"] = result
    _balance_cache["at"] = now
    return result


# ── 电脑摄像头取帧（让模型看见画面）──────────────────────────────────────
#
# 浏览器那套 getUserMedia 在 DSH 桌面端里不弹权限框、直接失败，所以画面改由
# 桥接自己开摄像头：OpenCV 打开设备，编成 JPEG 回给插件，插件再把这一帧作为
# 图片块送进会话。整条链路上没有任何浏览器权限请求。
#
# 配置（bridge-config.json）：
#   "camera": {
#     "enabled": true,
#     "device_index": 0,
#     "max_side": 640,
#     "quality": 60
#   }
#
# 设备在第一次取帧时打开并保持打开（避免每帧都重新初始化）；插件把摄像头开关
# 关掉时会 POST /api/camera/release 把设备还回去，摄像头的指示灯随之熄灭。

# 设备由一条常驻读帧线程持有：它按摄像头自己的帧率不停 grab，把最新一帧放在
# 变量里。HTTP 请求只做「取最新一帧 + 缩放 + JPEG 编码」，因此 10 fps 也毫不吃
# 力（直接 cap.read() 的话每帧要一百多毫秒，MSMF 后端的读延迟太高）。
# 插件把摄像头开关关掉时会 POST /api/camera/release 停线程、还设备，灯随之灭。

_camera_lock = threading.Lock()
_camera_latest = None            # 最新原始帧（BGR）
_camera_latest_at = 0.0
_camera_thread: threading.Thread | None = None
_camera_stop = threading.Event()
_camera_error: str | None = None
_camera_last_request = 0.0       # 最近一次取帧时间（无人取帧就自动关设备）
_camera_device_fps = 0.0         # 摄像头自己的帧率（0 = 设备没报）

# 32×24 的灰度指纹：每一帧都带一份，插件拿它判断画面有没有变。
# 指纹在服务端算（这里已经有原始帧），客户端只要比对 768 个字节，不用解码 JPEG。
CAMERA_FINGERPRINT_W = 32
CAMERA_FINGERPRINT_H = 24


def _camera_fingerprint(image) -> bytes:
    """32×24 灰度指纹（768 字节），用来算两帧之间的画面差异。"""
    import cv2

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (CAMERA_FINGERPRINT_W, CAMERA_FINGERPRINT_H), interpolation=cv2.INTER_AREA)
    return small.tobytes()


# 64×36 的 HSV 网格（6912 字节）：画面"变化分"的输入。
#
# 口径抄自 dsh-see-now（SAOS-3624，Apache-2.0）的 cuts.js：把画面降到 64×36 网格，
# 转成 HSV，再按"色相环形差 + 饱和度降权 + 明度差"加权，算出 0–255 的变化分。
# 插件据此判断"这一帧值不值得留下来拼进那张图"——静着的房间一分都不给。
#
# OpenCV 的 H 是 0–179（对应 0–360°），这里换算成 0–255（同样对应 0–360°），
# 与 see-now 的 rgbToHsv 一致；S、V 两通道两边的定义本来就一样。
CAMERA_GRID_W = 64
CAMERA_GRID_H = 36


def _camera_hsv_grid(image) -> bytes:
    """64×36 HSV 网格（6912 字节）：变化分的原料。"""
    import cv2
    import numpy as np

    small = cv2.resize(image, (CAMERA_GRID_W, CAMERA_GRID_H), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hsv[:, :, 0] = np.clip(hsv[:, :, 0].astype(np.float32) * (255.0 / 180.0), 0, 255).astype(np.uint8)
    return hsv.tobytes()


def _camera_latest_image(cfg: dict):
    """取摄像头的最新一帧原始画面（不缩放、不编 JPEG）。"""
    _ensure_camera_reader(cfg)
    deadline = time.time() + 3.0
    while True:
        with _camera_lock:
            image = _camera_latest
            at = _camera_latest_at
            error = _camera_error
        if image is not None and time.time() - at < 2.0:
            return image, at
        if error is not None:
            raise RuntimeError(error)
        if time.time() > deadline:
            raise RuntimeError("摄像头没有出图：设备可能刚被别的程序占用")
        time.sleep(0.01)

# 插件关掉摄像头会主动调 release；但如果它崩了没来得及调，读帧线程在这么久
# 没有请求之后就自己退出，把摄像头还给系统（省得指示灯一直亮着）。
CAMERA_IDLE_SEC = 60.0


def _camera_crop(cfg: dict, image):
    """按配置裁一块画面（归一化坐标），给"只看某个东西"的场景用。

    bridge-config.json：
      "camera": { "roi": { "x": 0.25, "y": 0.55, "w": 0.5, "h": 0.45 } }

    为什么要裁：变化分是**全幅平均**，画面里一个小目标动一下会被整幅稀释掉。
    把画面裁到那个目标上，它占满整幅，任何动作都会变成大分。
    裁剪发生在取帧之后、缩放之前，后面的 JPEG、指纹、网格都是按裁好的画面算的 ——
    所见即所测，模型看到的也是这块放大后的区域。
    """
    roi = cfg.get("roi")
    if not roi:
        return image
    if isinstance(roi, dict):
        x = float(roi.get("x", 0.0))
        y = float(roi.get("y", 0.0))
        w = float(roi.get("w", 1.0))
        h = float(roi.get("h", 1.0))
    elif isinstance(roi, (list, tuple)) and len(roi) == 4:
        x, y, w, h = (float(v) for v in roi)
    else:
        return image
    height, width = image.shape[:2]
    x0 = max(0, min(width - 2, int(round(x * width))))
    y0 = max(0, min(height - 2, int(round(y * height))))
    x1 = max(x0 + 2, min(width, int(round((x + w) * width))))
    y1 = max(y0 + 2, min(height, int(round((y + h) * height))))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return image
    return image[y0:y1, x0:x1]



def _camera_worker(index: int) -> None:
    """Keep the device open and continuously grab the newest frame."""
    import cv2

    global _camera_latest, _camera_latest_at, _camera_error, _camera_thread, _camera_device_fps

    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        try:
            cap.release()
        except Exception:  # noqa: BLE001
            pass
        with _camera_lock:
            _camera_error = f"打不开摄像头 {index}：没有这个设备，或被别的程序独占"
            _camera_thread = None
        return
    device_fps = 0.0
    try:
        raw_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        if 0.0 < raw_fps < 1000.0:
            device_fps = raw_fps
    except Exception:  # noqa: BLE001 - 有些后端不报帧率
        device_fps = 0.0
    with _camera_lock:
        _camera_error = None
        _camera_device_fps = device_fps
    logger.info("camera %s opened at %.1f fps", index, device_fps)
    try:
        while not _camera_stop.is_set():
            ok, image = cap.read()
            if ok and image is not None:
                with _camera_lock:
                    _camera_latest = image
                    _camera_latest_at = time.time()
            else:
                time.sleep(0.01)
            if time.time() - _camera_last_request > CAMERA_IDLE_SEC:
                logger.info("camera reader idle for %.0fs, releasing the device", CAMERA_IDLE_SEC)
                break
    finally:
        try:
            cap.release()
        except Exception:  # noqa: BLE001
            pass
        with _camera_lock:
            _camera_latest = None
            _camera_latest_at = 0.0
            if _camera_thread is threading.current_thread():
                _camera_thread = None


def _ensure_camera_reader(cfg: dict) -> None:
    """Start the reader thread on first use (idempotent)."""
    global _camera_thread

    with _camera_lock:
        if _camera_thread is not None and _camera_thread.is_alive():
            return
        _camera_stop.clear()
        index = int(cfg.get("device_index") or 0)
        _camera_thread = threading.Thread(
            target=_camera_worker, args=(index,), name="camera-reader", daemon=True
        )
        _camera_thread.start()


def _stop_camera_reader() -> None:
    """Stop the reader thread and give the device back to the system."""
    global _camera_thread, _camera_latest, _camera_latest_at

    with _camera_lock:
        thread = _camera_thread
        _camera_thread = None
    if thread is None:
        return
    _camera_stop.set()
    thread.join(timeout=2.0)
    with _camera_lock:
        _camera_latest = None
        _camera_latest_at = 0.0


def _camera_frame_jpeg(cfg: dict, want_grid: bool = False) -> tuple[bytes, int, int, bytes, float, bytes | None]:
    """Encode the newest frame from the camera as JPEG (+ fingerprint [+ HSV grid])."""
    import cv2

    _ensure_camera_reader(cfg)
    deadline = time.time() + 3.0
    image = None
    while image is None:
        with _camera_lock:
            image = _camera_latest
            at = _camera_latest_at
            error = _camera_error
        if image is not None and time.time() - at < 2.0:
            break
        image = None
        if error is not None:
            raise RuntimeError(error)
        if time.time() > deadline:
            raise RuntimeError("摄像头没有出图：设备可能刚被别的程序占用")
        time.sleep(0.01)

    max_side = int(cfg.get("max_side") or 640)
    # 先裁，再缩放：ROI 之后画面里只剩要看的那个东西。
    image = _camera_crop(cfg, image)
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > max_side:
        scale = max_side / float(longest)
        image = cv2.resize(image, (max(int(width * scale), 2), max(int(height * scale), 2)))
        height, width = image.shape[:2]
    quality = int(cfg.get("quality") or 60)
    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("jpeg 编码失败")
    # 指纹跟 JPEG 用的是同一张图（缩放之后），所见即所测。
    fingerprint = _camera_fingerprint(image)
    # 网格同理：跟这张 JPEG 同源，插件拿它算"画面变了多少"。
    grid = _camera_hsv_grid(image) if want_grid else None
    with _camera_lock:
        device_fps = _camera_device_fps
    return buffer.tobytes(), width, height, fingerprint, device_fps, grid


@app.get("/api/camera/frame")
async def api_camera_frame(grid: int = 0) -> dict:
    """One JPEG frame from the computer's webcam (base64, no data: prefix).

    `?grid=1` 时额外返回这一帧的 64×36 HSV 网格（画面变化分的原料）。
    """
    import base64

    global _camera_last_request

    cfg = CONFIG.get("camera", {}) or {}
    _camera_last_request = time.time()
    if not cfg.get("enabled", True):
        raise HTTPException(status_code=503, detail="camera disabled in bridge-config.json")
    try:
        data, width, height, fingerprint, device_fps, grid_bytes = await asyncio.to_thread(
            _camera_frame_jpeg, cfg, bool(grid)
        )
    except Exception as exc:  # noqa: BLE001 - surfaced to the plugin
        logger.warning("camera frame failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"摄像头取帧失败：{exc}") from exc
    payload = {
        "data": base64.b64encode(data).decode("ascii"),
        "mediaType": "image/jpeg",
        "width": width,
        "height": height,
        "fingerprint": base64.b64encode(fingerprint).decode("ascii"),
        "deviceFps": device_fps,
    }
    if grid_bytes is not None:
        payload["grid"] = base64.b64encode(grid_bytes).decode("ascii")
        payload["gridWidth"] = CAMERA_GRID_W
        payload["gridHeight"] = CAMERA_GRID_H
    return payload


@app.get("/api/camera/grid")
async def api_camera_grid() -> dict:
    """只回一帧的 64×36 HSV 网格（不编 JPEG），给前端的"画面变化分"用。

    比 /api/camera/frame 轻得多：一次 resize + 一次转 HSV，没有 JPEG 编码，
    响应体约 9 KB。前端按 12 fps 拉这个，和 30 fps 的预览取帧互不干扰。
    """
    import base64

    global _camera_last_request

    cfg = CONFIG.get("camera", {}) or {}
    _camera_last_request = time.time()
    if not cfg.get("enabled", True):
        raise HTTPException(status_code=503, detail="camera disabled in bridge-config.json")
    try:
        image, at = await asyncio.to_thread(_camera_latest_image, cfg)
        image = _camera_crop(cfg, image)
        grid = await asyncio.to_thread(_camera_hsv_grid, image)
    except Exception as exc:  # noqa: BLE001 - surfaced to the plugin
        logger.warning("camera grid failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"摄像头取帧失败：{exc}") from exc
    return {
        "grid": base64.b64encode(grid).decode("ascii"),
        "width": CAMERA_GRID_W,
        "height": CAMERA_GRID_H,
        "at": at,
    }


@app.post("/api/camera/release")
async def api_camera_release() -> dict:
    """Give the webcam back to the system (the camera switch was turned off)."""
    await asyncio.to_thread(_stop_camera_reader)
    return {"ok": True}


# ── Silero VAD endpoint (barge-in detection) ──────────────────────────────
#
# The original speech-to-speech project runs VAD on the SERVER with silero-vad,
# a neural network trained to tell a real human voice apart from noise / music /
# TTS echo. Our browser-side RMS threshold cannot do that, which is why ambient
# sounds kept tripping the barge-in and got STT'd into phantom messages.
#
# /api/vad is a WebSocket: while a reply is playing the client streams its mic
# PCM16 chunks here; the server runs them through silero VAD (loaded from the
# local <repo>/models/silero-vad/ directory, NOT the torch hub cache) and
# replies {"event":"speech_start"} only when a real voice is heard — the
# client then interrupts the reply. Chunks are never stored.

class VADSession:
    """One silero VAD session per WebSocket connection.

    Loads silero_vad_v4.jit (stable, no annotator) from <repo>/models/, falling
    back to silero_vad.jit if the v4 file is absent. State (h/c) lives in the
    jit model instance, so each session gets a fresh detector.
    """

    def __init__(self) -> None:
        import torch
        from speech_to_speech.VAD.vad_iterator import VADIterator

        models_dir = HERE / "models" / "silero-vad"
        model_path = models_dir / "silero_vad_v4.jit"
        if not model_path.is_file():
            model_path = models_dir / "silero_vad.jit"
        if not model_path.is_file():
            raise RuntimeError(f"silero-vad model not found under {models_dir}")

        self.model = torch.jit.load(str(model_path), map_location="cpu")
        self.model.eval()
        self.iterator = VADIterator(
            self.model,
            threshold=0.6,
            sampling_rate=16000,
            min_silence_duration_ms=64,
            speech_pad_ms=30,
        )
        self.min_speech_ms = 384
        self.speech_started = False
        # Byte buffer: client chunks (any size) accumulate until a full
        # 512-sample window is available — silero gets CONTINUOUS audio, never
        # zero-padded frames (padding between real audio breaks VAD state).
        self._buf = b""

    def feed(self, pcm16: bytes) -> list[dict]:
        """Feed one 16 kHz PCM16 chunk (any size); returns outbound JSON events.

        Silero VAD requires fixed 512-sample windows at 16 kHz; chunks are
        buffered and cut into 512-sample frames so the audio stream stays
        contiguous. A barge-in fires once sustained speech reaches
        min_speech_ms (384ms) — the same confirmation the original project
        applies. VADAudio outputs (final utterances) are intentionally ignored
        here — this endpoint only signals barge-in timing; the client keeps
        its own capture for STT.
        """
        import numpy as np
        import torch

        self._buf += pcm16
        out: list[dict] = []
        while len(self._buf) >= 1024:  # 512 int16 samples = 1024 bytes
            window = self._buf[:1024]
            self._buf = self._buf[1024:]
            x = np.frombuffer(window, dtype=np.int16).astype(np.float32) / 32768.0
            utterance = self.iterator(torch.from_numpy(x))
            if self.iterator.triggered and not self.speech_started:
                active_ms = self.iterator.active_speech_samples / 16.0
                if active_ms >= self.min_speech_ms:
                    self.speech_started = True
                    out.append({"event": "speech_start"})
            if utterance is not None:
                self.speech_started = False
                out.append({"event": "speech_end"})
        return out


@app.websocket("/api/vad")
async def vad_endpoint(ws: WebSocket) -> None:
    """Streaming barge-in VAD. Client pushes raw 16 kHz mono PCM16 (any chunk
    size, ~40ms typical); server replies speech_start/speech_end JSON when
    silero VAD hears human speech."""
    await ws.accept()
    session = VADSession()
    try:
        while True:
            data = await ws.receive_bytes()
            if not data:
                continue
            for msg in session.feed(data):
                await ws.send_json(msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("VAD websocket error")
        try:
            await ws.close()
        except Exception:
            pass


# ── 视觉 / 视频理解（MiniMax）────────────────────────────────────────────
#
# DSH 的会话层只认图片块（dsh-llm 的 modalities 就是 text|image，pi-ai 里
# 没有 video_url 这一说），所以真正的「视频理解」放在桥接这一侧：
# 浏览器录一小段 → 这里转成 MP4 → 用 MiniMax 的 video_url 提交 → 把模型的
# 描述以文本回传，插件再把这段描述送进会话。
#
# 配置（bridge-config.json）：
#   "vision": {
#     "enabled": true,
#     "api_key": "MiniMax API key（不填则读环境变量 MINIMAX_API_KEY）",
#     "base_url": "https://api.minimaxi.com/v1",
#     "model": "MiniMax-M3.1-Flash",
#     "fps": 1.0,
#     "timeout_sec": 120,
#     "ffmpeg": "E:/tts/ffmpeg-.../bin/ffmpeg.exe"
#   }


class VisionRequest(BaseModel):
    """One vision request: a local file, a still picture and/or a short clip."""

    #: Local file path (image or video). This is the "give the model a path"
    #: route: the file stays on disk, the bridge reads and describes it.
    path: str | None = None
    video_base64: str | None = None
    image_base64: str | None = None
    mime: str = "video/mp4"
    prompt: str = "简短描述画面里正在发生什么"
    fps: float | None = None
    detail: str | None = None


def _vision_config() -> dict:
    return CONFIG.get("vision", {}) or {}


def _dsh_credential(name: str) -> str:
    """Read an env-style credential that DSH keeps in its credential store.

    DSH resolves `apiKeyEnv: MINIMAX0_API_KEY` from ~/.dsh/.credentials.yaml
    (refs section). The bridge runs outside DSH's process, so it reads the same
    file to find the same key instead of asking the user to paste it twice.
    """
    path = Path.home() / ".dsh" / ".credentials.yaml"
    try:
        if not path.exists():
            return ""
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            stripped = line.strip()
            if stripped.startswith(f"{name}:"):
                return stripped.split(":", 1)[1].strip().strip("'\"")
    except Exception:  # noqa: BLE001
        logger.warning("credential lookup failed for %s", name)
    return ""


def _vision_api_key(cfg: dict) -> str:
    """Resolve the MiniMax key: config first, then env, then DSH's store."""
    return (
        cfg.get("api_key")
        or os.environ.get("MINIMAX_API_KEY", "")
        or os.environ.get("MINIMAX0_API_KEY", "")
        or _dsh_credential("MINIMAX0_API_KEY")
    )


def _ffmpeg_path(cfg: dict) -> str | None:
    """Locate ffmpeg: explicit config first, then PATH."""
    import shutil

    candidate = cfg.get("ffmpeg")
    if candidate and Path(candidate).exists():
        return candidate
    return shutil.which("ffmpeg")


def _to_mp4(data: bytes, cfg: dict) -> bytes:
    """Convert a browser recording (WebM/MKV) into MP4.

    MiniMax accepts MP4/AVI/MOV/MKV for video parts; the browser's MediaRecorder
    usually speaks WebM, which is not on that list.
    """
    import shutil
    import tempfile

    exe = _ffmpeg_path(cfg)
    if exe is None:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg not found (set vision.ffmpeg in bridge-config.json)",
        )
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.webm"
        dst = Path(tmp) / "out.mp4"
        src.write_bytes(data)
        proc = subprocess.run(
            [
                exe, "-y", "-i", str(src),
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", str(dst),
            ],
            capture_output=True,
        )
        if proc.returncode != 0 or not dst.exists():
            tail = proc.stderr.decode("utf-8", "ignore")[-400:]
            raise HTTPException(status_code=502, detail=f"ffmpeg conversion failed: {tail}")
        return dst.read_bytes()


@app.post("/api/vision")
async def api_vision(req: VisionRequest) -> dict:
    """Ask a video-capable model to describe a picture or a short clip."""
    import base64

    cfg = _vision_config()
    key = _vision_api_key(cfg)
    if not key:
        raise HTTPException(
            status_code=503,
            detail="MiniMax API key not configured (bridge-config vision.api_key or env MINIMAX_API_KEY)",
        )
    base_url = (cfg.get("base_url") or "https://api.minimaxi.com/v1").rstrip("/")
    model = cfg.get("model") or "MiniMax-M3.1-Flash"

    parts: list[dict] = []
    if req.path:
        # A local file: the bridge reads it (converting a video to MP4 if the
        # container is not one MiniMax accepts) and describes it.
        source = Path(req.path)
        if not source.exists():
            raise HTTPException(status_code=404, detail=f"file not found: {req.path}")
        raw = source.read_bytes()
        suffix = source.suffix.lower()
        if suffix in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
            mime = "image/jpeg" if suffix in (".jpg", ".jpeg") else f"image/{suffix.lstrip('.')}"
            image_url: dict = {"url": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"}
            if req.detail:
                image_url["detail"] = req.detail
            parts.append({"type": "image_url", "image_url": image_url})
        else:
            raw = _to_mp4(raw, cfg)
            video_url: dict = {"url": f"data:video/mp4;base64,{base64.b64encode(raw).decode('ascii')}"}
            fps = req.fps if req.fps is not None else cfg.get("fps")
            if fps:
                video_url["fps"] = float(fps)
            parts.append({"type": "video_url", "video_url": video_url})
    if req.image_base64:
        image_url: dict = {"url": f"data:image/jpeg;base64,{req.image_base64}"}
        if req.detail:
            image_url["detail"] = req.detail
        parts.append({"type": "image_url", "image_url": image_url})
    if req.video_base64:
        raw = base64.b64decode(req.video_base64)
        mime = (req.mime or "video/mp4").lower()
        if mime not in ("video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska"):
            raw = _to_mp4(raw, cfg)
            mime = "video/mp4"
        video_url: dict = {"url": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"}
        fps = req.fps if req.fps is not None else cfg.get("fps")
        if fps:
            video_url["fps"] = float(fps)
        parts.append({"type": "video_url", "video_url": video_url})
    if not parts:
        raise HTTPException(status_code=400, detail="no image_base64 / video_base64 provided")

    parts.append({"type": "text", "text": req.prompt})
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": parts}],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=float(cfg.get("timeout_sec", 120))) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
            if resp.status_code >= 400:
                raise HTTPException(
                    status_code=502,
                    detail=f"MiniMax {resp.status_code}: {resp.text[:400]}",
                )
            body = resp.json()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("vision request failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"MiniMax request failed: {exc}") from exc

    content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return {
        "text": content,
        "model": body.get("model", model),
        "usage": body.get("usage", {}),
    }
