window.__ModuleLoader__.load({ id: "@beiyege-01/dsh-voice-ai-girlfriend", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/bridge.ts
var bridge_exports = {};
__export(bridge_exports, {
  DH_CHANGE_EVENT: () => DH_CHANGE_EVENT,
  VadStream: () => VadStream,
  bridgeBase: () => bridgeBase,
  bridgeFetch: () => bridgeFetch,
  cameraFrame: () => cameraFrame,
  dhDiscard: () => dhDiscard,
  dhEnable: () => dhEnable,
  dhSpeak: () => dhSpeak,
  dhStatus: () => dhStatus,
  enrollSpeaker: () => enrollSpeaker,
  notifyDhChanged: () => notifyDhChanged,
  readVoiceEnabled: () => readVoiceEnabled,
  stt: () => stt,
  tts: () => tts
});
function bridgeBase() {
  try {
    return localStorage.getItem("s2s.voice.bridge")?.trim() || DEFAULT_BRIDGE;
  } catch {
    return DEFAULT_BRIDGE;
  }
}
async function bridgeFetch(input, init, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastError = err;
      if (attempt + 1 < attempts) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
function readVoiceEnabled() {
  try {
    return localStorage.getItem("s2s.voice.enabled") !== "0";
  } catch {
    return true;
  }
}
async function enrollSpeaker(pcm16) {
  const resp = await bridgeFetch(`${bridgeBase()}/api/speaker/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: pcm16
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`speaker enroll failed: ${resp.status} ${body}`.trim());
  }
  speakerCheckCache = null;
}
async function speakerCheckEnabled() {
  if (speakerCheckCache !== null) return speakerCheckCache;
  try {
    if (localStorage.getItem("s2s.voice.speaker") === "0") {
      speakerCheckCache = false;
      return false;
    }
  } catch {
  }
  try {
    const resp = await bridgeFetch(`${bridgeBase()}/api/speaker/status`);
    const body = await resp.json();
    speakerCheckCache = body.enrolled === true && body.enabled !== false;
  } catch {
    speakerCheckCache = false;
  }
  return speakerCheckCache;
}
async function stt(pcm16, skipSpeakerCheck = false) {
  const headers = {
    "Content-Type": "application/octet-stream",
    "X-Max-Audio-Sec": "30"
  };
  const check2 = !skipSpeakerCheck && await speakerCheckEnabled();
  if (check2) headers["X-Speaker-Check"] = "1";
  const resp = await bridgeFetch(`${bridgeBase()}/api/stt`, {
    method: "POST",
    headers,
    body: pcm16
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`voice bridge /api/stt failed: ${resp.status} ${body}`.trim());
  }
  return resp.json();
}
async function tts(text, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  const forward = () => controller.abort();
  if (signal !== void 0) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: controller.signal
  };
  try {
    const resp = await bridgeFetch(`${bridgeBase()}/api/tts`, init);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`voice bridge /api/tts failed: ${resp.status} ${body}`.trim());
    }
    return await resp.arrayBuffer();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}
async function cameraFrame(timeoutMs = 8e3, wantGrid = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await bridgeFetch(`${bridgeBase()}/api/camera/frame${wantGrid ? "?grid=1" : ""}`, {
      method: "GET",
      signal: controller.signal
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`\u6444\u50CF\u5934\u53D6\u5E27\u5931\u8D25\uFF1A${resp.status} ${body}`.trim());
    }
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}
function dhSpeak(text) {
  const body = (text || "").trim();
  if (!body) return Promise.resolve(null);
  return bridgeFetch(`${bridgeBase()}/api/dh/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body })
  }).then(async (resp) => {
    if (!resp.ok) {
      const b = await resp.text().catch(() => "");
      throw new Error(`/api/dh/speak failed: ${resp.status} ${b}`.trim());
    }
    const json = await resp.json();
    return json.code ?? null;
  }).catch((err) => {
    console.error("[ui-voice] digital human submit failed:", err);
    return null;
  });
}
function dhDiscard(code) {
  if (!code) return;
  void bridgeFetch(`${bridgeBase()}/api/dh/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  }).catch((err) => console.error("[ui-voice] digital human discard failed:", err));
}
async function dhStatus() {
  try {
    const resp = await bridgeFetch(`${bridgeBase()}/api/dh/status`);
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}
async function dhEnable(enabled) {
  try {
    const resp = await bridgeFetch(`${bridgeBase()}/api/dh/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.enabled ?? null;
  } catch (err) {
    console.error("[ui-voice] digital human switch failed:", err);
    return null;
  }
}
function notifyDhChanged() {
  try {
    window.dispatchEvent(new Event(DH_CHANGE_EVENT));
  } catch {
  }
}
var DEFAULT_BRIDGE, speakerCheckCache, TTS_TIMEOUT_MS, DH_CHANGE_EVENT, VadStream;
var init_bridge = __esm({
  "src/client/bridge.ts"() {
    DEFAULT_BRIDGE = "http://127.0.0.1:8765";
    speakerCheckCache = null;
    TTS_TIMEOUT_MS = 45e3;
    DH_CHANGE_EVENT = "dsh-voice:dh-change";
    VadStream = class {
      ws = null;
      buffered = [];
      closed = false;
      connected = false;
      retryTimer = null;
      /** Whether the VAD socket is actually connected. The recorder falls back to
       *  RMS heuristics while this is false (e.g. an old bridge without /api/vad). */
      get available() {
        return this.connected;
      }
      /**
       * @param onSpeechStart - fired once when silero VAD hears speech.
       */
      open(onSpeechStart) {
        if (this.ws !== null) return;
        this.closed = false;
        const proto = bridgeBase().startsWith("https:") ? "wss:" : "ws:";
        const url = `${proto}//${bridgeBase().replace(/^https?:\/\//, "")}/api/vad`;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          if (this.ws !== ws) return;
          this.connected = true;
          for (const chunk of this.buffered.splice(0)) {
            ws.send(chunk);
          }
        };
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.event === "speech_start") onSpeechStart();
          } catch {
          }
        };
        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
          this.connected = false;
          if (!this.closed && this.retryTimer === null) {
            this.retryTimer = window.setTimeout(() => {
              this.retryTimer = null;
              if (!this.closed && this.ws === null) this.open(onSpeechStart);
            }, 2e3);
          }
        };
      }
      /** Push one 16 kHz PCM16 chunk (no-op while the socket is down). */
      send(pcm16) {
        const ws = this.ws;
        if (ws === null || this.closed) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(pcm16);
        } else if (ws.readyState === WebSocket.CONNECTING) {
          this.buffered.push(pcm16);
          if (this.buffered.length > 64) this.buffered.shift();
        }
      }
      close() {
        this.closed = true;
        this.buffered = [];
        if (this.retryTimer !== null) {
          window.clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        const ws = this.ws;
        this.ws = null;
        if (ws !== null) {
          try {
            ws.close();
          } catch {
          }
        }
      }
    };
  }
});

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/VoiceToolbar.tsx
var import_react11 = require("react");

// src/client/MicButton.tsx
var import_react = require("react");
init_bridge();

// src/client/worklets/mic-capture.ts
var MIC_CAPTURE_WORKLET_SOURCE = `
const TARGET_RATE = 16000;
const DEFAULT_CHUNK_MS = 40;
const GATE_ATTACK_MS = 5;
const GATE_HOLD_MS = 250;
const GATE_RELEASE_MS = 80;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkMs = options?.processorOptions?.chunkMs ?? DEFAULT_CHUNK_MS;
    this._inputRate = sampleRate;
    this._ratio = this._inputRate / TARGET_RATE;
    this._chunkSamples16k = Math.round((TARGET_RATE * chunkMs) / 1000);
    this._scratch = new Float32Array(0);
    this._decimated = new Float32Array(this._chunkSamples16k);
    this._enabled = true;

    this._gateEnabled = false;
    this._thresholdLin = 0;
    this._gateGain = 1;
    this._holdRemaining = 0;
    this._attackCoef = Math.exp(-1 / ((GATE_ATTACK_MS / 1000) * TARGET_RATE));
    this._releaseCoef = Math.exp(-1 / ((GATE_RELEASE_MS / 1000) * TARGET_RATE));
    this._holdSamples = Math.round((GATE_HOLD_MS / 1000) * TARGET_RATE);

    this.port.onmessage = (e) => {
      const data = e.data;
      if (data?.kind === "enable") this._enabled = !!data.value;
      else if (data?.kind === "gate") {
        this._gateEnabled = !!data.enabled;
        this._thresholdLin = data.enabled ? Math.pow(10, data.thresholdDb / 20) : 0;
      }
    };
  }

  _ingest(incoming) {
    if (incoming.length === 0) return;
    const next = new Float32Array(this._scratch.length + incoming.length);
    next.set(this._scratch, 0);
    next.set(incoming, this._scratch.length);
    this._scratch = next;
    this._maybeEmit();
  }

  _maybeEmit() {
    const r = this._ratio;
    const n = this._chunkSamples16k;
    const needIn = Math.ceil(n * r);
    const dec = this._decimated;
    while (this._scratch.length >= needIn) {
      let sumSq = 0;
      if (Math.abs(r - 3) < 1e-6) {
        for (let i = 0; i < n; i++) {
          const idx = i * 3;
          const s = (this._scratch[idx] + this._scratch[idx + 1] + this._scratch[idx + 2]) / 3;
          dec[i] = s;
          sumSq += s * s;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const srcPos = i * r;
          const idx = Math.floor(srcPos);
          const frac = srcPos - idx;
          const a = this._scratch[idx];
          const b = this._scratch[idx + 1] ?? a;
          const s = a + (b - a) * frac;
          dec[i] = s;
          sumSq += s * s;
        }
      }
      const rms = Math.sqrt(sumSq / n);

      let target = 1;
      if (this._gateEnabled) {
        if (rms >= this._thresholdLin) {
          this._holdRemaining = this._holdSamples;
        } else if (this._holdRemaining > 0) {
          this._holdRemaining -= n;
        } else {
          target = 0;
        }
      }

      const out = new Int16Array(n);
      let gain = this._gateGain;
      for (let i = 0; i < n; i++) {
        const coef = target > gain ? this._attackCoef : this._releaseCoef;
        gain = target + (gain - target) * coef;
        const s = dec[i] * gain;
        const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
        out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      this._gateGain = gain;

      const consumed = Math.floor(n * r);
      this._scratch = this._scratch.slice(consumed);

      this.port.postMessage({ kind: "level", rms });

      if (this._enabled) {
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const mono = input[0];
    if (mono.length > 0) this._ingest(mono);
    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
`;

// src/client/voice/recorder.ts
var DEFAULT_MIN_SILENCE_MS = 1800;
var DEFAULT_MAX_UTTERANCE_MS = 3e4;
var DEFAULT_RMS_THRESHOLD = 0.01;
var DEFAULT_INTERRUPT_THRESHOLD = 0.06;
var DEFAULT_INTERRUPT_HOLD_MS = 250;
var DEFAULT_INTERRUPT_CONFIRM_MS = 180;
var MicRecorder = class {
  constructor(opts) {
    this.opts = opts;
  }
  ctx = null;
  stream = null;
  source = null;
  node = null;
  chunks = [];
  chunkBytes = 0;
  speaking = false;
  lastVoiceAt = 0;
  maxTimer = null;
  released = false;
  paused = false;
  interruptMode = false;
  interruptArmed = false;
  /** 确认窗已经走完，后续的块开始累积（见 onChunk / onLevel）。 */
  confirmed = false;
  /** 最近约 600 毫秒的音频：打断确认后用它把话头补回来。 */
  preroll = [];
  prerollBytes = 0;
  /** 打断已确认、正在把用户的话记下来。 */
  capturing = false;
  interruptHoldStart = 0;
  confirmArmed = false;
  confirmStart = 0;
  get active() {
    return !this.released && this.ctx !== null;
  }
  /**
   * Pause/resume capture. While paused, incoming chunks and levels are
   * dropped (nothing accumulates, no endpointing fires). Used sparingly —
   * during playback we use {@link setInterruptMode} instead so barge-in
   * detection keeps running.
   */
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) this.resetBuffers();
  }
  /**
   * Barge-in listening mode (during reply playback): chunks are streamed to
   * the bridge's silero VAD (never accumulated), which fires `speech_start`
   * only for a REAL human voice — TTS echo / music / ambient noise cannot
   * trip it. On `speech_start` the recorder leaves interrupt mode and the
   * user's ongoing speech accumulates normally.
   */
  setInterruptMode(enabled) {
    if (this.interruptMode === enabled) return;
    this.interruptMode = enabled;
    this.interruptArmed = false;
    this.confirmArmed = false;
    this.confirmed = false;
    if (enabled) {
      this.opts.vad?.open(() => this.onVadSpeechStart());
    } else {
      this.opts.vad?.close();
      this.resetBuffers();
    }
  }
  /** Bridge VAD heard a real voice: stop the reply and accumulate the user's
   *  ongoing speech. (silero's speech_start is already the confirmation — no
   *  RMS hold/confirm heuristics needed on this path.) */
  onVadSpeechStart() {
    if (!this.interruptMode) return;
    this.interruptMode = false;
    this.interruptArmed = false;
    this.confirmArmed = false;
    this.resetBuffers();
    this.confirmed = true;
    this.opts.onSpeechInterrupt?.();
  }
  resetBuffers() {
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    this.chunks = [];
    this.chunkBytes = 0;
    this.preroll = [];
    this.prerollBytes = 0;
    this.capturing = false;
    this.speaking = false;
    this.interruptArmed = false;
    this.confirmArmed = false;
  }
  /** Acquire the mic and start the capture worklet. */
  async start() {
    this.released = false;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    this.stream = stream;
    const workletUrl = URL.createObjectURL(
      new Blob([MIC_CAPTURE_WORKLET_SOURCE], { type: "text/javascript" })
    );
    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "mic-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { chunkMs: 40 }
    });
    const gateDb = this.opts.noiseGateDb;
    if (gateDb !== void 0 && gateDb !== 0) {
      node.port.postMessage({ kind: "gate", enabled: true, thresholdDb: gateDb });
    }
    node.port.onmessage = (e) => {
      if (this.released) return;
      const data = e.data;
      if (data instanceof ArrayBuffer) this.onChunk(data);
      else if (data !== null && typeof data === "object" && data.kind === "level") this.onLevel(data.rms);
    };
    source.connect(node);
    this.source = source;
    this.node = node;
  }
  /** Stop capture and release the mic / AudioContext. */
  stop() {
    if (this.released) return;
    this.released = true;
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    this.opts.vad?.close();
    this.node?.port.close();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.ctx?.close().catch(() => {
    });
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.chunks = [];
    this.chunkBytes = 0;
    this.preroll = [];
    this.prerollBytes = 0;
    this.capturing = false;
    this.speaking = false;
    this.interruptMode = false;
    this.interruptArmed = false;
    this.confirmArmed = false;
  }
  onLevel(rms) {
    if (this.released || this.paused) return;
    if (this.interruptMode) {
      const threshold2 = this.opts.interruptThreshold ?? DEFAULT_INTERRUPT_THRESHOLD;
      const now = performance.now();
      if (rms >= threshold2) {
        if (!this.interruptArmed) {
          this.interruptArmed = true;
          this.interruptHoldStart = now;
        } else if (!this.confirmArmed && now - this.interruptHoldStart >= (this.opts.interruptHoldMs ?? DEFAULT_INTERRUPT_HOLD_MS)) {
          this.confirmArmed = true;
          this.confirmStart = now;
        } else if (this.confirmArmed && now - this.confirmStart >= (this.opts.interruptConfirmMs ?? DEFAULT_INTERRUPT_CONFIRM_MS)) {
          this.confirmArmed = false;
          this.interruptArmed = false;
          this.interruptMode = false;
          this.capturing = false;
          this.confirmed = true;
          if (!this.capturing) {
            this.capturing = true;
            this.chunks.push(...this.preroll);
            this.chunkBytes += this.prerollBytes;
            this.preroll = [];
            this.prerollBytes = 0;
          }
          this.opts.onSpeechInterrupt?.();
          if (!this.speaking) {
            this.speaking = true;
            this.lastVoiceAt = now;
            this.armMaxTimer();
            this.opts.onSpeakingChange?.(true);
          }
        }
      } else {
        this.interruptArmed = false;
        this.confirmArmed = false;
      }
      return;
    }
    const threshold = this.opts.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    if (rms >= threshold) {
      this.lastVoiceAt = performance.now();
      if (!this.speaking) {
        this.speaking = true;
        this.armMaxTimer();
        this.opts.onSpeakingChange?.(true);
      }
    }
  }
  /** Keep the last ~600 ms of audio so an interruption can still be recorded. */
  pushPreroll(buffer) {
    this.preroll.push(buffer);
    this.prerollBytes += buffer.byteLength;
    while (this.prerollBytes > 19e3 && this.preroll.length > 1) {
      const dropped = this.preroll.shift();
      if (dropped !== void 0) this.prerollBytes -= dropped.byteLength;
    }
  }
  onChunk(buffer) {
    if (this.released || this.paused) return;
    if (this.interruptMode) {
      this.opts.vad?.send(buffer);
      this.pushPreroll(buffer);
      if (this.confirmed && !this.capturing) {
        this.capturing = true;
        this.chunks.push(...this.preroll);
        this.chunkBytes += this.prerollBytes;
        this.preroll = [];
        this.prerollBytes = 0;
        this.speaking = true;
        this.lastVoiceAt = performance.now();
        this.armMaxTimer();
        this.opts.onSpeakingChange?.(true);
      }
      if (this.capturing) {
        this.chunks.push(buffer);
        this.chunkBytes += buffer.byteLength;
      }
      return;
    }
    this.chunks.push(buffer);
    this.chunkBytes += buffer.byteLength;
    if (!this.speaking) return;
    const silenceMs = performance.now() - this.lastVoiceAt;
    if (silenceMs >= (this.opts.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS)) this.flush();
  }
  armMaxTimer() {
    if (this.maxTimer !== null) clearTimeout(this.maxTimer);
    this.maxTimer = setTimeout(
      () => this.flush(),
      this.opts.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS
    );
  }
  flush() {
    if (this.released) return;
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    const pcm = this.chunkBytes > 0 ? this.concatChunks() : null;
    const durationMs = this.chunkBytes / 2 / 16e3 * 1e3;
    this.chunks = [];
    this.chunkBytes = 0;
    this.preroll = [];
    this.prerollBytes = 0;
    this.capturing = false;
    if (this.speaking) {
      this.speaking = false;
      this.opts.onSpeakingChange?.(false);
    }
    const minMs = this.opts.minUtteranceMs ?? 0;
    if (pcm !== null && durationMs >= minMs) this.opts.onUtterance(pcm);
  }
  concatChunks() {
    const out = new Uint8Array(this.chunkBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }
};

// src/client/voice/chat-nodes.ts
function chatNodes(chat) {
  return chat?.nodes?.values?.() ?? [];
}
function assistantNodeText(node) {
  const data = node.data;
  if (data === void 0 || data === null) return "";
  if (!Array.isArray(data.blocks)) return "";
  return data.blocks.filter((block) => block?.kind === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
function userNodeText(node) {
  const data = node.data;
  if (data === void 0 || data === null) return "";
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  if (Array.isArray(data.content)) {
    return data.content.filter((part) => part !== null && typeof part?.text === "string").map((part) => part.text).join("\n");
  }
  if (Array.isArray(data.blocks)) {
    return data.blocks.filter((block) => block !== void 0 && block !== null && typeof block.text === "string").map((block) => block.text).join("\n");
  }
  return "";
}

// src/client/voice/smalltalk.ts
var SMALL_TALK_LINES = ["\u5728\u5417\uFF1F", "\u6211\u6765\u4E86\u3002", "\u8FD8\u5728\u5417\uFF1F"];
var CLAUSE_MAX_CHARS = 16;
var CLAUSE_MIN_COVERAGE = 0.6;
var SPEAKABLE = /[^一-鿿A-Za-z0-9 \u00b0.\u0000]/g;
var DOT_BETWEEN_DIGITS = /(\d)\.(\d)/g;
function stripUnspoken(text) {
  const protectedText = text.replace(DOT_BETWEEN_DIGITS, "$1\0$2");
  return protectedText.replace(SPEAKABLE, "").replace(/\s+/g, " ").replace(/\u0000/g, ".").trim();
}
function splitClauses(text) {
  const clauses = [];
  let buf = "";
  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed !== "") clauses.push(trimmed);
    buf = "";
  };
  for (const ch of text) {
    if (ch === "\uFF0C" || ch === "," || ch === "\u3002" || ch === "\uFF01" || ch === "\uFF1F" || ch === "!" || ch === "?") {
      flush();
      continue;
    }
    buf += ch;
  }
  const partial = buf.trim();
  return { clauses, partial: partial === "" ? null : partial };
}
function pickOpeningPhrase(phrases, force = false, limit = CLAUSE_MAX_CHARS) {
  const cleaned = [];
  for (const phrase of phrases) {
    const clean = stripUnspoken(phrase);
    if (clean !== "") cleaned.push(clean);
  }
  if (cleaned.length === 0) return null;
  let opening = "";
  for (const phrase of cleaned) {
    const candidate = opening === "" ? phrase : `${opening}\uFF0C${phrase}`;
    if (candidate.length <= limit) {
      opening = candidate;
      continue;
    }
    if (opening === "" && phrase.length <= limit * 2) return phrase;
    const room = limit - (opening === "" ? 0 : opening.length + 1);
    if (room <= 0) break;
    if (room / phrase.length >= CLAUSE_MIN_COVERAGE) {
      opening = opening === "" ? phrase.slice(0, room) : `${opening}\uFF0C${phrase.slice(0, room)}`;
    }
    break;
  }
  if (opening === "") {
    if (!force) return null;
    return cleaned[0].slice(0, limit);
  }
  return opening;
}
function pickSmallTalkLine() {
  const index = Math.floor(Math.random() * SMALL_TALK_LINES.length);
  return SMALL_TALK_LINES[index] ?? SMALL_TALK_LINES[0];
}
var CALLBACK_INSTRUCTION = "\uFF08\u4E0A\u9762\u8FD9\u6BB5\u662F\u4F60\u81EA\u5DF1\u521A\u8BF4\u8FC7\u7684\u8BDD\u3002\u4E0D\u8981\u603B\u7ED3\u5B83\uFF0C\u4E5F\u4E0D\u8981\u590D\u8FF0\u5B83\u2014\u2014\u7528\u53E3\u8BED\u63A5\u4E00\u53E5\u627F\u4E0A\u542F\u4E0B\u7684\u8BDD\uFF1A\u5148\u987A\u7740\u4E0A\u9762\u90A3\u53E5\u7684\u5C3E\u5DF4\u63A5\u4F4F\uFF0C\u518D\u81EA\u7136\u5730\u5E26\u51FA\u4F60\u63A5\u4E0B\u6765\u8981\u8BF4\u7684\u65B9\u5411\uFF0C\u5341\u516D\u4E2A\u5B57\u4EE5\u5185\uFF0C\u50CF\u5728\u8DDF\u4EBA\u5F53\u9762\u8BF4\u8BDD\uFF0C\u4E0D\u8981\u50CF\u6807\u9898\u3001\u4E0D\u8981\u50CF\u6458\u8981\u3001\u4E0D\u8981\u7528\u4E66\u9762\u8BED\uFF0C\u53EA\u8F93\u51FA\u8FD9\u4E00\u53E5\u8BDD\uFF0C\u4E0D\u8981\u89E3\u91CA\uFF0C\u4E0D\u8981\u52A0\u5F15\u53F7\u3002\uFF09";
function buildSmallTalkLine(previousAnswer) {
  const material = (previousAnswer ?? "").trim();
  if (material === "") return pickSmallTalkLine();
  return `${material}

${CALLBACK_INSTRUCTION}`;
}
var ARMED_TTL_MS = 45e3;
var armed = false;
var armedAt = 0;
var armedTtl = ARMED_TTL_MS;
var CACHED_SMALL_TALK_TTL_MS = 3 * 6e4;
var CACHED_PENDING_AUDIO_TTL_MS = 30 * 6e4;
function armSmallTalk(ttlMs = ARMED_TTL_MS) {
  armed = true;
  armedAt = Date.now();
  armedTtl = ttlMs;
}
function isSmallTalkArmed() {
  if (!armed) return false;
  if (Date.now() - armedAt > armedTtl) {
    armed = false;
    return false;
  }
  return true;
}
function disarmSmallTalk() {
  armed = false;
}
var openerLive = false;
var openerReplyCaptured = false;
function markOpenerLive() {
  openerLive = true;
}
function isOpenerLive() {
  return openerLive;
}
function retireOpener() {
  openerLive = false;
  openerReplyCaptured = false;
}
function markOpenerReplyCaptured() {
  openerReplyCaptured = true;
}
function keepOpenerAlive() {
  if (!openerLive) return;
  if (openerReplyCaptured) return;
  armSmallTalk(CACHED_SMALL_TALK_TTL_MS);
}
function touchPendingSmallTalkAudio() {
  if (pendingClips === null) return;
  pendingAt = Date.now();
}
var pendingClips = null;
var pendingAt = 0;
function setPendingSmallTalkAudio(clips) {
  pendingClips = clips;
  pendingAt = Date.now();
}
function takePendingSmallTalkAudio(maxAgeMs = openerLive ? CACHED_PENDING_AUDIO_TTL_MS : 12e4) {
  if (pendingClips === null) return null;
  const clips = pendingClips;
  pendingClips = null;
  if (Date.now() - pendingAt > maxAgeMs) return null;
  return clips;
}
function clearPendingSmallTalkAudio() {
  pendingClips = null;
}
var audioUntil = 0;
function noteSmallTalkAudioQueued(clips) {
  let ms = 0;
  for (const clip of clips) ms += wavDurationMs(clip);
  if (ms <= 0) ms = 1500;
  audioUntil = Date.now() + Math.min(6e4, ms) + 400;
}
function wavDurationMs(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44) return 0;
    const byteRate = view.getUint32(28, true);
    const dataBytes = view.getUint32(40, true);
    if (byteRate <= 0) return 0;
    return Math.round(dataBytes / byteRate * 1e3);
  } catch {
    return 0;
  }
}
function smallTalkAudioPlaying() {
  return Date.now() < audioUntil;
}
var sentLines = /* @__PURE__ */ new Set();
var sentPrefixes = /* @__PURE__ */ new Set();
var OPENER_PREFIX = 24;
function squash(text) {
  return text.replace(/\s+/g, "").trim();
}
function rememberSmallTalkLine(line) {
  const key = line.trim();
  if (key === "") return;
  sentLines.add(key);
  const prefix = squash(key).slice(0, OPENER_PREFIX);
  if (prefix.length >= 4) sentPrefixes.add(prefix);
}
function isSmallTalkLine(text) {
  const key = text.trim();
  if (sentLines.has(key)) return true;
  if (sentPrefixes.size === 0) return false;
  const squashed = squash(key);
  if (squashed === "") return false;
  for (const prefix of sentPrefixes) {
    if (squashed.startsWith(prefix)) return true;
  }
  return false;
}
var replyTexts = /* @__PURE__ */ new Set();
function rememberSmallTalkReplyText(text) {
  const key = text.trim();
  if (key !== "") replyTexts.add(key);
}
function isSmallTalkReplyText(text) {
  return replyTexts.has(text.trim());
}

// src/client/voice/speech-gate.ts
var userTalking = false;
function noteUserTalking(talking) {
  if (talking) lastTalkingAt = Date.now();
  if (userTalking === talking) return;
  userTalking = talking;
  for (const listener of talkingListeners) listener(talking);
}
var talkingListeners = /* @__PURE__ */ new Set();
function onUserTalkingChange(listener) {
  talkingListeners.add(listener);
  return () => {
    talkingListeners.delete(listener);
  };
}
function isUserTalking() {
  return userTalking;
}
var lastTalkingAt = 0;
function quietForMs() {
  if (userTalking) return 0;
  if (lastTalkingAt === 0) return Number.POSITIVE_INFINITY;
  return Date.now() - lastTalkingAt;
}
var repliedTurn = 0;
var askedTurn = 0;
function noteReplySpoken(turn) {
  if (turn > 0) repliedTurn = turn;
}
function repliedInTurn(turn) {
  return turn > 0 && repliedTurn === turn;
}
function noteQuestionSpoken(turn) {
  if (turn > 0) askedTurn = turn;
}
function questionAskedInTurn(turn) {
  return turn > 0 && askedTurn === turn;
}

// src/client/MicButton.module.css
var css = ".b1649e_mic {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  padding: 0;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  position: relative;\n  color: var(--dsw-alias-label-dimmed);\n  cursor: pointer;\n  transition: color 0.2s ease, background 0.2s ease;\n}\n\n.b1649e_mic:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n\n.b1649e_mic .ad7436_waves {\n  position: absolute;\n  left: 4px;\n  right: 4px;\n  bottom: 3px;\n  height: 3px;\n  display: flex;\n  align-items: flex-end;\n  justify-content: space-between;\n  gap: 1px;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.b1649e_mic .ad7436_waves i {\n  width: 2px;\n  border-radius: 1px;\n  background: currentColor;\n  height: 1px;\n  transition: opacity 0.2s ease;\n}\n\n\n.b1649e_mic.bfbb97_listening {\n  color: var(--dsw-alias-state-business-primary);\n  animation: mic-standby 2.4s ease-in-out infinite;\n}\n\n@keyframes mic-standby {\n  0%, 100% {\n    transform: scale(1);\n    filter: drop-shadow(0 0 1px rgba(56, 132, 255, 0));\n  }\n  50% {\n    transform: scale(1.07);\n    filter: drop-shadow(0 0 6px rgba(56, 132, 255, 0.55));\n  }\n}\n\n\n.b1649e_mic.bfbb97_listening.a28ffa4_voice {\n  color: var(--dsw-alias-state-success-primary);\n  animation: mic-rec-glow 1.2s ease-in-out infinite;\n}\n\n.b1649e_mic.bfbb97_listening.a28ffa4_voice .ad7436_waves {\n  opacity: 1;\n}\n\n.b1649e_mic.bfbb97_listening.a28ffa4_voice .ad7436_waves i {\n  animation: mic-bar 0.7s ease-in-out infinite;\n}\n\n.b1649e_mic.bfbb97_listening.a28ffa4_voice .ad7436_waves i:nth-child(1) { animation-delay: 0s; }\n.b1649e_mic.bfbb97_listening.a28ffa4_voice .ad7436_waves i:nth-child(2) { animation-delay: 0.18s; }\n.b1649e_mic.bfbb97_listening.a28ffa4_voice .ad7436_waves i:nth-child(3) { animation-delay: 0.36s; }\n\n@keyframes mic-rec-glow {\n  0%, 100% { filter: drop-shadow(0 0 2px rgba(34, 197, 94, 0.25)); }\n  50% { filter: drop-shadow(0 0 7px rgba(34, 197, 94, 0.6)); }\n}\n\n@keyframes mic-bar {\n  0%, 100% { height: 1px; opacity: 0.5; }\n  50% { height: 3px; opacity: 1; }\n}\n\n\n.b1649e_mic.a58706b_transcribing {\n  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 62%, #000);\n}\n\n.b1649e_mic.a58706b_transcribing::before {\n  content: '';\n  position: absolute;\n  inset: -3px;\n  border-radius: 50%;\n  border: 2px solid transparent;\n  border-top-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 62%, #000);\n  opacity: 0.9;\n  pointer-events: none;\n  animation: mic-spin 0.8s linear infinite;\n}\n\n@keyframes mic-spin {\n  to { transform: rotate(360deg); }\n}\n\n\n.b1649e_mic.a8cf6d9_error {\n  color: var(--dsw-alias-state-error-primary);\n}\n";
var tagId = "@beiyege-01/dsh-voice-ai-girlfriend/MicButton.module.css";
if (typeof document !== "undefined") {
  const q = "style[data-plugin-css=" + JSON.stringify(tagId) + "]";
  if (!document.querySelector(q)) {
    const el = document.createElement("style");
    el.dataset.plugin = "@beiyege-01/dsh-voice-ai-girlfriend";
    el.dataset.pluginCss = tagId;
    el.textContent = css;
    document.head.appendChild(el);
  }
}
var MicButton_default = { "mic": "b1649e_mic", "waves": "ad7436_waves", "listening": "bfbb97_listening", "voice": "a28ffa4_voice", "transcribing": "a58706b_transcribing", "error": "a8cf6d9_error" };

// src/client/chips.css
var css2 = "\n\n.b4454f_chip {\n  transition:\n    transform 0.32s cubic-bezier(0.22, 1, 0.36, 1),\n    box-shadow 0.4s ease,\n    filter 0.4s ease;\n  will-change: transform;\n}\n\n\n.b4454f_chip:hover {\n  transform: translateY(-1px) scale(1.045);\n  box-shadow:\n    0 3px 14px rgba(56, 132, 255, 0.16),\n    inset 0 0 0 1px rgba(56, 132, 255, 0.42);\n}\n\n.b4454f_chip:active {\n  transform: scale(0.97);\n}\n\n\n.eca2d0_on {\n  animation: chip-breathe 3.4s ease-in-out infinite;\n}\n\n@keyframes chip-breathe {\n  0%, 100% { box-shadow: inset 0 0 0 1px rgba(56, 132, 255, 0.45), 0 0 4px rgba(56, 132, 255, 0.08); }\n  50% { box-shadow: inset 0 0 0 1px rgba(56, 132, 255, 0.6), 0 0 11px rgba(56, 132, 255, 0.3); }\n}\n\n\n.a99a61d_listening {\n  animation: mic-listen 2.4s ease-in-out infinite;\n}\n\n@keyframes mic-listen {\n  0%, 100% { filter: drop-shadow(0 0 1px rgba(56, 132, 255, 0)); }\n  50% { filter: drop-shadow(0 0 6px rgba(56, 132, 255, 0.45)); }\n}\n\n\n.a64a39c_rec {\n  animation: mic-rec 1.5s ease-in-out infinite;\n}\n\n@keyframes mic-rec {\n  0%, 100% { transform: scale(1); filter: drop-shadow(0 0 2px rgba(34, 197, 94, 0.18)); }\n  50% { transform: scale(1.06); filter: drop-shadow(0 0 8px rgba(34, 197, 94, 0.5)); }\n}\n\n\n.a1b9d93_playing {\n  animation: wave 1.4s ease-in-out infinite;\n}\n\n@keyframes wave {\n  0%, 100% { transform: scale(1); filter: drop-shadow(0 0 2px rgba(103, 158, 254, 0.2)); }\n  50% { transform: scale(1.07); filter: drop-shadow(0 0 9px rgba(103, 158, 254, 0.6)); }\n}\n\n\n.a982776_dhBusy {\n  animation: chip-dh-busy 1.9s ease-in-out infinite;\n}\n\n@keyframes chip-dh-busy {\n  0%, 100% {\n    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.55), 0 0 4px rgba(52, 211, 153, 0.18);\n    filter: drop-shadow(0 0 0 rgba(52, 211, 153, 0));\n  }\n  50% {\n    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.85), 0 0 16px rgba(52, 211, 153, 0.6);\n    filter: drop-shadow(0 0 7px rgba(52, 211, 153, 0.75));\n  }\n}\n\n\n.daa8e0_bridgeDown {\n  animation: chip-bridge-down 2.2s ease-in-out infinite;\n}\n\n@keyframes chip-bridge-down {\n  0%, 100% {\n    box-shadow: inset 0 0 0 1px rgba(229, 72, 77, 0.55), 0 0 4px rgba(229, 72, 77, 0.14);\n  }\n  50% {\n    box-shadow: inset 0 0 0 1px rgba(229, 72, 77, 0.9), 0 0 12px rgba(229, 72, 77, 0.42);\n  }\n}\n\n\n.cbb831_bridgeBack {\n  animation: chip-bridge-back 2.4s ease-out forwards;\n}\n\n@keyframes chip-bridge-back {\n  0% {\n    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.9), 0 0 16px rgba(52, 211, 153, 0.55);\n    transform: scale(1.08);\n  }\n  70% {\n    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.7), 0 0 8px rgba(52, 211, 153, 0.3);\n    transform: scale(1);\n  }\n  100% {\n    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.45), 0 0 3px rgba(52, 211, 153, 0.12);\n    transform: scale(1);\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .daa8e0_bridgeDown {\n    animation: none;\n    box-shadow: inset 0 0 0 1px rgba(229, 72, 77, 0.85), 0 0 10px rgba(229, 72, 77, 0.4);\n  }\n  .cbb831_bridgeBack {\n    animation: none;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .a982776_dhBusy {\n    animation: none;\n    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.8), 0 0 12px rgba(52, 211, 153, 0.5);\n  }\n}\n\n\n.ab0abe_camDot {\n  position: absolute;\n  top: 3px;\n  right: 3px;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: #ff4d4f;\n  box-shadow: 0 0 5px rgba(255, 77, 79, 0.85);\n  animation: cam-blink 1.6s ease-in-out infinite;\n}\n\n@keyframes cam-blink {\n  0%, 100% { opacity: 1; }\n  50% { opacity: 0.25; }\n}\n";
var tagId2 = "@beiyege-01/dsh-voice-ai-girlfriend/chips.css";
if (typeof document !== "undefined") {
  const q = "style[data-plugin-css=" + JSON.stringify(tagId2) + "]";
  if (!document.querySelector(q)) {
    const el = document.createElement("style");
    el.dataset.plugin = "@beiyege-01/dsh-voice-ai-girlfriend";
    el.dataset.pluginCss = tagId2;
    el.textContent = css2;
    document.head.appendChild(el);
  }
}
var chips_default = { "chip": "b4454f_chip", "on": "eca2d0_on", "listening": "a99a61d_listening", "rec": "a64a39c_rec", "playing": "a1b9d93_playing", "dhBusy": "a982776_dhBusy", "bridgeDown": "daa8e0_bridgeDown", "bridgeBack": "cbb831_bridgeBack", "camDot": "ab0abe_camDot" };

// src/client/MicButton.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function MicIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("line", { x1: "12", y1: "19", x2: "12", y2: "23" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("line", { x1: "8", y1: "23", x2: "16", y2: "23" })
  ] });
}
var MicButton = (0, import_react.memo)(function MicButton2({ t, sendText, startSmallTalk, speaker, interruptReply, modes, useChat, useSession }) {
  const [phase, setPhase] = (0, import_react.useState)("idle");
  const [rejectedScore, setRejectedScore] = (0, import_react.useState)(null);
  const [voiceActive, setVoiceActive] = (0, import_react.useState)(false);
  const recorderRef = (0, import_react.useRef)(null);
  const queueRef = (0, import_react.useRef)([]);
  const drainRunningRef = (0, import_react.useRef)(false);
  const chat = useChat((s) => s);
  const chatRef = (0, import_react.useRef)(chat);
  chatRef.current = chat;
  const session = useSession((s) => s);
  const sessionRef = (0, import_react.useRef)(session);
  sessionRef.current = session;
  const smallTalkDoneRef = (0, import_react.useRef)(false);
  const handledOpenRef = (0, import_react.useRef)(modes.micOpenCount);
  const listenStartedAtRef = (0, import_react.useRef)(0);
  (0, import_react.useEffect)(() => () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);
  (0, import_react.useEffect)(() => {
    return speaker.subscribe(() => {
      const rec = recorderRef.current;
      if (rec === null) return;
      rec.setPaused(false);
      rec.setInterruptMode(speaker.speaking);
    });
  }, [speaker]);
  const drain = (0, import_react.useCallback)(async () => {
    if (drainRunningRef.current) return;
    drainRunningRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        if (recorderRef.current === null) break;
        const pcm = queueRef.current.shift();
        setPhase("transcribing");
        try {
          const warmingUp = Date.now() - listenStartedAtRef.current < 3e3;
          const result = await stt(pcm, warmingUp);
          const text = result.text;
          if (result.rejected === true) {
            console.log("[ui-voice] stt rejected by the voiceprint:", result.score);
            setRejectedScore(result.score ?? null);
            setPhase("rejected");
            window.setTimeout(() => {
              setPhase((current2) => current2 === "rejected" ? "listening" : current2);
            }, 1500);
            continue;
          }
          if (text !== void 0 && text.trim() !== "") {
            void sendText(text.trim()).catch((err) => {
              console.error("[ui-voice] send failed:", err);
            });
            retireOpener();
          }
        } catch (err) {
          console.error("[ui-voice] stt/send failed:", err);
        }
      }
    } finally {
      drainRunningRef.current = false;
      setPhase(recorderRef.current !== null ? "listening" : "idle");
    }
  }, [sendText]);
  const toggle = (0, import_react.useCallback)(() => {
    modes.mic = !modes.mic;
  }, [modes]);
  const stopListening = (0, import_react.useCallback)(() => {
    if (isOpenerLive()) {
      console.log("[ui-voice] mic closed without speech: keeping the cached opener");
      keepOpenerAlive();
    } else {
      clearPendingSmallTalkAudio();
      disarmSmallTalk();
    }
    smallTalkDoneRef.current = false;
    if (recorderRef.current === null) return;
    recorderRef.current.stop();
    recorderRef.current = null;
    queueRef.current = [];
    noteUserTalking(false);
    setPhase("idle");
  }, []);
  const startListening = (0, import_react.useCallback)(async () => {
    if (recorderRef.current !== null) return;
    interruptReply();
    const running = sessionRef.current?.running === true;
    const openCount = modes.micOpenCount;
    const genuineOpen = openCount !== handledOpenRef.current;
    handledOpenRef.current = openCount;
    if (!genuineOpen) {
      console.log("[ui-voice] mic already open: no opener for this attach");
      smallTalkDoneRef.current = true;
    } else if (running) {
      console.log("[ui-voice] mic opened while the agent is running: opener skipped");
      smallTalkDoneRef.current = true;
    } else if (!smallTalkDoneRef.current) {
      smallTalkDoneRef.current = true;
      void (async () => {
        if (isOpenerLive()) {
          console.log("[ui-voice] small talk: reusing the cached opener");
          keepOpenerAlive();
          touchPendingSmallTalkAudio();
          return;
        }
        const resolvePrevious = () => {
          let previous2 = null;
          for (const node of chatNodes(chatRef.current)) {
            if (node.kind !== "assistant-step") continue;
            const text = assistantNodeText(node);
            if (text === "" || isSmallTalkReplyText(text)) continue;
            previous2 = text;
          }
          return previous2;
        };
        let previous = resolvePrevious();
        if (previous === null) {
          for (let attempt = 0; attempt < 3 && previous === null; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            previous = resolvePrevious();
          }
        }
        await startSmallTalk(previous);
      })().catch((err) => {
        console.error("[ui-voice] small talk failed:", err);
      });
    }
    listenStartedAtRef.current = Date.now();
    const recorder = new MicRecorder({
      // 断句静音从 1800ms 降到 900ms：说完少等将近一秒。
      minSilenceMs: 900,
      maxUtteranceMs: 3e4,
      // 起音阈值 0.06：0.04 太灵，键盘、椅子、隔壁说话都能挑起来；
      // 正常说话（0.1 以上）照旧过线。
      rmsThreshold: 0.06,
      // 短于 700ms 的片段按噪音丢弃——键盘敲击凑不出这么长的连续音。
      minUtteranceMs: 700,
      // Noise gate (original project's worklet): -35 dBFS. Tighter than the
      // original's -45 so louder ambient hums (a desk fan measured ~ -40..
      // -30 dB) get faded out of the sent stream, while normal speech
      // (~ -26..-10 dB) passes untouched.
      noiseGateDb: -35,
      // Barge-in: 桥接 silero VAD 与本地 RMS 双保险（见 recorder.onLevel）。
      // 打断阈值同步抬到 0.06、持续 250ms，免得背景声一响就把播报掐掉。
      vad: new VadStream(),
      interruptThreshold: 0.06,
      interruptHoldMs: 250,
      interruptConfirmMs: 150,
      onSpeechInterrupt: () => {
        interruptReply();
      },
      onSpeakingChange: (speaking) => {
        setVoiceActive(speaking);
        noteUserTalking(speaking);
      },
      onUtterance: (pcm) => {
        queueRef.current.push(pcm);
        void drain();
      }
    });
    recorderRef.current = recorder;
    setVoiceActive(false);
    setPhase("listening");
    try {
      await recorder.start();
    } catch (err) {
      console.error("[ui-voice] mic start failed:", err);
      recorder.stop();
      recorderRef.current = null;
      setVoiceActive(false);
      setPhase("error");
    }
  }, [interruptReply, drain, startSmallTalk, chat]);
  (0, import_react.useEffect)(() => {
    const sync = () => {
      if (modes.mic) {
        void startListening();
      } else {
        stopListening();
      }
    };
    const unsubscribe = modes.subscribe(sync);
    sync();
    return unsubscribe;
  }, [modes, startListening, stopListening]);
  const statusTitle = phase === "idle" ? "\u5DF2\u5173\u95ED\uFF08\u7070\uFF09\xB7\u70B9\u51FB\u5F00\u542F\u8046\u542C" : phase === "error" ? "\u4E0D\u53EF\u7528\uFF08\u7EA2\uFF09\xB7\u70B9\u51FB\u91CD\u8BD5" : phase === "rejected" ? `\u58F0\u7EB9\u672A\u901A\u8FC7\uFF08\u76F8\u4F3C\u5EA6 ${(rejectedScore ?? 0).toFixed(2)}\uFF09\xB7 \u8FD9\u53E5\u8BDD\u6CA1\u6709\u53D1\u9001` : phase === "transcribing" ? "\u8BC6\u522B\u4E2D\uFF08\u6DF1\u7EFF\uFF09" : voiceActive ? "\u6536\u97F3\u4E2D\uFF08\u7EFF\uFF09" : "\u5F85\u547D\uFF08\u84DD\uFF09";
  const className = [
    chips_default.chip,
    MicButton_default.mic,
    phase === "listening" ? MicButton_default.listening : "",
    phase === "transcribing" ? MicButton_default.transcribing : "",
    phase === "error" ? MicButton_default.error : "",
    phase === "listening" && voiceActive ? MicButton_default.voice : ""
  ].filter(Boolean).join(" ");
  const phaseColor = phase === "error" ? "var(--dsw-alias-state-error-primary)" : phase === "rejected" ? "var(--dsw-alias-state-danger-primary, #e5484d)" : phase === "transcribing" ? "var(--dsw-alias-state-success-primary)" : phase === "listening" ? voiceActive ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-dimmed)";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className,
      title: `${t("mic.title")} \xB7 ${statusTitle}`,
      "aria-label": `${t("mic.title")} \xB7 ${statusTitle}`,
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        padding: 0,
        border: "none",
        borderRadius: 9,
        cursor: "pointer",
        position: "relative",
        background: "rgba(127,127,127,0.14)",
        color: phaseColor,
        boxShadow: "inset 0 0 0 1px rgba(127,127,127,0.18)",
        transition: "color 0.2s ease, background 0.2s ease"
      },
      onClick: toggle,
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MicIcon, {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: MicButton_default.waves, "aria-hidden": "true", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {})
        ] })
      ]
    }
  );
});

// src/client/VoiceToggle.tsx
var import_react2 = require("react");

// src/client/chip.ts
var prim = "var(--dsw-alias-state-business-primary)";
var dim = "var(--dsw-alias-label-dimmed)";
function chipStyle(on) {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    padding: 0,
    border: "none",
    borderRadius: 9,
    cursor: "pointer",
    flex: "0 0 auto",
    margin: "0 4px",
    background: on ? `color-mix(in srgb, ${prim} 22%, transparent)` : "rgba(127,127,127,0.14)",
    color: on ? prim : dim,
    boxShadow: on ? `inset 0 0 0 1px color-mix(in srgb, ${prim} 62%, transparent)` : "inset 0 0 0 1px rgba(127,127,127,0.18)",
    transition: "color .2s ease, background .2s ease, box-shadow .2s ease"
  };
}
function chipKey(e) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.currentTarget.click();
  }
}

// src/client/VoiceToggle.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function SpeakerIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("polygon", { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M15.54 8.46a5 5 0 0 1 0 7.07" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14" })
  ] });
}
var VoiceToggle = (0, import_react2.memo)(function VoiceToggle2({ t, speaker, abortTts, modes }) {
  const [on, setOn] = (0, import_react2.useState)(modes.speaker);
  const [speaking, setSpeaking] = (0, import_react2.useState)(speaker.speaking);
  (0, import_react2.useEffect)(() => speaker.subscribe(() => setSpeaking(speaker.speaking)), [speaker]);
  (0, import_react2.useEffect)(() => modes.subscribe(() => setOn(modes.speaker)), [modes]);
  const toggle = (0, import_react2.useCallback)(() => {
    const next = !modes.speaker;
    modes.speaker = next;
    if (!next) {
      speaker.stop();
      abortTts();
    }
  }, [modes, speaker, abortTts]);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className: [chips_default.chip, on ? chips_default.on : "", speaking ? chips_default.playing : ""].join(" "),
      title: on ? t("toggle.offHint") : t("toggle.onHint"),
      "aria-label": on ? t("toggle.offHint") : t("toggle.onHint"),
      "aria-pressed": on,
      style: chipStyle(on),
      onClick: toggle,
      onKeyDown: chipKey,
      children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SpeakerIcon, {})
    }
  );
});

// src/client/CameraToggle.tsx
var import_react3 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
function CameraIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("path", { d: "M23 7l-7 5 7 5V7z" }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("rect", { x: "1", y: "5", width: "15", height: "14", rx: "2", ry: "2" })
  ] });
}
var CameraToggle = (0, import_react3.memo)(function CameraToggle2({ t, modes, vision }) {
  const [state, setState] = (0, import_react3.useState)(vision.status);
  (0, import_react3.useEffect)(() => vision.subscribe(setState), [vision]);
  const on = modes.vision;
  const toggle = () => {
    modes.vision = !modes.vision;
  };
  const statusTitle = state === "error" ? `\u6444\u50CF\u5934\u4E0D\u53EF\u7528\uFF08\u7EA2\uFF09\xB7${vision.error ?? "\u70B9\u51FB\u91CD\u8BD5"}` : state === "starting" ? "\u6B63\u5728\u6253\u5F00\u6444\u50CF\u5934\u2026\uFF08\u753B\u9762\u7531\u672C\u5730\u6865\u63A5\u4ECE\u7535\u8111\u6444\u50CF\u5934\u6293\u53D6\uFF09" : on ? "\u6444\u50CF\u5934\u5DF2\u5F00\uFF08\u7EFF\uFF09\xB7\u6A21\u578B\u6B63\u5728\u770B\u753B\u9762\uFF0C\u70B9\u51FB\u5173\u95ED" : "\u5DF2\u5173\u95ED\uFF08\u7070\uFF09\xB7\u70B9\u51FB\u6253\u5F00\u6444\u50CF\u5934\uFF0C\u6A21\u578B\u5C31\u80FD\u770B\u5230\u753B\u9762";
  const color = state === "error" ? "var(--dsw-alias-state-error-primary)" : state === "starting" ? "var(--dsw-alias-state-warning-primary)" : on ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-dimmed)";
  const style = {
    ...chipStyle(on),
    color,
    background: on ? `color-mix(in srgb, ${color} 22%, transparent)` : "rgba(127,127,127,0.14)",
    boxShadow: on ? `inset 0 0 0 1px color-mix(in srgb, ${color} 62%, transparent)` : "inset 0 0 0 1px rgba(127,127,127,0.18)",
    position: "relative"
  };
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className: [chips_default.chip, on ? chips_default.on : ""].join(" "),
      title: `${t("camera.title")} \xB7 ${statusTitle}`,
      "aria-label": `${t("camera.title")} \xB7 ${statusTitle}`,
      "aria-pressed": on,
      style,
      onClick: toggle,
      onKeyDown: chipKey,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(CameraIcon, {}),
        on ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: chips_default.camDot, "aria-hidden": "true" }) : null
      ]
    }
  );
});

// src/client/DigitalHumanToggle.tsx
var import_react4 = require("react");
init_bridge();
var import_jsx_runtime4 = require("react/jsx-runtime");
var DIGITAL_HUMAN_KEY = "s2s.voice.digitalHuman";
function readDigitalHuman() {
  try {
    return localStorage.getItem(DIGITAL_HUMAN_KEY) !== "0";
  } catch {
    return true;
  }
}
function DigitalHumanIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("circle", { cx: "12", cy: "7", r: "3.5" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("path", { d: "M5.5 20a6.5 6.5 0 0 1 13 0" }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("path", { d: "M3 3.5 4.6 5M21 3.5 19.4 5M2 10H1M23 10h-1" })
  ] });
}
var DigitalHumanToggle = (0, import_react4.memo)(function DigitalHumanToggle2({ t }) {
  const [on, setOn] = (0, import_react4.useState)(readDigitalHuman);
  (0, import_react4.useEffect)(() => {
    void dhEnable(readDigitalHuman()).then(() => notifyDhChanged());
  }, []);
  const [busy, setBusy] = (0, import_react4.useState)(false);
  (0, import_react4.useEffect)(() => {
    if (!on) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    const tick = () => {
      void dhStatus().then((s) => {
        if (cancelled || s === null) return;
        setBusy(s.state === "tts" || s.state === "generating" || s.pending > 0);
      });
    };
    tick();
    const timer = window.setInterval(tick, 4e3);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [on]);
  const toggle = (0, import_react4.useCallback)(() => {
    setOn((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(DIGITAL_HUMAN_KEY, next ? "1" : "0");
      } catch {
      }
      void dhEnable(next).then(() => notifyDhChanged());
      return next;
    });
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className: [chips_default.chip, on ? chips_default.on : "", on && busy ? chips_default.dhBusy : ""].join(" "),
      title: on ? t("dh.offHint") : t("dh.onHint"),
      "aria-label": on ? t("dh.offHint") : t("dh.onHint"),
      "aria-pressed": on,
      style: chipStyle(on),
      onClick: toggle,
      onKeyDown: chipKey,
      children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(DigitalHumanIcon, {})
    }
  );
});

// src/client/CompanionToggle.tsx
var import_react5 = require("react");
var import_jsx_runtime5 = require("react/jsx-runtime");
function DisplayIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("rect", { x: "2.5", y: "3", width: "19", height: "14.5", rx: "2.5" }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("line", { x1: "8", y1: "21", x2: "16", y2: "21" }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("line", { x1: "12", y1: "17.5", x2: "12", y2: "21" }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("circle", { cx: "13.5", cy: "9", r: "2.1" }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("path", { d: "M10.7 14.6a3.1 3.1 0 0 1 5.6 0" })
  ] });
}
var CompanionToggle = (0, import_react5.memo)(function CompanionToggle2({ t, companion }) {
  const [on, setOn] = (0, import_react5.useState)(companion.visible);
  (0, import_react5.useEffect)(() => companion.subscribe(() => setOn(companion.visible)), [companion]);
  const toggle = (0, import_react5.useCallback)(() => {
    companion.visible = !companion.visible;
  }, [companion]);
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className: [chips_default.chip, on ? chips_default.on : ""].join(" "),
      title: on ? t("companion.offHint") : t("companion.onHint"),
      "aria-label": on ? t("companion.offHint") : t("companion.onHint"),
      "aria-pressed": on,
      style: chipStyle(on),
      onClick: toggle,
      onKeyDown: chipKey,
      children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(DisplayIcon, {})
    }
  );
});

// src/client/BusyToggle.tsx
var import_react6 = require("react");
var import_jsx_runtime6 = require("react/jsx-runtime");
var INTERRUPT_KEY = "s2s.voice.interrupt";
function readInterrupt() {
  try {
    return localStorage.getItem(INTERRUPT_KEY) !== "0";
  } catch {
    return true;
  }
}
function BoltIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" }) });
}
var BusyToggle = (0, import_react6.memo)(function BusyToggle2({ t }) {
  const [on, setOn] = (0, import_react6.useState)(readInterrupt);
  const toggle = (0, import_react6.useCallback)(() => {
    setOn((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(INTERRUPT_KEY, next ? "1" : "0");
      } catch {
      }
      return next;
    });
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className: [chips_default.chip, on ? chips_default.on : ""].join(" "),
      title: on ? t("interrupt.onHint") : t("interrupt.offHint"),
      "aria-label": on ? t("interrupt.onHint") : t("interrupt.offHint"),
      "aria-pressed": on,
      style: chipStyle(on),
      onClick: toggle,
      onKeyDown: chipKey,
      children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(BoltIcon, {})
    }
  );
});

// src/client/BridgeStatus.tsx
var import_react7 = require("react");
init_bridge();
var import_jsx_runtime7 = require("react/jsx-runtime");
var MAIN_REPO_URL = "https://github.com/c137650/dsh-voice-companion#readme";
var POLL_UP_MS = 3e4;
var POLL_DOWN_MS = 5e3;
var RECOVERED_MS = 2500;
function WarnIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("path", { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }),
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("line", { x1: "12", y1: "9", x2: "12", y2: "13" }),
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("line", { x1: "12", y1: "17", x2: "12.01", y2: "17" })
  ] });
}
function TickIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("path", { d: "M20 6 9 17l-5-5" }) });
}
var BridgeStatus = (0, import_react7.memo)(function BridgeStatus2(_props) {
  const [ok, setOk] = (0, import_react7.useState)(null);
  const [recovered, setRecovered] = (0, import_react7.useState)(false);
  const wasDown = (0, import_react7.useRef)(false);
  (0, import_react7.useEffect)(() => {
    let cancelled = false;
    let timer = 0;
    const check2 = async () => {
      try {
        const controller = new AbortController();
        const abort = window.setTimeout(() => controller.abort(), 3e3);
        let alive = false;
        try {
          const resp = await fetch(`${bridgeBase()}/api/health`, { signal: controller.signal });
          alive = resp.ok;
        } finally {
          window.clearTimeout(abort);
        }
        if (cancelled) return;
        if (!alive && wasDown.current) {
          setRecovered(true);
          window.setTimeout(() => {
            if (!cancelled) setRecovered(false);
          }, RECOVERED_MS);
        }
        wasDown.current = !alive;
        setOk(alive);
      } catch {
        if (cancelled) return;
        wasDown.current = true;
        setOk(false);
      }
      if (cancelled) return;
      timer = window.setTimeout(() => {
        void check2();
      }, ok === false ? POLL_DOWN_MS : POLL_UP_MS);
    };
    void check2();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ok]);
  if (ok === null) return null;
  if (ok === false) {
    return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
      "span",
      {
        role: "button",
        tabIndex: 0,
        className: `${chips_default.chip} ${chips_default.bridgeDown}`,
        title: "\u8BED\u97F3\u6865\u63A5\u65AD\u5F00\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8FDE\u2026\u2026\uFF08\u70B9\u6309\u67E5\u770B\u90E8\u7F72\u6307\u5357\uFF09",
        "aria-label": "\u8BED\u97F3\u6865\u63A5\u65AD\u5F00\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8FDE \u2014\u2014 \u70B9\u6309\u67E5\u770B\u90E8\u7F72\u6307\u5357",
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 30,
          padding: 0,
          border: "none",
          borderRadius: 9,
          cursor: "pointer",
          margin: "0 4px",
          background: "color-mix(in srgb, var(--dsw-alias-state-danger-primary) 22%, transparent)",
          color: "var(--dsw-alias-state-danger-primary, #e5484d)",
          transition: "color .2s ease, background .2s ease, box-shadow .2s ease"
        },
        onClick: () => window.open(MAIN_REPO_URL, "_blank", "noopener"),
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            window.open(MAIN_REPO_URL, "_blank", "noopener");
          }
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(WarnIcon, {})
      }
    );
  }
  if (recovered) {
    return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
      "span",
      {
        className: `${chips_default.chip} ${chips_default.bridgeBack}`,
        title: "\u8BED\u97F3\u6865\u63A5\u5DF2\u6062\u590D",
        "aria-label": "\u8BED\u97F3\u6865\u63A5\u5DF2\u6062\u590D",
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 30,
          padding: 0,
          border: "none",
          borderRadius: 9,
          margin: "0 4px",
          background: "color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 20%, transparent)",
          color: "var(--dsw-alias-state-success-primary, #30a46c)"
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(TickIcon, {})
      }
    );
  }
  return null;
});

// src/client/PersonaToggle.tsx
var import_react8 = require("react");
init_bridge();
var import_jsx_runtime8 = require("react/jsx-runtime");
var PERSIST = {
  avatar: "s2s.voice.persona.avatar",
  idle: "s2s.voice.persona.idle"
};
function readSaved(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSaved(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}
function avatarLabel(name) {
  return name.replace(/^avatar/, "").replace(/\.mp4$/i, "").trim() || "\u9ED8\u8BA4";
}
function AvatarIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: "12", cy: "7", r: "4" })
  ] });
}
function IdleIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("rect", { x: "2", y: "4", width: "20", height: "16", rx: "2" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: "M2 9h20" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: "6", cy: "13", r: "1.2" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: "10", cy: "13", r: "1.2" })
  ] });
}
var KIND_META = {
  avatar: { key: "avatar", icon: AvatarIcon, hintKey: "persona.avatarHint" },
  idle: { key: "idle", icon: IdleIcon, hintKey: "persona.idleHint" }
};
var PersonaToggle = (0, import_react8.memo)(function PersonaToggle2({ t }) {
  const [state, setState] = (0, import_react8.useState)(null);
  const [applied, setApplied] = (0, import_react8.useState)(false);
  const appliedRef = (0, import_react8.useRef)(false);
  const aliveRef = (0, import_react8.useRef)(true);
  (0, import_react8.useEffect)(() => () => {
    aliveRef.current = false;
  }, []);
  (0, import_react8.useEffect)(() => {
    let cancelled = false;
    void fetch(`${bridgeBase()}/api/persona/list`).then((r) => r.json()).then((s) => {
      if (cancelled) return;
      setState(s);
      setApplied(true);
    }).catch((err) => console.error("[ui-voice] persona list failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);
  (0, import_react8.useEffect)(() => {
    if (!applied || appliedRef.current || state === null) return;
    appliedRef.current = true;
    const savedAvatar = readSaved(PERSIST.avatar);
    const savedIdle = readSaved(PERSIST.idle);
    const patch = {};
    if (savedAvatar !== null && state.avatars.some((a) => a.name === savedAvatar)) patch.avatar = savedAvatar;
    if (savedIdle !== null && state.idles.some((i) => i.name === savedIdle)) patch.idle = savedIdle;
    if (Object.keys(patch).length === 0) return;
    void fetch(`${bridgeBase()}/api/persona/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }).then(() => fetch(`${bridgeBase()}/api/persona/list`).then((r) => r.json())).then((s) => {
      if (aliveRef.current) setState(s);
    }).catch((err) => console.error("[ui-voice] persona restore failed:", err));
  }, [applied, state]);
  const cycle = (0, import_react8.useCallback)((kind) => {
    if (state === null) return;
    const meta = KIND_META[kind];
    const list = kind === "avatar" ? state.avatars : state.idles;
    if (list.length === 0) return;
    const current2 = state.current[meta.key];
    const idx = list.findIndex((x) => x.name === current2);
    const next = list[(idx + 1) % list.length];
    if (next === void 0) return;
    const patch = { [kind]: next.name };
    writeSaved(PERSIST[kind], next.name);
    void fetch(`${bridgeBase()}/api/persona/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }).then(() => fetch(`${bridgeBase()}/api/persona/list`).then((r) => r.json())).then((s) => {
      if (!aliveRef.current) return;
      setState(s);
      window.dispatchEvent(new CustomEvent("dsh-voice:persona", { detail: { kind, name: next.name } }));
    }).catch((err) => console.error(`[ui-voice] persona ${kind} switch failed:`, err));
  }, [state]);
  if (state === null) return null;
  const currentAvatar = state.current.avatar;
  const currentIdle = state.current.idle;
  const avatarLabelText = avatarLabel(currentAvatar);
  const idleLabel = state.idles.find((i) => i.name === currentIdle)?.label ?? currentIdle;
  const pill = (kind, label, current2) => {
    const meta = KIND_META[kind];
    const Icon = meta.icon;
    const nextName = (() => {
      const list = kind === "avatar" ? state.avatars : state.idles;
      const idx = list.findIndex((x) => x.name === current2);
      const next = list[(idx + 1) % list.length];
      return next?.label ?? "";
    })();
    const hint = t(meta.hintKey);
    const prim2 = "var(--dsw-alias-state-business-primary)";
    return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(
      "span",
      {
        role: "button",
        tabIndex: 0,
        className: chips_default.chip,
        title: `${hint}\uFF1A\u5F53\u524D\u300C${label}\u300D\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u300C${nextName}\u300D`,
        "aria-label": `${hint}\uFF1A${label}`,
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px",
          borderRadius: 999,
          cursor: "pointer",
          margin: "0 5px",
          background: `color-mix(in srgb, ${prim2} 18%, transparent)`,
          color: prim2,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${prim2} 55%, transparent)`,
          transition: "color .2s ease, background .2s ease, box-shadow .2s ease",
          fontSize: 12,
          lineHeight: 1
        },
        onClick: () => cycle(kind),
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            cycle(kind);
          }
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Icon, {}),
          /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { children: label })
        ]
      }
    );
  };
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(import_jsx_runtime8.Fragment, { children: [
    pill("avatar", avatarLabelText, currentAvatar),
    pill("idle", idleLabel, currentIdle)
  ] });
});

// src/client/VisionToggle.tsx
var import_react9 = require("react");

// src/client/vision-visibility.ts
var KEY = "s2s.voice.hideVision";
var listeners = /* @__PURE__ */ new Set();
var slotActive = false;
var inlineAlt = "";
var styleEl = null;
function visionHidden() {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}
function setVisionHidden(hidden) {
  try {
    localStorage.setItem(KEY, hidden ? "1" : "0");
  } catch {
  }
  for (const fn of listeners) fn(hidden);
  applyVisionVisibility();
}
function subscribeVisionVisibility(fn) {
  listeners.add(fn);
  fn(visionHidden());
  return () => {
    listeners.delete(fn);
  };
}
function markVisionSlotActive() {
  if (slotActive) return;
  slotActive = true;
  applyVisionVisibility();
}
function learnInlineAlt(alt) {
  if (alt === "" || alt === inlineAlt) return;
  inlineAlt = alt;
  applyVisionVisibility();
}
function learnInlineAltFromDom() {
  const images = document.querySelectorAll("[data-message-attachments] img");
  const last = images[images.length - 1];
  const alt = last?.getAttribute("alt") ?? "";
  if (alt !== "") learnInlineAlt(alt);
}
function applyVisionVisibility() {
  const hidden = visionHidden();
  document.body.classList.toggle("s2s-vision-hidden", hidden);
  if (styleEl === null) {
    styleEl = document.createElement("style");
    styleEl.dataset.s2sVision = "1";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = cssRules(hidden);
}
function cssRules(hidden) {
  if (!hidden) return "";
  if (slotActive) return "";
  if (inlineAlt !== "") {
    return `body.s2s-vision-hidden [data-message-attachments]:has(img[alt="${escapeAttr(inlineAlt)}"]) { display: none !important; }`;
  }
  return "body.s2s-vision-hidden [data-message-attachments]:has(img) { display: none !important; }";
}
function escapeAttr(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// src/client/VisionToggle.tsx
var import_jsx_runtime9 = require("react/jsx-runtime");
function EyeIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("circle", { cx: "12", cy: "12", r: "3" })
  ] });
}
function EyeOffIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M14.12 14.12a3 3 0 1 1-4.24-4.24" }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("line", { x1: "1", y1: "1", x2: "23", y2: "23" })
  ] });
}
var VisionToggle = (0, import_react9.memo)(function VisionToggle2({ t }) {
  const [hidden, setHidden] = (0, import_react9.useState)(visionHidden());
  (0, import_react9.useEffect)(() => subscribeVisionVisibility(setHidden), []);
  const title = hidden ? t?.("vision.hiddenHint") ?? "\u753B\u9762\uFF1A\u5DF2\u6536\u8D77\uFF08\u70B9\u51FB\u8BA9\u5BF9\u8BDD\u91CC\u7684\u753B\u9762\u5168\u90E8\u663E\u793A\uFF09" : t?.("vision.shownHint") ?? "\u753B\u9762\uFF1A\u5168\u90E8\u663E\u793A\uFF08\u70B9\u51FB\u628A\u753B\u9762\u6536\u8D77\u6765\uFF09";
  const style = {
    ...chipStyle(!hidden),
    color: hidden ? "var(--dsw-alias-label-dimmed, #888)" : "var(--dsw-alias-state-success-primary, #3a9)",
    background: hidden ? "rgba(127,127,127,0.14)" : `color-mix(in srgb, var(--dsw-alias-state-success-primary, #3a9) 22%, transparent)`,
    boxShadow: hidden ? "inset 0 0 0 1px rgba(127,127,127,0.18)" : "inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-success-primary, #3a9) 62%, transparent)"
  };
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className: [chips_default.chip, hidden ? "" : chips_default.on].join(" "),
      title,
      "aria-label": title,
      "aria-pressed": !hidden,
      style,
      onClick: () => setVisionHidden(!hidden),
      onKeyDown: chipKey,
      children: hidden ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(EyeOffIcon, {}) : /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(EyeIcon, {})
    }
  );
});

// src/client/VoicePrintButton.tsx
var import_react10 = require("react");
init_bridge();
var import_jsx_runtime10 = require("react/jsx-runtime");
var RECORD_MS = 12e3;
var TARGET_RATE = 16e3;
function PrintIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M12 10a2 2 0 0 1 2 2v3" }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M8 12a4 4 0 0 1 8 0v4" }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M5 12a7 7 0 0 1 14 0v3" }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M12 18v2" })
  ] });
}
function toPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return out.buffer;
}
function resample(input, from, to) {
  if (from === to || input.length === 0) return input;
  const ratio = to / from;
  const length = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio;
    const low = Math.floor(position);
    const high = Math.min(input.length - 1, low + 1);
    const weight = position - low;
    out[i] = (input[low] ?? 0) * (1 - weight) + (input[high] ?? 0) * weight;
  }
  return out;
}
var VoicePrintButton = (0, import_react10.memo)(function VoicePrintButton2({ t }) {
  const [phase, setPhase] = (0, import_react10.useState)("idle");
  const [seconds, setSeconds] = (0, import_react10.useState)(0);
  const streamRef = (0, import_react10.useRef)(null);
  const ctxRef = (0, import_react10.useRef)(null);
  (0, import_react10.useEffect)(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void ctxRef.current?.close().catch(() => void 0);
  }, []);
  const start = (0, import_react10.useCallback)(async () => {
    if (phase === "recording" || phase === "saving") return;
    setPhase("recording");
    setSeconds(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.resume().catch(() => void 0);
      const source = ctx.createMediaStreamSource(stream);
      const collector = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      collector.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(collector);
      collector.connect(ctx.destination);
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        setSeconds(Math.min(RECORD_MS, Date.now() - startedAt) / 1e3);
      }, 200);
      await new Promise((resolve) => {
        window.setTimeout(resolve, RECORD_MS);
      });
      window.clearInterval(timer);
      collector.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const mono16k = resample(merged, ctx.sampleRate, TARGET_RATE);
      await ctx.close().catch(() => void 0);
      ctxRef.current = null;
      setPhase("saving");
      await enrollSpeaker(toPcm16(mono16k));
      setPhase("done");
      window.setTimeout(() => setPhase("idle"), 2500);
    } catch (err) {
      console.error("[ui-voice] voiceprint enrollment failed:", err);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setPhase("error");
      window.setTimeout(() => setPhase("idle"), 3e3);
    }
  }, [phase]);
  const label = phase === "recording" ? `${t("speaker.recording")} ${Math.max(0, Math.ceil(RECORD_MS / 1e3 - seconds))}s` : phase === "saving" ? t("speaker.saving") : phase === "done" ? t("speaker.done") : phase === "error" ? t("speaker.error") : t("speaker.idle");
  const color = phase === "recording" ? "var(--dsw-alias-state-danger-primary, #e5484d)" : phase === "done" ? "var(--dsw-alias-state-success-primary, #30a46c)" : phase === "error" ? "var(--dsw-alias-state-danger-primary, #e5484d)" : "var(--dsw-alias-label-dimmed)";
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
    "span",
    {
      role: "button",
      tabIndex: 0,
      className: chips_default.chip,
      title: label,
      "aria-label": label,
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        padding: 0,
        border: "none",
        borderRadius: 9,
        cursor: phase === "recording" || phase === "saving" ? "progress" : "pointer",
        margin: "0 4px",
        background: "rgba(127,127,127,0.14)",
        color,
        boxShadow: "inset 0 0 0 1px rgba(127,127,127,0.18)",
        transition: "color 0.2s ease, background 0.2s ease"
      },
      onClick: () => {
        void start();
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void start();
        }
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(PrintIcon, {})
    }
  );
});

// src/client/VoiceToolbar.tsx
var import_jsx_runtime11 = require("react/jsx-runtime");
var VoiceToolbar = (0, import_react11.memo)(function VoiceToolbar2(props) {
  const micProps = props;
  const voiceProps = props;
  const cameraProps = props;
  const dhProps = props;
  const companionProps = props;
  const busyProps = props;
  const bridgeProps = props;
  const personaProps = props;
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(
    "div",
    {
      style: {
        display: "block",
        textAlign: "center",
        width: "100%",
        boxSizing: "border-box",
        padding: "8px 12px",
        margin: "0 auto"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(BridgeStatus, { ...bridgeProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(PersonaToggle, { ...personaProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(MicButton, { ...micProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(VoiceToggle, { ...voiceProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(CameraToggle, { ...cameraProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(DigitalHumanToggle, { ...dhProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(CompanionToggle, { ...companionProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(BusyToggle, { ...busyProps }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(VisionToggle, { t: props.t }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(VoicePrintButton, { ...props })
      ]
    }
  );
});

// src/client/BalanceBadge.tsx
var import_react12 = require("react");
init_bridge();
function statsRegistry() {
  const win = window;
  return win.__dshStatsExtras ??= /* @__PURE__ */ new Set();
}
function formatBalance(body) {
  const info = body.balance_infos?.[0];
  if (info === void 0) return null;
  const value = Number.parseFloat(info.total_balance);
  if (!Number.isFinite(value)) return null;
  const symbol = info.currency === "USD" ? "$" : "\xA5";
  return `${symbol}${value.toFixed(2)}`;
}
var REFRESH_MS = 10 * 60 * 1e3;
var BalanceBadge = (0, import_react12.memo)(function BalanceBadge2(_props) {
  const labelRef = (0, import_react12.useRef)(null);
  (0, import_react12.useEffect)(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await fetch(`${bridgeBase()}/api/balance`);
        if (!resp.ok) return;
        const json = await resp.json();
        if (!cancelled) labelRef.current = formatBalance(json);
      } catch {
      }
    };
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    const extra = () => {
      const value = labelRef.current;
      return value === null ? null : `\u4F59\u989D ${value}`;
    };
    statsRegistry().add(extra);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      statsRegistry().delete(extra);
    };
  }, []);
  return null;
});

// src/client/CameraPreview.tsx
var import_react13 = require("react");
var import_react_dom = require("react-dom");

// src/client/CameraPreview.module.css
var css3 = "\n\n.a298ee3_wrap {\n  position: fixed;\n  right: 26px;\n  bottom: 148px;\n  width: 208px;\n  box-sizing: border-box;\n  padding: 8px;\n  border-radius: 14px;\n  background: rgba(20, 22, 28, 0.82);\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.32), inset 0 0 0 1px rgba(255, 255, 255, 0.12);\n  backdrop-filter: blur(10px);\n  z-index: 60;\n  pointer-events: auto;\n  cursor: grab;\n  touch-action: none;\n  user-select: none;\n}\n\n.a298ee3_wrap:active {\n  cursor: grabbing;\n}\n\n.a663e54_head {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 0 2px 6px;\n  font-size: 11px;\n  letter-spacing: 0.02em;\n  color: rgba(255, 255, 255, 0.72);\n}\n\n.a94c8e5_dot {\n  width: 6px;\n  height: 6px;\n  border-radius: 999px;\n  background: #3ddc84;\n  box-shadow: 0 0 8px #3ddc84;\n  flex: none;\n}\n\n.ba0385_title {\n  flex: 1;\n  color: rgba(255, 255, 255, 0.9);\n}\n\n.ce5b67_age {\n  color: rgba(255, 255, 255, 0.5);\n  font-variant-numeric: tabular-nums;\n}\n\n.b460e1_frame {\n  display: block;\n  width: 100%;\n  aspect-ratio: 4 / 3;\n  object-fit: cover;\n  border-radius: 9px;\n  background: #000;\n  pointer-events: none;\n}\n\n.a51d3af_empty {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 100%;\n  aspect-ratio: 4 / 3;\n  border-radius: 9px;\n  background: rgba(255, 255, 255, 0.06);\n  color: rgba(255, 255, 255, 0.42);\n  font-size: 11px;\n  text-align: center;\n  padding: 0 10px;\n  box-sizing: border-box;\n}\n\n.a8eac86_foot {\n  display: flex;\n  align-items: baseline;\n  justify-content: space-between;\n  gap: 6px;\n  padding: 5px 2px 0;\n  font-size: 10px;\n  color: rgba(255, 255, 255, 0.42);\n}\n\n.f91234_footLabel {\n  flex: none;\n}\n\n.f1754d_footValue {\n  color: rgba(255, 255, 255, 0.66);\n  font-variant-numeric: tabular-nums;\n}\n";
var tagId3 = "@beiyege-01/dsh-voice-ai-girlfriend/CameraPreview.module.css";
if (typeof document !== "undefined") {
  const q = "style[data-plugin-css=" + JSON.stringify(tagId3) + "]";
  if (!document.querySelector(q)) {
    const el = document.createElement("style");
    el.dataset.plugin = "@beiyege-01/dsh-voice-ai-girlfriend";
    el.dataset.pluginCss = tagId3;
    el.textContent = css3;
    document.head.appendChild(el);
  }
}
var CameraPreview_default = { "wrap": "a298ee3_wrap", "head": "a663e54_head", "dot": "a94c8e5_dot", "title": "ba0385_title", "age": "ce5b67_age", "frame": "b460e1_frame", "empty": "a51d3af_empty", "foot": "a8eac86_foot", "footLabel": "f91234_footLabel", "footValue": "f1754d_footValue" };

// src/client/CameraPreview.tsx
var import_jsx_runtime12 = require("react/jsx-runtime");
var POS_KEY = "s2s.voice.previewPos";
function readPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}
function savePos(pos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
  }
}
function ageLabel(age, empty) {
  if (age === null) return empty;
  if (age < 1.5) return "\u521A\u521A";
  if (age < 60) return `${Math.round(age)} \u79D2\u524D`;
  return `${Math.round(age / 60)} \u5206\u949F\u524D`;
}
var CameraPreview = (0, import_react13.memo)(function CameraPreview2({ modes, vision }) {
  const [open, setOpen] = (0, import_react13.useState)(modes.vision);
  const [live, setLive] = (0, import_react13.useState)(null);
  const [sentAt, setSentAt] = (0, import_react13.useState)(() => vision.lastDelivered?.at ?? null);
  const [now, setNow] = (0, import_react13.useState)(() => performance.now());
  const [pos, setPos] = (0, import_react13.useState)(() => readPos());
  const dragRef = (0, import_react13.useRef)(null);
  (0, import_react13.useEffect)(() => modes.subscribe(() => setOpen(modes.vision)), [modes]);
  (0, import_react13.useEffect)(() => vision.subscribeLive((frame) => {
    if (frame === null) {
      setLive(null);
      return;
    }
    setLive({ data: frame.data, at: frame.at });
  }), [vision]);
  (0, import_react13.useEffect)(() => vision.subscribeDelivery((frame) => {
    setSentAt(frame === null ? null : performance.now());
  }), [vision]);
  (0, import_react13.useEffect)(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [open]);
  const onPointerDown = (0, import_react13.useCallback)((event) => {
    if (event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    dragRef.current = { dx: event.clientX - box.left, dy: event.clientY - box.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);
  const onPointerMove = (0, import_react13.useCallback)((event) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const width = event.currentTarget.offsetWidth;
    const height = event.currentTarget.offsetHeight;
    const x = Math.min(Math.max(0, event.clientX - drag.dx), window.innerWidth - width);
    const y = Math.min(Math.max(0, event.clientY - drag.dy), window.innerHeight - height);
    setPos({ x, y });
  }, []);
  const onPointerUp = (0, import_react13.useCallback)((event) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
    }
    if (pos !== null) savePos(pos);
  }, [pos]);
  if (!open) return null;
  const liveAge = live === null ? null : Math.max(0, (now - live.at) / 1e3);
  const sentAge = sentAt === null ? null : Math.max(0, (now - sentAt) / 1e3);
  const style = pos === null ? void 0 : { left: pos.x, top: pos.y, right: "auto", bottom: "auto" };
  return (0, import_react_dom.createPortal)(
    /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(
      "div",
      {
        className: CameraPreview_default.wrap,
        style,
        title: "\u6444\u50CF\u5934\u5B9E\u65F6\u753B\u9762\uFF08\u62D6\u52A8\u53EF\u4EE5\u632A\u4F4D\u7F6E\uFF09",
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)("div", { className: CameraPreview_default.head, children: [
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("span", { className: CameraPreview_default.dot, "aria-hidden": "true" }),
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("span", { className: CameraPreview_default.title, children: "\u6444\u50CF\u5934" }),
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("span", { className: CameraPreview_default.age, children: ageLabel(liveAge, "\u7B49\u5F85\u753B\u9762") })
          ] }),
          live === null ? /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("div", { className: CameraPreview_default.empty, children: "\u6444\u50CF\u5934\u6B63\u5728\u6253\u5F00\u2026" }) : /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("img", { className: CameraPreview_default.frame, alt: "\u6444\u50CF\u5934\u5B9E\u65F6\u753B\u9762", src: `data:image/jpeg;base64,${live.data}`, draggable: false }),
          /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)("div", { className: CameraPreview_default.foot, children: [
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("span", { className: CameraPreview_default.footLabel, children: "\u6A21\u578B\u6700\u540E\u6536\u5230" }),
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)("span", { className: CameraPreview_default.footValue, children: ageLabel(sentAge, "\u8FD8\u6CA1\u6709") })
          ] })
        ]
      }
    ),
    document.body
  );
});

// src/client/voice/reply-listener.tsx
var import_react14 = require("react");
init_bridge();

// src/client/voice/fillers.ts
init_bridge();
async function fetchFiller(group) {
  try {
    const resp = await fetch(`${bridgeBase()}/api/filler/${group}`, { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
  }
}
var STEPS = [
  { atMs: 3e3, group: "thinking" },
  { atMs: 1e4, group: "working" }
];
var FillerTimeline = class {
  speaker;
  steps = [];
  timers = [];
  cancelled = false;
  /** When this turn's countdown started. */
  base = 0;
  /** Waiting for the previous turn's audio to finish. */
  unwatch = null;
  /** Until when a filler is expected to be audible. */
  playingUntil = 0;
  /**
   * @param speaker - the shared player (fillers go through the same queue).
   */
  constructor(speaker) {
    this.speaker = speaker;
  }
  /** Arm the timeline for a fresh turn. */
  start() {
    this.cancelled = false;
    this.steps = STEPS.map((step) => ({ ...step, played: false }));
    this.clearTimers();
    if (this.unwatch !== null) return;
    if (this.speaker.speaking) {
      this.armWhenQuiet();
      return;
    }
    this.arm();
  }
  /** Start the countdown from now. */
  arm() {
    this.base = Date.now();
    for (const step of this.steps) {
      const delay = Math.max(0, this.base + step.atMs - Date.now());
      const id = window.setTimeout(() => {
        if (this.cancelled) return;
        if (step.played) return;
        void this.play(step);
      }, delay);
      this.timers.push(id);
    }
  }
  /** Wait for the speaker to go quiet, then start the countdown. */
  armWhenQuiet() {
    this.stopWatching();
    this.unwatch = this.speaker.subscribe(() => {
      if (this.cancelled) {
        this.stopWatching();
        return;
      }
      if (this.speaker.speaking) return;
      this.stopWatching();
      if (this.cancelled) return;
      this.arm();
    });
  }
  stopWatching() {
    if (this.unwatch !== null) {
      this.unwatch();
      this.unwatch = null;
    }
  }
  /**
   * Disarm the timeline.
   *
   * @param stopPlaying - cut a filler that is being heard right now. Off by
   *        default: the answer simply queues behind it.
   */
  cancel(stopPlaying = false) {
    this.cancelled = true;
    this.clearTimers();
    this.stopWatching();
    if (stopPlaying && Date.now() < this.playingUntil) this.speaker.stop();
  }
  /** Whether a filler is audible right now. */
  playingNow() {
    return Date.now() < this.playingUntil;
  }
  /**
   * Play one step.
   *
   * The answer may have started speaking between the timer firing and the clip
   * arriving — that is what the cancelled/speaking checks are for.
   */
  async play(step) {
    if (this.cancelled) return;
    if (!readVoiceEnabled()) return;
    if (isUserTalking()) return;
    if (this.speaker.speaking) return;
    if (step.group === "thinking" && spokenAt >= this.base) return;
    const clip = await fetchFiller(step.group);
    if (clip === null || this.cancelled) return;
    if (this.speaker.speaking) return;
    const duration = wavDurationMs2(clip);
    step.played = true;
    this.playingUntil = Date.now() + duration;
    this.speaker.speak(clip);
  }
  clearTimers() {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];
  }
};
function wavDurationMs2(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44) return 0;
    const byteRate = view.getUint32(28, true);
    const dataBytes = view.getUint32(40, true);
    if (byteRate <= 0) return 0;
    return Math.round(dataBytes / byteRate * 1e3);
  } catch {
    return 0;
  }
}
var spokenAt = 0;
function noteRealSpeech() {
  spokenAt = Date.now();
}
var current = null;
var lastArmRequest = 0;
function startFillerTimeline(speaker) {
  if (current === null) current = new FillerTimeline(speaker);
  if (Date.now() - lastArmRequest < 2e3) return;
  lastArmRequest = Date.now();
  current.start();
}
function cancelFillerTimeline(stopPlaying = false) {
  current?.cancel(stopPlaying);
}
function fillerPlaying() {
  return current !== null && current.playingNow();
}

// src/client/voice/stop-trace.ts
init_bridge();
var TRACE_URL = "/api/debug/dom";
function noteStop(tag, detail) {
  try {
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} stop(${tag})${detail === void 0 ? "" : " " + JSON.stringify(detail)}`;
    void fetch(`${bridgeBase()}${TRACE_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line })
    }).catch(() => void 0);
  } catch {
  }
}

// src/client/voice/clean.ts
var FENCED_BLOCK = /```[\s\S]*?```/g;
var INLINE_CODE = /`[^`\n]*`/g;
var URL2 = /https?:\/\/[^\s)\]]+/g;
var HEADING = /^#{1,6}\s+/gm;
var QUOTE = /^>\s?/gm;
var LIST_MARK = /^[-*+]\s+/gm;
var EMPHASIS = /[*_~]{1,3}/g;
var WHITESPACE = /\s+/g;
function cleanReplyText(text, maxChars = 400) {
  const out = text.replace(FENCED_BLOCK, " ").replace(INLINE_CODE, " ").replace(URL2, " ").replace(HEADING, "").replace(QUOTE, "").replace(LIST_MARK, "").replace(EMPHASIS, "").replace(WHITESPACE, " ").trim();
  if (out.length <= maxChars) return out;
  const cut = out.slice(0, maxChars);
  const boundary = Math.max(
    cut.lastIndexOf("\u3002"),
    cut.lastIndexOf("\uFF01"),
    cut.lastIndexOf("\uFF1F"),
    cut.lastIndexOf("."),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("?")
  );
  return boundary > maxChars * 0.5 ? `${cut.slice(0, boundary + 1)}\u2026` : `${cut}\u2026`;
}

// src/client/voice/sentences.ts
var TERMINATORS = /* @__PURE__ */ new Set(["\u3002", "\uFF01", "\uFF1F", "!", "?", "\u2026"]);
function isTrivial(sentence) {
  if (sentence.length <= 1) return true;
  return !/[\u4e00-\u9fff0-9a-zA-Z]/.test(sentence);
}
var SOFT_BREAKS = /* @__PURE__ */ new Set(["\n", "\uFF1B", ";"]);
var MIN_SOFT_CHUNK = 10;
var MAX_CHUNK_CHARS = 60;
function splitLongChunk(chunk) {
  if (chunk.length <= MAX_CHUNK_CHARS) return [chunk];
  const parts = [];
  let buf = "";
  for (const ch of chunk) {
    buf += ch;
    if ((ch === "\uFF0C" || ch === "," || ch === "\u3001") && buf.length >= MAX_CHUNK_CHARS / 2) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim() !== "") parts.push(buf.trim());
  return parts.filter((p) => p !== "" && !isTrivial(p));
}
function splitSentences(text) {
  const sentences = [];
  let buf = "";
  const flush = (minLen) => {
    const trimmed = buf.trim();
    if (trimmed === "" || isTrivial(trimmed)) {
      buf = "";
      return;
    }
    if (trimmed.length < minLen) return;
    buf = "";
    for (const piece of splitLongChunk(trimmed)) sentences.push(piece);
  };
  for (const ch of text) {
    buf += ch;
    if (TERMINATORS.has(ch)) flush(1);
    else if (SOFT_BREAKS.has(ch)) flush(MIN_SOFT_CHUNK);
  }
  const partial = buf.trim();
  return { sentences, partial: partial === "" || isTrivial(partial) ? null : partial };
}

// src/client/voice/narrate.ts
init_bridge();
var NARRATE_FLOOR_MS = 13e3;
var NARRATE_GAP_MS = 3e3;
var NARRATE_QUIET_MS = 1500;
var REASONING_TAIL = 700;
var ARG_CHARS = 90;
var LINE_MAX_CHARS = 80;
function narrateBase() {
  try {
    return localStorage.getItem("s2s.voice.narrate")?.trim() || "http://127.0.0.1:8767";
  } catch {
    return "http://127.0.0.1:8767";
  }
}
function phaseOf(name) {
  const lower = name.toLowerCase();
  if (/bash|pwsh|powershell|shell|terminal|command|exec/.test(lower)) return "\u8FD0\u884C\u547D\u4EE4";
  if (/write|edit|patch|create|mkdir|save|fs_/.test(lower)) return "\u5199\u5165";
  if (/image|vision|screenshot|photo/.test(lower)) return "\u67E5\u770B\u56FE\u7247";
  return "\u8C03\u7528\u5DE5\u5177";
}
function isQuestion(name) {
  return /ask_user|question|ask_user_question/i.test(name);
}
function questionTexts(argsRaw) {
  if (argsRaw.trim() === "") return [];
  let args;
  try {
    args = JSON.parse(argsRaw);
  } catch {
    return [];
  }
  const text = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const bag = args;
  const single = text(bag.question) || text(bag.text) || text(bag.prompt);
  if (single !== "") return [single];
  const list = Array.isArray(bag.questions) ? bag.questions : [];
  return list.map((entry) => text(entry?.question)).filter((part) => part !== "");
}
function argsText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === void 0) return "";
  const view = value;
  if (typeof view.text === "string") return view.text;
  if (view.object !== void 0 && view.object !== null) {
    try {
      return JSON.stringify(view.object);
    } catch {
      return "";
    }
  }
  if (typeof view.value === "string") return view.value;
  return "";
}
function nodeArgs(root) {
  return argsText(root.argsRaw) || argsText(root.args);
}
function blockArgs(block) {
  const loose = block;
  return argsText(loose.argsRaw) || argsText(loose.arguments) || argsText(loose.args);
}
function collectCalls(nodes, minAnchor, turnAnchor) {
  const calls = [];
  for (const node of nodes) {
    if (node.anchorSeq <= minAnchor) continue;
    if (turnAnchor > 0 && node.anchorSeq < turnAnchor) continue;
    if (node.kind === "tool-call") {
      const root = node.data?.root;
      if (root === void 0) continue;
      const name = typeof root.name === "string" ? root.name : "";
      const callId = typeof root.callId === "string" ? root.callId : "";
      calls.push({
        id: callId !== "" ? `call:${callId}` : `node:${node.key}`,
        name,
        args: nodeArgs(root),
        anchor: node.anchorSeq
      });
      continue;
    }
    if (node.kind !== "assistant-step") continue;
    const blocks = blocksOf(node);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block === void 0 || block.kind !== "tool-call") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const callId = typeof block.callId === "string" ? block.callId : "";
      calls.push({
        id: callId !== "" ? `call:${callId}` : `block:${node.key}#${index}`,
        name,
        args: blockArgs(block),
        anchor: node.anchorSeq
      });
    }
  }
  return calls;
}
function callLabel(name, argsRaw) {
  const raw = argsRaw.replace(/\s+/g, " ").trim();
  if (raw === "") return `${name}()`;
  return `${name}(${raw.slice(0, ARG_CHARS)})`;
}
function blocksOf(node) {
  const data = node.data;
  if (data === void 0 || data === null) return [];
  const blocks = data.blocks;
  return Array.isArray(blocks) ? blocks : [];
}
function formalText(steps, minAnchor, turnAnchor) {
  const parts = [];
  for (const node of steps) {
    if (node.anchorSeq <= minAnchor) continue;
    if (turnAnchor > 0 && node.anchorSeq < turnAnchor) continue;
    const text = visibleText(blocksOf(node));
    if (text !== "") parts.push(text);
  }
  return parts.join(" ");
}
function visibleText(blocks) {
  return blocks.filter((block) => block?.kind === "text" && typeof block.text === "string").map((block) => block.text).join(" ");
}
function firstSentence(text) {
  const clean = stripUnspoken(text.replace(/\s+/g, " ").trim()).replace(/^["“「]|["”」]$/g, "");
  if (clean.length <= LINE_MAX_CHARS) return clean;
  const { sentences } = splitSentences(clean);
  const first = sentences[0] ?? clean;
  return first.slice(0, LINE_MAX_CHARS);
}
function wavDurationMs3(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44) return 0;
    const byteRate = view.getUint32(28, true);
    const dataBytes = view.getUint32(40, true);
    if (byteRate <= 0) return 0;
    return Math.round(dataBytes / byteRate * 1e3);
  } catch {
    return 0;
  }
}
var ProgressNarrator = class {
  /** Tool calls already looked at (spoken, or deliberately skipped). */
  seen = /* @__PURE__ */ new Set();
  /** The last question spoken (the same sentence is never repeated). */
  lastQuestion = "";
  /** No narration before this instant (the clip's own length + the gap). */
  quietUntil = 0;
  /** When the last narration actually started (0 = none yet this session). */
  lastLineAt = 0;
  inFlight = false;
  /** Pending retry timer for a narration a gate turned away (see `retryLater`). */
  retryTimer = null;
  /**
   * A line that is ready to be spoken but had to wait for a gate.
   *
   * The scan marks its tool call seen as soon as it builds the material, so a
   * later retry would find nothing left to narrate and the phase would vanish.
   * The material is kept here instead and spoken on the retry.
   */
  pending = null;
  /** The turn `pending` belongs to: a new user message makes it stale. */
  pendingTurn = 0;
  /** The arguments of the last observe(), so a retry can look at the same view. */
  lastNodes = [];
  lastSpeaker = null;
  lastClaim = null;
  lastMinAnchor = 0;
  lastTurnStart = 0;
  /**
   * Look at the current snapshot and narrate a finished thinking phase.
   *
   * @param nodes - the rendered chat nodes.
   * @param speaker - the shared player.
   * @param claimSpeaker - takes the speaker over before speaking.
   * @param minAnchor - history cut-off: nothing at or below it is spoken.
   * @param turnStart - when the user's message went out (0 = unknown): the
   *        first narration waits NARRATE_FLOOR_MS after it.
   */
  observe(nodes, speaker, claimSpeaker, minAnchor = 0, turnStart = 0) {
    this.lastNodes = nodes;
    this.lastSpeaker = speaker;
    this.lastClaim = claimSpeaker;
    this.lastMinAnchor = minAnchor;
    this.lastTurnStart = turnStart;
    if (!readVoiceEnabled()) return;
    if (isUserTalking() || quietForMs() < NARRATE_QUIET_MS) {
      if (!isUserTalking()) {
        this.retryLater(
          NARRATE_QUIET_MS - quietForMs() + 100,
          nodes,
          speaker,
          claimSpeaker,
          minAnchor,
          turnStart
        );
      }
      return;
    }
    const steps = nodes.filter((node) => node.kind === "assistant-step").sort((a, b) => a.anchorSeq - b.anchorSeq);
    if (steps.length === 0) return;
    let turnAnchor = 0;
    for (const node of nodes) {
      if (node.kind !== "user") continue;
      if (node.anchorSeq > turnAnchor) turnAnchor = node.anchorSeq;
    }
    if (turnAnchor !== this.pendingTurn) {
      this.pending = null;
      this.pendingTurn = turnAnchor;
    }
    const questions = this.findQuestions(nodes, minAnchor, turnAnchor);
    if (questions.length > 0) {
      const formal = formalText(steps, minAnchor, turnAnchor);
      if (formal !== "" && !repliedInTurn(turnAnchor)) return;
      void this.speakQuestions(questions, speaker, claimSpeaker, turnAnchor);
      return;
    }
    const floorFrom = turnStart > 0 ? turnStart : 0;
    const beforeFloor = floorFrom === 0 ? false : Date.now() < floorFrom + NARRATE_FLOOR_MS;
    const calls = [];
    let reasoning = "";
    let candidate = null;
    for (const node of steps) {
      if (node.anchorSeq <= minAnchor) continue;
      if (turnAnchor > 0 && node.anchorSeq < turnAnchor) continue;
      const blocks = blocksOf(node);
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block === void 0) continue;
        if (block.kind === "reasoning") {
          if (typeof block.text === "string" && block.text !== "") {
            reasoning = reasoning === "" ? block.text : `${reasoning} ${block.text}`;
          }
          continue;
        }
        if (block.kind !== "tool-call") continue;
        const name = typeof block.name === "string" ? block.name : "";
        const argsRaw = typeof block.argsRaw === "string" ? block.argsRaw : "";
        if (isQuestion(name)) {
          reasoning = "";
          calls.length = 0;
          continue;
        }
        const key = `${node.key}#${index}`;
        if (this.seen.has(key)) {
          if (reasoning !== "") reasoning = "";
          continue;
        }
        const phase = reasoning.replace(/\s+/g, " ").trim();
        if (candidate === null) {
          if (beforeFloor) {
            this.retryLater(
              floorFrom + NARRATE_FLOOR_MS - Date.now() + 50,
              nodes,
              speaker,
              claimSpeaker,
              minAnchor,
              turnStart
            );
            continue;
          }
          const done = [...calls];
          const lines = [
            done.length > 0 ? `\u4E0A\u4E00\u6BB5\u601D\u8003\u4E4B\u540E\u505A\u7684\u4E8B\uFF1A${done.join("\uFF1B")}` : "\u8FD8\u6CA1\u6709\u505A\u5B8C\u4EFB\u4F55\u4E00\u6B65",
            `\u73B0\u5728\u5F00\u59CB\u505A\uFF1A${phaseOf(name)} \u2014\u2014 ${callLabel(name, argsRaw)}`
          ];
          if (phase !== "") {
            lines.push(
              `\u8FD9\u6BB5\u601D\u8003\u7684\u5185\u5BB9\uFF08\u82F1\u6587\u539F\u6837\uFF0C\u53EA\u4F9B\u7406\u89E3\uFF0C\u4E0D\u8981\u7167\u6284\uFF0C\u4E5F\u4E0D\u8981\u63D0\u5230\u5B83\uFF09\uFF1A${phase.slice(-REASONING_TAIL)}`
            );
          }
          candidate = { key, material: lines.join("\n") };
          this.seen.add(key);
          calls.length = 0;
          reasoning = "";
          continue;
        }
        this.seen.add(key);
        reasoning = "";
        calls.push(callLabel(name, argsRaw));
      }
    }
    if (candidate !== null) this.pending = { material: candidate.material };
    const owed = this.pending;
    if (owed === null) return;
    if (this.inFlight) {
      this.retryLater(1500, nodes, speaker, claimSpeaker, minAnchor, turnStart);
      return;
    }
    if (speaker.speaking) {
      this.retryLater(1500, nodes, speaker, claimSpeaker, minAnchor, turnStart);
      return;
    }
    if (Date.now() < this.quietUntil) {
      this.retryLater(this.quietUntil - Date.now() + 50, nodes, speaker, claimSpeaker, minAnchor, turnStart);
      return;
    }
    this.pending = null;
    this.inFlight = true;
    void (async () => {
      try {
        const line = await this.generate(owed.material);
        if (line === null || line === "") return;
        const wav = await tts(line);
        if (wav.byteLength === 0) return;
        cancelFillerTimeline(false);
        claimSpeaker();
        noteRealSpeech();
        speaker.speak(wav);
        this.lastLineAt = Date.now();
        this.quietUntil = Date.now() + wavDurationMs3(wav) + NARRATE_GAP_MS;
      } catch (err) {
        console.warn("[ui-voice] narration failed:", err);
      } finally {
        this.inFlight = false;
      }
    })();
  }
  /**
   * Run `observe` again after `delayMs`, unless something already did.
   *
   * One timer only: the newest attempt wins, so a burst of snapshots cannot
   * pile up timers.
   */
  retryLater(delayMs, nodes, speaker, claimSpeaker, minAnchor, turnStart) {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    const wait = Math.max(250, Math.min(delayMs + 60, 15e3));
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.observe(nodes, speaker, claimSpeaker, minAnchor, turnStart);
    }, wait);
  }
  /** Drop the pending retry (the view this watcher belonged to is gone). */
  dispose() {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pending = null;
  }
  /**
   * Find a question the agent asked and has not been read out yet.
   *
   * @param steps - the assistant steps, oldest first.
   * @param minAnchor - history cut-off.
   * @param turnAnchor - the current turn's first anchor.
   * @returns the question to speak, or null.
   */
  findQuestions(nodes, minAnchor, turnAnchor) {
    const found = [];
    for (const call of collectCalls(nodes, minAnchor, turnAnchor)) {
      if (!isQuestion(call.name)) continue;
      if (this.seen.has(call.id)) continue;
      const raw = questionTexts(call.args);
      if (raw.length === 0) {
        continue;
      }
      for (const one of raw) {
        const spoken = firstSentence(one);
        if (spoken === "") continue;
        if (spoken === this.lastQuestion) continue;
        found.push({ id: call.id, text: spoken });
      }
    }
    return found;
  }
  /**
   * Speak a question, cutting the formal content short.
   *
   * The truncation follows the house rule: the sentences still queued are
   * dropped, the one being heard plays out, and the question follows it.
   */
  async speakQuestions(questions, speaker, claimSpeaker, turnAnchor) {
    for (const question of questions) {
      this.seen.add(question.id);
      this.lastQuestion = question.text;
    }
    cancelFillerTimeline(false);
    speaker.finishCurrent();
    claimSpeaker();
    noteRealSpeech();
    noteQuestionSpoken(turnAnchor);
    let totalMs = 0;
    for (const question of questions) {
      try {
        console.log("[ui-voice] question to read:", question.text);
        const wav = await tts(question.text);
        if (wav.byteLength === 0) continue;
        speaker.speak(wav);
        totalMs += wavDurationMs3(wav);
      } catch (err) {
        console.warn("[ui-voice] question playback failed:", err);
      }
    }
    if (totalMs > 0) this.quietUntil = Date.now() + totalMs + NARRATE_GAP_MS;
  }
  /**
   * Ask the node half for one sentence.
   *
   * @param material - what has been done / is being done / the reasoning tail.
   * @returns the sentence, or null when the node half is not answering.
   */
  async generate(material) {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2e4);
      const resp = await fetch(`${narrateBase()}/api/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ material }),
        signal: controller.signal
      });
      window.clearTimeout(timer);
      if (!resp.ok) return null;
      const body = await resp.json();
      const line = typeof body.line === "string" ? firstSentence(body.line) : "";
      return line === "" ? null : line;
    } catch {
      return null;
    }
  }
};

// src/client/voice/reply-listener.tsx
var VOICE_ENABLED_KEY = "s2s.voice.enabled";
function voiceEnabled() {
  try {
    return localStorage.getItem(VOICE_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}
function companionVisible() {
  try {
    return localStorage.getItem("s2s.voice.companion") !== "0";
  } catch {
    return true;
  }
}
function assistantData(node) {
  if (node.kind !== "assistant-step") return void 0;
  return node.data;
}
function nodeText(data) {
  return data.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n");
}
var ReplySpeakerMount = (0, import_react14.memo)(function ReplySpeakerMount2({
  useSession,
  useChat,
  speaker,
  claimSpeaker,
  _registerTtsAbort,
  _registerInterruptHandler
}) {
  const chat = useChat((s) => s);
  const chatRef = (0, import_react14.useRef)(chat);
  chatRef.current = chat;
  const snapshot = useSession((s) => s);
  const spokenRef = (0, import_react14.useRef)(/* @__PURE__ */ new Map());
  const baselineRef = (0, import_react14.useRef)(null);
  const chainRef = (0, import_react14.useRef)(Promise.resolve());
  const lastQueuedTurnRef = (0, import_react14.useRef)(null);
  const lastSeenUserAnchorRef = (0, import_react14.useRef)(0);
  const lastUserCountRef = (0, import_react14.useRef)(0);
  const genRef = (0, import_react14.useRef)(0);
  const nodeCacheRef = (0, import_react14.useRef)(/* @__PURE__ */ new Map());
  const interruptRef = (0, import_react14.useRef)(false);
  const skipAnchorRef = (0, import_react14.useRef)(0);
  const skipUntilRef = (0, import_react14.useRef)(0);
  const dhSentRef = (0, import_react14.useRef)(/* @__PURE__ */ new Set());
  const dhLastDebounceRef = (0, import_react14.useRef)(/* @__PURE__ */ new Map());
  const LAST_DEBOUNCE_MS = 4e3;
  const [bridgeDh, setBridgeDh] = (0, import_react14.useState)(null);
  const lastDhCodeRef = (0, import_react14.useRef)(null);
  const lastDhReplyAnchorRef = (0, import_react14.useRef)(0);
  const lastUserAnchorRef = (0, import_react14.useRef)(0);
  const lastAssistantAnchorRef = (0, import_react14.useRef)(0);
  const smallTalkFromAnchorRef = (0, import_react14.useRef)(null);
  const smallTalkSpokenRef = (0, import_react14.useRef)(/* @__PURE__ */ new Map());
  const smallTalkClipsRef = (0, import_react14.useRef)([]);
  const lastTurnAtRef = (0, import_react14.useRef)(0);
  const quietWaitRef = (0, import_react14.useRef)(null);
  const startedEmptyRef = (0, import_react14.useRef)(false);
  const lookedOnceRef = (0, import_react14.useRef)(false);
  const narratorRef = (0, import_react14.useRef)(null);
  if (narratorRef.current === null) narratorRef.current = new ProgressNarrator();
  (0, import_react14.useEffect)(() => {
    let timer = 0;
    const unsubscribe = onUserTalkingChange((talking) => {
      window.clearTimeout(timer);
      if (talking) return;
      timer = window.setTimeout(() => {
        narratorRef.current?.observe(
          chatNodes(chatRef.current),
          speaker,
          claimSpeaker,
          baselineRef.current ?? 0,
          lastTurnAtRef.current
        );
      }, 1600);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [speaker, claimSpeaker]);
  (0, import_react14.useEffect)(() => {
    _registerInterruptHandler(() => {
      interruptRef.current = true;
    });
    return () => _registerInterruptHandler(null);
  }, [_registerInterruptHandler]);
  (0, import_react14.useEffect)(() => () => {
    noteStop("reply-listener#stop-old-reply", { speaking: speaker.speaking });
    narratorRef.current?.dispose();
    speaker.finishCurrent();
    _registerTtsAbort(null);
    for (const { timer } of dhLastDebounceRef.current.values()) clearTimeout(timer);
    dhLastDebounceRef.current.clear();
    quietWaitRef.current?.();
    quietWaitRef.current = null;
  }, [speaker, _registerTtsAbort]);
  (0, import_react14.useEffect)(() => {
    let cancelled = false;
    const check2 = () => {
      const started = Date.now();
      void dhStatus().then((s) => {
        if (cancelled) return;
        if (s === null && Date.now() - started < 1e3) return;
        setBridgeDh(s?.enabled === true);
      }).catch(() => {
        if (!cancelled) setBridgeDh(false);
      });
      window.setTimeout(() => {
        if (!cancelled) setBridgeDh((prev) => prev === null ? false : prev);
      }, 4e3);
    };
    check2();
    const onChange = () => {
      window.setTimeout(check2, 200);
    };
    window.addEventListener(DH_CHANGE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(DH_CHANGE_EVENT, onChange);
    };
  }, []);
  (0, import_react14.useEffect)(() => {
    if (!voiceEnabled()) return;
    if (bridgeDh === null) return;
    const dhMode = bridgeDh && companionVisible() && readDigitalHuman();
    if (interruptRef.current) {
      if (dhMode) dhDiscard(lastDhCodeRef.current);
      let maxAnchor = 0;
      for (const node of chatNodes(chat)) {
        if (node.kind === "assistant-step" && node.anchorSeq > maxAnchor) maxAnchor = node.anchorSeq;
      }
      if (maxAnchor > 0) skipAnchorRef.current = maxAnchor;
      interruptRef.current = false;
      return;
    }
    let maxAssistantAnchor = 0;
    for (const node of chatNodes(chat)) {
      if (node.kind === "assistant-step" && node.anchorSeq > maxAssistantAnchor) maxAssistantAnchor = node.anchorSeq;
    }
    const previousAssistantAnchor = lastAssistantAnchorRef.current;
    lastAssistantAnchorRef.current = maxAssistantAnchor;
    if (baselineRef.current === null) {
      let maxSettled = 0;
      let hasSettled = false;
      let hasAnyAssistant = false;
      for (const node of chatNodes(chat)) {
        if (node.kind !== "assistant-step") continue;
        const data = assistantData(node);
        if (data === void 0) continue;
        hasAnyAssistant = true;
        if (data.status !== "settled") continue;
        hasSettled = true;
        if (node.anchorSeq > maxSettled) maxSettled = node.anchorSeq;
      }
      if (hasSettled) {
        baselineRef.current = maxSettled;
        skipUntilRef.current = maxSettled;
      } else if (hasAnyAssistant) {
        baselineRef.current = 0;
        skipUntilRef.current = 0;
      } else {
        return;
      }
    }
    narratorRef.current?.observe(
      chatNodes(chat),
      speaker,
      claimSpeaker,
      baselineRef.current ?? 0,
      lastTurnAtRef.current
    );
    const seenUserAnchor = lastSeenUserAnchorRef.current;
    let maxUserAnchor = seenUserAnchor;
    let userCount = 0;
    for (const node of chatNodes(chat)) {
      if (node.kind !== "user") continue;
      userCount += 1;
      if (node.anchorSeq > maxUserAnchor) maxUserAnchor = node.anchorSeq;
    }
    if (maxUserAnchor !== seenUserAnchor || userCount !== lastUserCountRef.current) {
      lastUserCountRef.current = userCount;
      console.log("[ui-voice] snapshot:", { users: userCount, maxUserAnchor, seen: seenUserAnchor, speaking: speaker.speaking });
    }
    if (!lookedOnceRef.current) {
      lookedOnceRef.current = true;
      startedEmptyRef.current = userCount === 0;
    }
    if (maxUserAnchor > seenUserAnchor) {
      const genuine = seenUserAnchor > 0 || startedEmptyRef.current;
      const armTurn = () => {
        if (!genuine) return;
        lastTurnAtRef.current = Date.now();
        startFillerTimeline(speaker);
      };
      if (speaker.speaking) {
        const stop = speaker.subscribe(() => {
          if (speaker.speaking) return;
          stop();
          if (quietWaitRef.current === stop) quietWaitRef.current = null;
          armTurn();
        });
        quietWaitRef.current?.();
        quietWaitRef.current = stop;
      } else {
        armTurn();
      }
      const prepared = genuine ? takePendingSmallTalkAudio() : null;
      if (prepared !== null && prepared.length > 0) {
        console.log("[ui-voice] cached opener audio: playing with this message");
        window.setTimeout(() => {
          if (speaker.speaking) return;
          noteSmallTalkAudioQueued(prepared);
          noteRealSpeech();
          for (const wav of prepared) speaker.speak(wav);
        }, 1500);
      }
      let onlyOpeners = true;
      for (const node of chatNodes(chat)) {
        if (node.kind !== "user") continue;
        if (node.anchorSeq <= seenUserAnchor) continue;
        if (!isSmallTalkLine(userNodeText(node))) onlyOpeners = false;
      }
      lastSeenUserAnchorRef.current = maxUserAnchor;
      let newestIsOpener = true;
      for (const node of chatNodes(chat)) {
        if (node.kind !== "user") continue;
        if (node.anchorSeq !== maxUserAnchor) continue;
        newestIsOpener = isSmallTalkLine(userNodeText(node));
      }
      if (!newestIsOpener) retireOpener();
      if (seenUserAnchor > 0 && onlyOpeners) {
        console.log("[ui-voice] new user message: an opener landed, keeping the audio");
      } else if (seenUserAnchor > 0) {
        if (smallTalkAudioPlaying()) {
          console.log("[ui-voice] new user message: keeping the small talk audio");
        } else {
          console.log("[ui-voice] new user message: stopping the old reply, speaking =", speaker.speaking);
          noteStop("reply-listener.tsx#2", { speaking: speaker.speaking });
          speaker.finishCurrent();
          genRef.current += 1;
          chainRef.current = Promise.resolve();
        }
      }
    }
    const speakJobs = (queue) => {
      if (queue.length === 0) return;
      chainRef.current = queue.reduce(
        (chain, job) => chain.then(() => {
          if (interruptRef.current || !voiceEnabled()) return;
          if (questionAskedInTurn(job.turn)) return;
          const generation = genRef.current;
          const controller = new AbortController();
          _registerTtsAbort(controller);
          return tts(job.sentence, controller.signal).then((wav) => {
            if (interruptRef.current || !voiceEnabled()) return;
            if (generation !== genRef.current) return;
            cancelFillerTimeline(false);
            claimSpeaker();
            noteRealSpeech();
            noteReplySpoken(job.turn);
            speaker.speak(wav);
            window.setTimeout(() => {
              narratorRef.current?.observe(
                chatNodes(chatRef.current),
                speaker,
                claimSpeaker,
                baselineRef.current ?? 0,
                lastTurnAtRef.current
              );
            }, 0);
          }).catch((err) => {
            if (err?.name !== "AbortError") {
              console.error("[ui-voice] reply TTS failed:", err);
            }
          }).finally(() => _registerTtsAbort(null));
        }),
        chainRef.current
      );
    };
    const synthesizeJobs = (queue, onClip) => {
      if (queue.length === 0) return;
      chainRef.current = queue.reduce(
        (chain, job) => chain.then(() => {
          if (interruptRef.current || !voiceEnabled()) return;
          const generation = genRef.current;
          const controller = new AbortController();
          _registerTtsAbort(controller);
          return tts(job.sentence, controller.signal).then((wav) => {
            if (generation !== genRef.current) return;
            onClip(wav);
          }).catch((err) => {
            if (err?.name !== "AbortError") {
              console.error("[ui-voice] small talk TTS failed:", err);
            }
          }).finally(() => _registerTtsAbort(null));
        }),
        chainRef.current
      );
    };
    if (isSmallTalkArmed()) {
      const nodes2 = chatNodes(chat);
      let openerAnchor = -1;
      let nextUserAnchor = Number.POSITIVE_INFINITY;
      for (const node of nodes2) {
        if (node.kind !== "user") continue;
        if (isSmallTalkLine(userNodeText(node))) {
          if (node.anchorSeq > openerAnchor) openerAnchor = node.anchorSeq;
        }
      }
      if (openerAnchor < 0) {
        return;
      }
      for (const node of nodes2) {
        if (node.kind !== "user") continue;
        if (node.anchorSeq > openerAnchor && node.anchorSeq < nextUserAnchor) {
          nextUserAnchor = node.anchorSeq;
        }
      }
      let target = null;
      for (const node of nodes2) {
        if (node.kind !== "assistant-step") continue;
        if (node.anchorSeq <= openerAnchor) continue;
        if (node.anchorSeq > nextUserAnchor) continue;
        const data = assistantData(node);
        if (data === void 0) continue;
        const text = cleanReplyText(nodeText(data), 1e5);
        if (target === null || node.anchorSeq > target.anchor) {
          target = { key: node.key, anchor: node.anchorSeq, text, settled: data.status === "settled" };
        }
      }
      if (target === null) {
        if (nextUserAnchor !== Number.POSITIVE_INFINITY) {
          disarmSmallTalk();
          smallTalkFromAnchorRef.current = null;
          smallTalkSpokenRef.current.clear();
          smallTalkClipsRef.current = [];
        }
        return;
      }
      if (target.anchor < maxUserAnchor) {
        disarmSmallTalk();
        smallTalkFromAnchorRef.current = null;
        smallTalkSpokenRef.current.clear();
      } else {
        const { clauses, partial } = splitClauses(target.text);
        const speakable = target.settled && partial !== null ? [...clauses, partial] : clauses;
        const record = smallTalkSpokenRef.current.get(target.key) ?? { count: 0, forced: false, picked: false };
        const joinedLength = speakable.join("\uFF0C").length;
        if (!record.picked && speakable.length > 0 && (target.settled || joinedLength >= CLAUSE_MAX_CHARS)) {
          const picked = pickOpeningPhrase(speakable, target.settled);
          if (picked !== null) {
            record.picked = true;
            console.log("[ui-voice] small talk opening:", picked);
            synthesizeJobs([{ sentence: picked }], (wav) => {
              smallTalkClipsRef.current = [wav];
              setPendingSmallTalkAudio([wav]);
              markOpenerReplyCaptured();
            });
          }
        }
        smallTalkSpokenRef.current.set(target.key, record);
        if (target.settled && speakable.length > 0) {
          disarmSmallTalk();
          smallTalkFromAnchorRef.current = null;
          rememberSmallTalkReplyText(target.text);
          const { sentences, partial: tail } = splitSentences(target.text);
          spokenRef.current.set(target.key, sentences.length + (tail !== null ? 1 : 0));
          const clips = smallTalkClipsRef.current;
          smallTalkClipsRef.current = [];
          if (clips.length > 0) {
            setPendingSmallTalkAudio(clips);
            markOpenerReplyCaptured();
          }
        }
        return;
      }
    }
    if (dhMode) {
      for (const node of chatNodes(chat)) {
        if (node.kind !== "user") continue;
        if (node.anchorSeq <= lastUserAnchorRef.current) continue;
        lastUserAnchorRef.current = node.anchorSeq;
        if (lastDhReplyAnchorRef.current > 0 && node.anchorSeq > lastDhReplyAnchorRef.current) {
          dhDiscard(lastDhCodeRef.current);
        }
      }
      const userAnchors2 = [];
      for (const node of chatNodes(chat)) {
        if (node.kind === "user") userAnchors2.push(node.anchorSeq);
      }
      userAnchors2.sort((a, b) => a - b);
      const perUserTurn = /* @__PURE__ */ new Map();
      for (const node of chatNodes(chat)) {
        if (node.kind !== "assistant-step") continue;
        const data = assistantData(node);
        if (data === void 0 || data.status !== "settled") continue;
        const text = cleanReplyText(nodeText(data), 1e5);
        if (text.trim().length < 2) continue;
        let ua = -1;
        for (const u of userAnchors2) {
          if (u < node.anchorSeq) ua = u;
          else break;
        }
        const pick = { node, data, anchor: node.anchorSeq };
        const slot = perUserTurn.get(ua);
        if (slot === void 0) {
          perUserTurn.set(ua, { first: pick, last: pick });
        } else {
          if (node.anchorSeq < slot.first.anchor) slot.first = pick;
          if (node.anchorSeq > slot.last.anchor) slot.last = pick;
        }
      }
      const submitDh = (pick) => {
        const base = baselineRef.current;
        if (base !== null && pick.anchor <= base) return;
        if (pick.anchor === skipAnchorRef.current) return;
        if (dhSentRef.current.has(pick.node.key)) return;
        const text = cleanReplyText(nodeText(pick.data), 1e5);
        if (text.trim().length < 2) return;
        dhSentRef.current.add(pick.node.key);
        lastDhReplyAnchorRef.current = pick.anchor;
        void dhSpeak(text).then((code) => {
          if (code !== null) lastDhCodeRef.current = code;
        });
      };
      for (const [ua, { first, last }] of perUserTurn) {
        submitDh(first);
        if (first.node.key === last.node.key) {
          const existing2 = dhLastDebounceRef.current.get(ua);
          if (existing2 !== void 0) {
            clearTimeout(existing2.timer);
            dhLastDebounceRef.current.delete(ua);
          }
          continue;
        }
        const existing = dhLastDebounceRef.current.get(ua);
        if (existing !== void 0) clearTimeout(existing.timer);
        const timer = setTimeout(() => {
          dhLastDebounceRef.current.delete(ua);
          submitDh(last);
        }, LAST_DEBOUNCE_MS);
        dhLastDebounceRef.current.set(ua, { timer, anchor: last.anchor });
      }
      return;
    }
    const jobs = [];
    const nodes = chatNodes(chat);
    const userAnchors = nodes.filter((n) => n.kind === "user").map((n) => n.anchorSeq).sort((a, b) => a - b);
    const turnOf = (anchor) => {
      let turn = 0;
      for (const ua of userAnchors) {
        if (ua < anchor) turn = ua;
        else break;
      }
      return turn;
    };
    for (const node of nodes) {
      if (node.kind !== "assistant-step") continue;
      const snapshot2 = assistantData(node);
      if (snapshot2 !== void 0) {
        nodeCacheRef.current.set(node.key, { anchor: node.anchorSeq, text: nodeText(snapshot2) });
      }
      if (node.anchorSeq <= skipUntilRef.current) continue;
      if (node.anchorSeq === skipAnchorRef.current) continue;
      const data = assistantData(node);
      if (data === void 0 || data.status === "interrupted") continue;
      const { sentences, partial } = splitSentences(cleanReplyText(nodeText(data), 1e5));
      const speakable = data.status === "settled" && partial !== null ? [...sentences, partial] : sentences;
      const spoken = spokenRef.current.get(node.key) ?? 0;
      if (speakable.length > spoken) {
        for (let i = spoken; i < speakable.length; i++) {
          jobs.push({
            anchor: node.anchorSeq,
            turn: turnOf(node.anchorSeq),
            key: node.key,
            index: i,
            sentence: speakable[i]
          });
        }
        spokenRef.current.set(node.key, speakable.length);
      }
    }
    const visibleKeys = new Set(nodes.filter((n) => n.kind === "assistant-step").map((n) => n.key));
    for (const [key, cached] of [...nodeCacheRef.current]) {
      if (visibleKeys.has(key)) continue;
      if (cached.anchor <= skipUntilRef.current || cached.anchor === skipAnchorRef.current) {
        nodeCacheRef.current.delete(key);
        continue;
      }
      const { sentences, partial } = splitSentences(cleanReplyText(cached.text, 1e5));
      const speakable = partial !== null ? [...sentences, partial] : sentences;
      const spoken = spokenRef.current.get(key) ?? 0;
      if (speakable.length > spoken) {
        for (let i = spoken; i < speakable.length; i++) {
          jobs.push({
            anchor: cached.anchor,
            turn: turnOf(cached.anchor),
            key,
            index: i,
            sentence: speakable[i]
          });
        }
        spokenRef.current.set(key, speakable.length);
        console.log("[ui-voice] collapsed node: finishing its remaining sentences");
      }
      nodeCacheRef.current.delete(key);
    }
    if (jobs.length === 0) return;
    jobs.sort((a, b) => a.anchor - b.anchor || a.index - b.index);
    const newestTurn = jobs[jobs.length - 1].turn;
    if (lastQueuedTurnRef.current !== null && newestTurn > lastQueuedTurnRef.current) {
      if (smallTalkAudioPlaying() || fillerPlaying()) {
        console.log("[ui-voice] preempt: newer turn, a short clip is still playing");
        chainRef.current = Promise.resolve();
      } else {
        console.log("[ui-voice] preempt: newer turn, restarting from its first sentence");
        noteStop("reply-listener.tsx#3", { speaking: speaker.speaking });
        speaker.finishCurrent();
        chainRef.current = Promise.resolve();
      }
    }
    if (newestTurn > (lastQueuedTurnRef.current ?? -1)) lastQueuedTurnRef.current = newestTurn;
    speakJobs(jobs.map((job) => ({ sentence: job.sentence, turn: job.turn })));
  }, [chat, speaker, _registerTtsAbort, bridgeDh]);
  return null;
});

// src/client/voice/speaker.ts
var ReplySpeaker = class {
  ctx = null;
  queue = [];
  playing = null;
  drainRunning = false;
  gen = 0;
  disposed = false;
  listeners = /* @__PURE__ */ new Set();
  /** True while a reply is being read (playing or waiting in the queue). */
  get speaking() {
    return this.playing !== null || this.queue.length > 0;
  }
  /** Subscribe to speaking-state changes; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit() {
    for (const listener of this.listeners) listener();
  }
  /** Enqueue one clip for playback (order preserved; plays after earlier clips). */
  speak(wav) {
    if (this.disposed) return;
    this.queue.push(wav);
    this.emit();
    void this.drain();
  }
  /**
   * Resume the context if the browser suspended it.
   *
   * Called before every drain attempt: a suspended context plays nothing and
   * never reports an end, which is what left the queue stuck.
   */
  async ensureRunning(ctx) {
    if (ctx.state !== "suspended") return;
    try {
      await ctx.resume();
    } catch {
    }
  }
  async drain() {
    if (this.drainRunning) return;
    this.drainRunning = true;
    try {
      const ctx = this.ctx ?? (this.ctx = new AudioContext());
      await this.ensureRunning(ctx);
      while (this.queue.length > 0 && !this.disposed) {
        const wav = this.queue.shift();
        await this.playOne(ctx, wav);
      }
    } finally {
      this.drainRunning = false;
      this.emit();
    }
  }
  playOne(ctx, wav) {
    const gen = this.gen;
    return new Promise((resolve) => {
      void ctx.decodeAudioData(wav).then((buffer) => {
        if (this.disposed || gen !== this.gen) {
          resolve();
          return;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        this.playing = source;
        this.emit();
        const guard = window.setTimeout(() => {
          if (this.playing !== source) return;
          try {
            source.stop();
          } catch {
          }
          this.playing = null;
          this.emit();
          resolve();
        }, Math.max(2e3, buffer.duration * 1e3 + 4e3));
        source.onended = () => {
          window.clearTimeout(guard);
          if (this.playing === source) {
            this.playing = null;
            this.emit();
          }
          resolve();
        };
        source.start();
      }).catch(() => resolve());
    });
  }
  /**
   * Let the clip that is playing finish, then go quiet.
   *
   * Sentences are synthesized one by one, so a new turn arriving between two
   * of them should not chop the one being heard: the queue is dropped, the
   * current clip plays to its end, and whatever comes next plays after it.
   */
  finishCurrent() {
    this.gen += 1;
    this.queue = [];
    this.emit();
  }
  /** Stop the current clip immediately and clear the queued ones. */
  stop() {
    this.gen += 1;
    if (this.playing !== null) {
      try {
        this.playing.stop();
      } catch {
      }
      this.playing = null;
    }
    this.queue = [];
    this.emit();
  }
  /** Release the AudioContext (plugin teardown). */
  dispose() {
    this.disposed = true;
    this.stop();
    if (this.ctx !== null) {
      void this.ctx.close().catch(() => {
      });
      this.ctx = null;
    }
    this.listeners.clear();
  }
};

// src/client/voice/companion.tsx
var import_react15 = require("react");
init_bridge();

// src/client/voice/CompanionWindow.module.css
var css4 = "\n\n.a4afede_card {\n  position: relative;\n}\n\n\n.a3e8d5d_handle {\n  position: absolute;\n  bottom: 0;\n  right: 0;\n  width: 22px;\n  height: 22px;\n  cursor: nwse-resize;\n  pointer-events: auto;\n  border-bottom-right-radius: 20px;\n  background: linear-gradient(135deg, transparent 52%, rgba(255, 255, 255, 0.28) 52%, rgba(255, 255, 255, 0.28) 62%, transparent 62%),\n    linear-gradient(135deg, transparent 52%, rgba(255, 255, 255, 0.18) 52%, rgba(255, 255, 255, 0.18) 62%, transparent 62%);\n  background-position: 0 0, 6px 6px;\n  background-repeat: no-repeat;\n  background-size: 16px 16px;\n  transition: background-color 0.2s ease;\n}\n\n.a3e8d5d_handle:hover {\n  background-color: rgba(255, 255, 255, 0.14);\n}\n\n\n.a003f62_dhCaption {\n  position: absolute;\n  bottom: 12px;\n  right: 50%;\n  transform: translateX(50%);\n  max-width: calc(100% - 24px);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  padding: 5px 12px;\n  border-radius: 999px;\n  background: rgba(0, 0, 0, 0.6);\n  color: rgba(255, 255, 255, 0.88);\n  font-size: 12px;\n  letter-spacing: 0.02em;\n  white-space: nowrap;\n  pointer-events: none;\n  z-index: 5;\n  backdrop-filter: blur(4px);\n}\n";
var tagId4 = "@beiyege-01/dsh-voice-ai-girlfriend/CompanionWindow.module.css";
if (typeof document !== "undefined") {
  const q = "style[data-plugin-css=" + JSON.stringify(tagId4) + "]";
  if (!document.querySelector(q)) {
    const el = document.createElement("style");
    el.dataset.plugin = "@beiyege-01/dsh-voice-ai-girlfriend";
    el.dataset.pluginCss = tagId4;
    el.textContent = css4;
    document.head.appendChild(el);
  }
}
var CompanionWindow_default = { "card": "a4afede_card", "handle": "a3e8d5d_handle", "dhCaption": "a003f62_dhCaption" };

// src/client/voice/companion.tsx
var import_jsx_runtime13 = require("react/jsx-runtime");
var WIDTH_KEY = "s2s.voice.companionW";
var POS_KEY2 = "s2s.voice.companionPos";
var MIN_WIDTH = 180;
var MAX_WIDTH = 480;
var DEFAULT_WIDTH = 260;
function readWidth() {
  try {
    const value = Number.parseFloat(localStorage.getItem(WIDTH_KEY) ?? "");
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return value;
  } catch {
  }
  return DEFAULT_WIDTH;
}
function readPos2() {
  try {
    const value = JSON.parse(localStorage.getItem(POS_KEY2) ?? "null");
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return { x: Math.round(value.x), y: Math.round(value.y) };
    }
  } catch {
  }
  return null;
}
function defaultPos(w, h) {
  return {
    x: Math.max(12, window.innerWidth - w - 12),
    y: Math.max(12, Math.round((window.innerHeight - h) / 2))
  };
}
var VIDEO_STYLE = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  transition: "opacity 0.8s ease",
  opacity: 0
};
var DH_SEG_STYLE = {
  position: "absolute",
  left: 12,
  bottom: 12,
  display: "flex",
  flexDirection: "column",
  gap: 5,
  minWidth: 132,
  maxWidth: "62%",
  padding: "7px 11px",
  borderRadius: 12,
  background: "rgba(10,11,16,0.74)",
  color: "rgba(255,255,255,0.9)",
  fontSize: 12,
  lineHeight: 1.2,
  letterSpacing: "0.02em",
  whiteSpace: "nowrap",
  pointerEvents: "none",
  zIndex: 6,
  backdropFilter: "blur(6px)"
};
var DH_SEG_BAR_STYLE = {
  display: "block",
  height: 3,
  borderRadius: 999,
  background: "rgba(255,255,255,0.18)",
  overflow: "hidden"
};
var DH_SEG_FILL_STYLE = {
  display: "block",
  height: "100%",
  borderRadius: 999,
  background: "rgba(255,255,255,0.88)",
  transition: "width 0.4s ease"
};
var DH_HINT_STYLE = {
  position: "absolute",
  left: 12,
  bottom: 12,
  maxWidth: "62%",
  padding: "7px 11px",
  borderRadius: 12,
  background: "rgba(120,72,8,0.82)",
  color: "#fde68a",
  fontSize: 12,
  lineHeight: 1.2,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  pointerEvents: "none",
  zIndex: 7,
  backdropFilter: "blur(6px)"
};
function dhSegText(dh) {
  const total = dh.total_segments || 0;
  const done = dh.done_segments || 0;
  if (dh.state === "done") {
    const n = total || done;
    return `\u6570\u5B57\u4EBA \xB7 ${n}/${n} \u6BB5 \u5DF2\u5B8C\u6210`;
  }
  if (dh.state === "error") return `\u6570\u5B57\u4EBA \xB7 \u5931\u8D25\uFF1A${dh.message || "\u751F\u6210\u51FA\u9519"}`;
  if (dh.state === "discarded") return "\u6570\u5B57\u4EBA \xB7 \u5DF2\u53D6\u6D88";
  if (total > 0) {
    const current2 = Math.min(done + 1, total);
    const phase = dh.state === "tts" ? " \u8BED\u97F3\u5408\u6210" : dh.state === "generating" ? " \u751F\u6210\u4E2D" : "";
    const extra = dh.pending > 0 ? `\uFF08\u6392\u961F ${dh.pending}\uFF09` : "";
    return `\u6570\u5B57\u4EBA \xB7 \u7B2C ${current2}/${total} \u6BB5${phase}${extra}`;
  }
  if (dh.duix?.state === "starting") return "\u6570\u5B57\u4EBA \xB7 DUIX \u5BB9\u5668\u542F\u52A8\u4E2D\u2026";
  return dh.message || "\u6570\u5B57\u4EBA\u751F\u6210\u4E2D\u2026";
}
var CompanionWindow = (0, import_react15.memo)(function CompanionWindow2({ speaker, companion }) {
  const [visible, setVisible] = (0, import_react15.useState)(companion.visible);
  const [widthPx, setWidthPx] = (0, import_react15.useState)(readWidth);
  const [pos, setPos] = (0, import_react15.useState)(readPos2);
  const [speaking, setSpeaking] = (0, import_react15.useState)(speaker.speaking);
  const [bgMedia, setBgMedia] = (0, import_react15.useState)([]);
  const [taskVideos, setTaskVideos] = (0, import_react15.useState)([]);
  const [bgImageUrl, setBgImageUrl] = (0, import_react15.useState)("");
  const [dh, setDh] = (0, import_react15.useState)(null);
  const [dhPlaying, setDhPlaying] = (0, import_react15.useState)(false);
  const dhPlayingRef = (0, import_react15.useRef)(false);
  const setDhPlayingBoth = (0, import_react15.useCallback)((v) => {
    dhPlayingRef.current = v;
    setDhPlaying(v);
  }, []);
  const bgA = (0, import_react15.useRef)(null);
  const bgB = (0, import_react15.useRef)(null);
  const bgActive = (0, import_react15.useRef)(true);
  const bgTransitioning = (0, import_react15.useRef)(false);
  const bgWired = (0, import_react15.useRef)(false);
  const bgIndexRef = (0, import_react15.useRef)(-1);
  const bgMediaRef = (0, import_react15.useRef)([]);
  const taskRef = (0, import_react15.useRef)(null);
  const taskIndexRef = (0, import_react15.useRef)(-1);
  const taskPlayingRef = (0, import_react15.useRef)(false);
  const taskPendingStopRef = (0, import_react15.useRef)(false);
  const wasSpeakingRef = (0, import_react15.useRef)(false);
  const dhRef = (0, import_react15.useRef)(null);
  const handledDhRef = (0, import_react15.useRef)(/* @__PURE__ */ new Set());
  const waitingDhRef = (0, import_react15.useRef)(null);
  const dhQueueRef = (0, import_react15.useRef)([]);
  const dhQueueCodeRef = (0, import_react15.useRef)("");
  const dhQueuePlayedRef = (0, import_react15.useRef)(0);
  const moveRef = (0, import_react15.useRef)(null);
  const posRef = (0, import_react15.useRef)(pos);
  const dragRef = (0, import_react15.useRef)(null);
  const heightPx = Math.round(Math.min(Math.max(widthPx * 1.5, 260), Math.min(560, window.innerHeight * 0.7)));
  const showBgMedia = (0, import_react15.useCallback)((index) => {
    const list = bgMediaRef.current;
    const entry = list[index];
    if (!entry) return;
    const a = bgA.current;
    const b = bgB.current;
    if (!a || !b) return;
    const src = `${bridgeBase()}/media/bg-images/${encodeURIComponent(entry.name)}`;
    if (entry.type === "video") {
      setBgImageUrl("");
      if (!bgWired.current) {
        bgWired.current = true;
        const vid = bgActive.current ? a : b;
        vid.src = src;
        vid.style.opacity = "1";
        vid.load();
        void vid.play().catch(() => {
        });
        return;
      }
      const from = bgActive.current ? a : b;
      const to = bgActive.current ? b : a;
      bgTransitioning.current = true;
      to.src = src;
      to.load();
      const startFade = () => {
        to.removeEventListener("canplay", startFade);
        bgActive.current = !bgActive.current;
        from.style.opacity = "0";
        to.style.opacity = "1";
        void to.play().catch(() => {
        });
        window.setTimeout(() => {
          bgTransitioning.current = false;
          from.pause();
        }, 900);
      };
      to.addEventListener("canplay", startFade);
      window.setTimeout(() => {
        if (bgTransitioning.current) startFade();
      }, 3e3);
      return;
    }
    a.style.opacity = "0";
    b.style.opacity = "0";
    a.pause();
    b.pause();
    bgActive.current = true;
    setBgImageUrl(`url("${src}")`);
  }, []);
  const advanceBgVideo = (0, import_react15.useCallback)(() => {
    const list = bgMediaRef.current;
    if (list.length < 2) return -1;
    let next = bgIndexRef.current;
    for (let step = 0; step < list.length; step++) {
      next = (next + 1) % list.length;
      if (list[next].type === "video") {
        bgIndexRef.current = next;
        showBgMedia(next);
        return next;
      }
    }
    return -1;
  }, [showBgMedia]);
  const onBgVideoEnded = (0, import_react15.useCallback)((event) => {
    if (bgTransitioning.current) return;
    const visibleEl = bgActive.current ? bgA.current : bgB.current;
    if (event.currentTarget !== visibleEl) return;
    advanceBgVideo();
  }, [advanceBgVideo]);
  const rotateBgReply = (0, import_react15.useCallback)(() => {
    const list = bgMediaRef.current;
    if (list.some((m) => m.type === "video")) {
      advanceBgVideo();
      return;
    }
    if (list.length < 2) return;
    bgIndexRef.current = (bgIndexRef.current + 1) % list.length;
    showBgMedia(bgIndexRef.current);
  }, [advanceBgVideo, showBgMedia]);
  const resetBg = (0, import_react15.useCallback)(() => {
    bgWired.current = false;
    bgActive.current = true;
    bgTransitioning.current = false;
    bgIndexRef.current = 0;
    const a = bgA.current;
    const b = bgB.current;
    if (a) {
      a.pause();
      a.style.opacity = "0";
    }
    if (b) {
      b.pause();
      b.style.opacity = "0";
    }
    if (bgMediaRef.current.length > 0) showBgMedia(0);
  }, [showBgMedia]);
  const mediaJsonRef = (0, import_react15.useRef)("");
  (0, import_react15.useEffect)(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const base = bridgeBase();
        const [bg, task] = await Promise.all([
          fetch(`${base}/api/media/bg-images`).then((r) => r.json()),
          fetch(`${base}/api/media/task-videos`).then((r) => r.json())
        ]);
        if (cancelled) return;
        const media = Array.isArray(bg.media) ? bg.media : [];
        const videos = Array.isArray(task.videos) ? task.videos : [];
        const json = JSON.stringify([media, videos]);
        if (json === mediaJsonRef.current) return;
        mediaJsonRef.current = json;
        bgMediaRef.current = media;
        setBgMedia(media);
        setTaskVideos(videos.map((name) => `${base}/media/task-videos/${encodeURIComponent(name)}`));
        resetBg();
      } catch (err) {
        console.error("[ui-voice] companion media list failed:", err);
      }
    };
    void load();
    const timer = window.setInterval(load, 3e4);
    const onPersonaChange = () => {
      void load();
    };
    window.addEventListener("dsh-voice:persona", onPersonaChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("dsh-voice:persona", onPersonaChange);
    };
  }, [resetBg]);
  (0, import_react15.useEffect)(() => {
    return companion.subscribe(() => setVisible(companion.visible));
  }, [companion]);
  (0, import_react15.useEffect)(() => {
    return speaker.subscribe(() => setSpeaking(speaker.speaking));
  }, [speaker]);
  const hideTaskFrame = (0, import_react15.useCallback)(() => {
    const vid = taskRef.current;
    if (vid !== null) {
      vid.pause();
      vid.currentTime = 0;
      vid.style.opacity = "0";
    }
    taskPlayingRef.current = false;
    taskPendingStopRef.current = false;
  }, []);
  const onTaskEnded = (0, import_react15.useCallback)(() => {
    if (taskPendingStopRef.current) {
      hideTaskFrame();
      return;
    }
    const vid = taskRef.current;
    if (vid !== null) {
      vid.currentTime = 0;
      void vid.play().catch(() => {
      });
    }
  }, [hideTaskFrame]);
  (0, import_react15.useEffect)(() => {
    const vid = taskRef.current;
    if (speaking && !wasSpeakingRef.current) {
      if (taskVideos.length > 0) {
        if (taskPlayingRef.current) vid?.pause();
        taskPendingStopRef.current = false;
        taskPlayingRef.current = true;
        taskIndexRef.current = (taskIndexRef.current + 1) % taskVideos.length;
        const src = taskVideos[taskIndexRef.current];
        if (vid !== null) {
          vid.src = src;
          vid.style.opacity = "1";
          vid.load();
          const play = () => {
            vid.removeEventListener("canplay", play);
            void vid.play().catch(() => {
            });
          };
          vid.addEventListener("canplay", play);
          window.setTimeout(() => {
            if (taskPlayingRef.current && vid.paused) void vid.play().catch(() => {
            });
          }, 3e3);
        }
      }
      rotateBgReply();
    } else if (!speaking && wasSpeakingRef.current) {
      if (taskPlayingRef.current) {
        taskPendingStopRef.current = true;
        window.setTimeout(() => {
          if (taskPendingStopRef.current) hideTaskFrame();
        }, 3e4);
      } else {
        hideTaskFrame();
      }
      if (taskRef.current === null) hideTaskFrame();
    }
    wasSpeakingRef.current = speaking;
  }, [speaking, taskVideos, rotateBgReply, hideTaskFrame]);
  (0, import_react15.useEffect)(() => {
    if (dhPlaying) hideTaskFrame();
  }, [dhPlaying, hideTaskFrame]);
  (0, import_react15.useEffect)(() => {
    let cancelled = false;
    const poll = async () => {
      const status = await dhStatus();
      if (cancelled || status === null) return;
      setDh((prev) => {
        if (prev === null) return status;
        if (prev.state === status.state && prev.video_url === status.video_url && prev.progress === status.progress && prev.message === status.message) return prev;
        return status;
      });
      driveDh(status);
    };
    void poll();
    const timer = window.setInterval(poll, 4e3);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const stopDh = (0, import_react15.useCallback)(() => {
    const vid = dhRef.current;
    if (vid !== null) {
      vid.pause();
      vid.currentTime = 0;
      vid.style.opacity = "0";
    }
    setDhPlayingBoth(false);
  }, [setDhPlayingBoth]);
  (0, import_react15.useEffect)(() => {
    return companion.subscribeInterrupt(() => {
      stopDh();
      dhQueueRef.current = [];
      dhQueuePlayedRef.current = 0;
      if (dhQueueCodeRef.current !== "") {
        handledDhRef.current.add(dhQueueCodeRef.current);
      }
    });
  }, [companion, stopDh]);
  const playNextDh = (0, import_react15.useCallback)(() => {
    const vid = dhRef.current;
    const next = dhQueueRef.current[dhQueuePlayedRef.current];
    if (vid === null || next === void 0) {
      setDhPlayingBoth(false);
      return;
    }
    vid.style.opacity = "1";
    vid.src = next;
    void vid.play().catch(() => {
    });
    setDhPlayingBoth(true);
  }, [setDhPlayingBoth]);
  const driveDh = (status) => {
    const code = status.code;
    if (!code) return;
    if (!readDigitalHuman()) {
      dhQueueRef.current = [];
      stopDh();
      return;
    }
    if (code !== dhQueueCodeRef.current) {
      dhQueueCodeRef.current = code;
      dhQueueRef.current = [];
      dhQueuePlayedRef.current = 0;
      handledDhRef.current.delete(code);
      stopDh();
    }
    if (handledDhRef.current.has(code)) return;
    if (status.state === "discarded") {
      handledDhRef.current.add(code);
      waitingDhRef.current = null;
      dhQueueRef.current = [];
      stopDh();
      return;
    }
    if (status.state === "error" && status.pending === 0) {
      handledDhRef.current.add(code);
      waitingDhRef.current = null;
      dhQueueRef.current = [];
      stopDh();
      if (status.text) {
        void tts(status.text).then((wav) => speaker.speak(wav)).catch((err) => console.error("[ui-voice] DH fallback TTS failed:", err));
      }
      return;
    }
    if (status.state === "tts" || status.state === "generating") {
      const now = Date.now();
      const timeoutMs = 6e4 + (status.total_segments || 1) * 25e3;
      if (waitingDhRef.current === null || waitingDhRef.current.code !== code) {
        waitingDhRef.current = { code, at: now };
      } else if (now - waitingDhRef.current.at > timeoutMs) {
        handledDhRef.current.add(code);
        waitingDhRef.current = null;
        dhQueueRef.current = [];
        dhDiscard(code);
        stopDh();
        if (status.text) {
          void tts(status.text).then((wav) => speaker.speak(wav)).catch((err) => console.error("[ui-voice] DH timeout TTS failed:", err));
        }
        return;
      }
    }
    if (status.state === "generating" || status.state === "done") {
      const base = bridgeBase();
      for (const v of status.videos ?? []) {
        const url = `${base}${v.video_url}`;
        if (!dhQueueRef.current.includes(url)) dhQueueRef.current.push(url);
      }
      if (status.state === "done") {
        handledDhRef.current.add(code);
        waitingDhRef.current = null;
      }
      if (!dhPlayingRef.current && dhQueuePlayedRef.current < dhQueueRef.current.length) {
        playNextDh();
      }
    }
  };
  (0, import_react15.useEffect)(() => {
    if (!speaking || !dhPlaying) return;
    const vid = dhRef.current;
    if (vid !== null) {
      vid.pause();
      vid.currentTime = 0;
      vid.style.opacity = "0";
    }
    setDhPlayingBoth(false);
  }, [speaking, dhPlaying, setDhPlayingBoth]);
  const onDhEnded = (0, import_react15.useCallback)(() => {
    dhQueuePlayedRef.current += 1;
    if (dhQueuePlayedRef.current < dhQueueRef.current.length) {
      playNextDh();
    } else {
      setDhPlayingBoth(false);
      const vid = dhRef.current;
      if (vid !== null) vid.style.opacity = "0";
    }
  }, [playNextDh, setDhPlayingBoth]);
  const beginMove = (0, import_react15.useCallback)((clientX, clientY) => {
    if (moveRef.current !== null) return;
    const base = posRef.current ?? defaultPos(widthPx, heightPx);
    moveRef.current = { startX: clientX, startY: clientY, base };
    const onMove = (move) => {
      const m = moveRef.current;
      if (m === null) return;
      const nx = m.base.x + (move.clientX - m.startX);
      const ny = m.base.y + (move.clientY - m.startY);
      const cx = Math.max(0, Math.min(window.innerWidth - widthPx, nx));
      const cy = Math.max(0, Math.min(window.innerHeight - heightPx, ny));
      setPos({ x: cx, y: cy });
      posRef.current = { x: cx, y: cy };
    };
    const onUp = () => {
      moveRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem(POS_KEY2, JSON.stringify(posRef.current ?? { x: 0, y: 0 }));
      } catch {
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [widthPx, heightPx]);
  const resetPos = (0, import_react15.useCallback)(() => {
    const next = defaultPos(widthPx, heightPx);
    setPos(next);
    posRef.current = next;
    try {
      localStorage.setItem(POS_KEY2, JSON.stringify(next));
    } catch {
    }
  }, [widthPx, heightPx]);
  const beginResize = (0, import_react15.useCallback)((clientX) => {
    dragRef.current = { startX: clientX, startWidth: widthPx, current: widthPx };
    const onMove = (move) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const delta = move.clientX - drag.startX;
      drag.current = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startWidth + delta));
      setWidthPx(drag.current);
    };
    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (drag !== null) {
        try {
          localStorage.setItem(WIDTH_KEY, String(drag.current));
        } catch {
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [widthPx]);
  (0, import_react15.useEffect)(() => {
    const onResize = () => {
      if (posRef.current === null) return;
      const cl = {
        x: Math.max(4, Math.min(window.innerWidth - widthPx - 4, posRef.current.x)),
        y: Math.max(4, Math.min(window.innerHeight - heightPx - 4, posRef.current.y))
      };
      posRef.current = cl;
      setPos(cl);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [widthPx, heightPx]);
  const dhBusy = dh !== null && (dh.state === "tts" || dh.state === "generating");
  const hasBgVideos = bgMedia.some((m) => m.type === "video");
  const hasBgImages = bgMedia.some((m) => m.type === "image");
  const nothing = !hasBgVideos && !hasBgImages && taskVideos.length === 0 && !dhPlaying && !dhBusy;
  const shown = visible && !nothing;
  const cardPos = (() => {
    const p = posRef.current ?? pos;
    if (p) {
      return {
        x: Math.max(4, Math.min(window.innerWidth - widthPx - 4, p.x)),
        y: Math.max(4, Math.min(window.innerHeight - heightPx - 4, p.y))
      };
    }
    return defaultPos(widthPx, heightPx);
  })();
  return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(
    "div",
    {
      className: CompanionWindow_default.card,
      style: {
        position: "fixed",
        left: `${cardPos.x}px`,
        top: `${cardPos.y}px`,
        width: `${widthPx}px`,
        height: `${heightPx}px`,
        zIndex: 9999,
        pointerEvents: "auto",
        cursor: "move",
        display: shown ? void 0 : "none",
        backgroundColor: "#0b0c10",
        backgroundImage: bgImageUrl || void 0,
        backgroundSize: "cover",
        backgroundPosition: "center",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: 22,
        boxShadow: "0 28px 70px -28px rgba(0,0,0,0.78), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.06)",
        overflow: "hidden",
        userSelect: "none"
      },
      "aria-hidden": "true",
      draggable: false,
      onPointerDown: (event) => {
        event.preventDefault();
        beginMove(event.clientX, event.clientY);
      },
      onDoubleClick: resetPos,
      title: "\u62D6\u52A8\u79FB\u52A8,\u53CC\u51FB\u56DE\u9ED8\u8BA4\u4F4D",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("video", { ref: bgA, style: VIDEO_STYLE, muted: true, playsInline: true, preload: "auto", draggable: false, onEnded: onBgVideoEnded }),
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("video", { ref: bgB, style: VIDEO_STYLE, muted: true, playsInline: true, preload: "auto", draggable: false, onEnded: onBgVideoEnded }),
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("video", { ref: taskRef, style: VIDEO_STYLE, muted: true, playsInline: true, preload: "metadata", draggable: false, onEnded: onTaskEnded }),
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("video", { ref: dhRef, style: VIDEO_STYLE, playsInline: true, preload: "metadata", draggable: false, onEnded: onDhEnded }),
        readDigitalHuman() && dh !== null && (dhBusy || dhPlaying || dh.state === "error" || dh.state === "discarded") && /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)("div", { style: DH_SEG_STYLE, children: [
          /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { style: { fontVariantNumeric: "tabular-nums" }, children: dhSegText(dh) }),
          dh.total_segments > 0 && /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { style: DH_SEG_BAR_STYLE, children: /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(
            "i",
            {
              style: {
                ...DH_SEG_FILL_STYLE,
                width: `${Math.round(Math.min(dh.done_segments, dh.total_segments) / dh.total_segments * 100)}%`
              }
            }
          ) })
        ] }),
        readDigitalHuman() && !readVoiceEnabled() && /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("div", { style: DH_HINT_STYLE, children: "\u8BED\u97F3\u603B\u5F00\u5173\u5173\u7740 \xB7 \u6570\u5B57\u4EBA\u4E0D\u4F1A\u63D0\u4EA4" }),
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(
          "div",
          {
            className: CompanionWindow_default.handle,
            onPointerDown: (event) => {
              event.stopPropagation();
              beginResize(event.clientX);
            },
            title: "\u62D6\u52A8\u8C03\u5BBD"
          }
        )
      ]
    }
  );
});

// src/client/voice/companion-controller.ts
var COMPANION_KEY = "s2s.voice.companion";
var CompanionController = class {
  listeners = /* @__PURE__ */ new Set();
  interruptListeners = /* @__PURE__ */ new Set();
  value;
  constructor() {
    try {
      this.value = localStorage.getItem(COMPANION_KEY) !== "0";
    } catch {
      this.value = true;
    }
  }
  get visible() {
    return this.value;
  }
  set visible(next) {
    if (this.value === next) return;
    this.value = next;
    try {
      localStorage.setItem(COMPANION_KEY, next ? "1" : "0");
    } catch {
    }
    for (const listener of this.listeners) listener();
  }
  /** Subscribe to visibility changes; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * 用户占用麦克风/说话（interruptReply 触发）：通知女友窗停止数字人视频
   * 播放。只停播放，不涉及桥接的生成任务与磁盘文件（生成/存取不受影响）。
   */
  notifyMicInterrupt() {
    for (const listener of this.interruptListeners) listener();
  }
  /** 订阅"麦克风占用/用户说话"事件；返回退订函数。 */
  subscribeInterrupt(listener) {
    this.interruptListeners.add(listener);
    return () => {
      this.interruptListeners.delete(listener);
    };
  }
};

// src/client/voice/modes.ts
var SPEAKER_KEY = "s2s.voice.enabled";
var MIC_KEY = "s2s.voice.mic";
function readFlag(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw !== "0";
  } catch {
    return fallback;
  }
}
function writeFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
  }
}
var ModeController = class {
  micValue;
  /** How many times the microphone was really turned on in this page life. */
  micOpenCountValue = 0;
  speakerValue;
  visionValue;
  listeners = /* @__PURE__ */ new Set();
  constructor() {
    this.micValue = readFlag(MIC_KEY, false);
    this.speakerValue = readFlag(SPEAKER_KEY, true);
    this.visionValue = false;
  }
  /** Microphone listening (voice input). */
  get mic() {
    return this.micValue;
  }
  set mic(value) {
    if (this.micValue === value) return;
    if (!this.micValue && value) this.micOpenCountValue += 1;
    this.micValue = value;
    writeFlag(MIC_KEY, value);
    this.notify();
  }
  /** How many real microphone openings happened so far (this page life). */
  get micOpenCount() {
    return this.micOpenCountValue;
  }
  /** Replies read aloud (voice output). */
  get speaker() {
    return this.speakerValue;
  }
  set speaker(value) {
    if (this.speakerValue === value) return;
    this.speakerValue = value;
    writeFlag(SPEAKER_KEY, value);
    this.notify();
  }
  /** Camera open; the model sees the picture. */
  get vision() {
    return this.visionValue;
  }
  set vision(value) {
    if (this.visionValue === value) return;
    this.visionValue = value;
    this.notify();
  }
  /** Subscribe to flag changes; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  notify() {
    for (const listener of this.listeners) listener();
  }
};

// src/client/voice/camera.ts
var DEFAULT_CAMERA_OPTIONS = {
  timeoutMs: 8e3
};
function decodeFingerprint(raw) {
  if (raw === void 0 || raw === "") return null;
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
function decodeGrid(raw) {
  if (raw === void 0 || raw === "") return null;
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
var CameraCapture = class {
  opts;
  started = false;
  /** Human-readable reason of the last failure, or null. */
  error = null;
  /** The bridge base URL, remembered so stop() can release the device. */
  releaseUrl = null;
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_CAMERA_OPTIONS, ...opts };
  }
  /** Whether the camera is currently held open. */
  get active() {
    return this.started;
  }
  /** The reason of the last failure, or null when there was none. */
  get lastError() {
    return this.error;
  }
  /**
   * Open the camera by asking the bridge for one frame.
   * @throws when the bridge cannot deliver a frame.
   */
  async start() {
    if (this.started) return;
    this.error = null;
    const frame = await this.fetchFrame();
    if (frame === null) {
      throw new Error(this.error ?? "\u6444\u50CF\u5934\u6253\u4E0D\u5F00");
    }
    this.started = true;
  }
  /** Release the camera; the bridge gives the device back to the system. */
  stop() {
    this.started = false;
    const url = this.releaseUrl;
    this.releaseUrl = null;
    if (url === null) return;
    void fetch(`${url}/api/camera/release`, { method: "POST" }).catch(() => {
    });
  }
  /**
   * Grab the current picture as a JPEG.
   * @param wantGrid - also ask the bridge for the 64x36 HSV grid of this very
   *                   frame (the change-score raw material).
   * @returns the frame, or null when the camera has no picture yet.
   */
  async grab(wantGrid = false) {
    if (!this.started) return null;
    const frame = await this.fetchFrame(wantGrid);
    if (frame === null) return null;
    return {
      data: frame.data,
      mediaType: "image/jpeg",
      width: frame.width,
      height: frame.height,
      at: performance.now(),
      fingerprint: decodeFingerprint(frame.fingerprint),
      grid: decodeGrid(frame.grid),
      deviceFps: typeof frame.deviceFps === "number" ? frame.deviceFps : 0
    };
  }
  /**
   * One frame from the bridge.
   * @param wantGrid - whether to ask for the HSV grid as well.
   * @returns the frame, or null when it could not be fetched (the reason is
   *          left in `this.error`).
   */
  async fetchFrame(wantGrid = false) {
    const { cameraFrame: cameraFrame2, bridgeBase: bridgeBase3 } = await Promise.resolve().then(() => (init_bridge(), bridge_exports));
    this.releaseUrl = bridgeBase3();
    try {
      const frame = await cameraFrame2(this.opts.timeoutMs, wantGrid);
      if (frame.data === "") {
        this.error = "\u6865\u63A5\u8FD4\u56DE\u4E86\u7A7A\u753B\u9762";
        return null;
      }
      this.error = null;
      return frame;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.error("[ui-voice] camera frame failed:", err);
      return null;
    }
  }
};

// src/client/voice/seenow/score.ts
var SCAN_W = 64;
var SCAN_H = 36;
var GRID_BYTES = SCAN_W * SCAN_H * 3;
function scorePair(prev, cur) {
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return sum / (cur.length / 3 * 3);
}
function changedCells(prev, cur, threshold = 24) {
  let changed = 0;
  let total = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    const d = hueDiff * hueWeight + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
    total += 1;
    if (d >= threshold) changed += 1;
  }
  return total === 0 ? 0 : changed / total * 255;
}

// src/client/voice/sheet.ts
var SHEET_DEFAULTS = {
  fps: 12,
  cutAbs: 12,
  cutSpike: 2.5,
  cutMinGap: 0.4,
  integralSeconds: 3,
  refScore: 5,
  markMinGap: 0.5,
  silentFloorSec: 20,
  dupMin: 3.5,
  maxFrames: 9,
  metric: "mean",
  cellThreshold: 24,
  preRoll: 0
};
var SHEET_WIDTH = 1024;
var SHEET_QUALITY = 0.82;
var SheetPipeline = class {
  o;
  /** 上一帧的网格（打分基准）。 */
  prevGrid = null;
  /** 上一张**留下**的帧的网格（去重基准）。 */
  lastKeptGrid = null;
  /** 待判的帧（最多 2：切点判据要看下一帧的分数）。 */
  queue = [];
  /** 上一帧的变化分。 */
  lastScore = null;
  /** 积分累加器。 */
  acc = 0;
  /** 上一次切点的时刻（秒）。 */
  lastCut = Number.NEGATIVE_INFINITY;
  /** 上一张留下的帧的时刻（秒）。 */
  lastBound = Number.NEGATIVE_INFINITY;
  /** 本轮的零点（毫秒）。 */
  origin = 0;
  /** 本轮留下的帧。 */
  kept = [];
  /** 最近的若干帧（事件前回看用；preRoll = 0 时不占内存）。 */
  ring = [];
  constructor(options = {}) {
    this.o = { ...SHEET_DEFAULTS, ...options };
  }
  /**
   * 换一组参数（不重置状态）。
   *
   * 调车那种"盯着一小块区域"的场景要把口径从 `mean` 换成 `cells`、
   * 打开事件前回看 —— 这些开关在运行时切，不该把已经攒下的帧扔掉。
   */
  configure(options) {
    for (const key of Object.keys(options)) {
      const value = options[key];
      if (value === void 0) continue;
      this.o[key] = value;
    }
    if (this.o.preRoll <= 0) this.ring.length = 0;
  }
  /** 按当前口径算两帧的差异。 */
  diff(prev, cur) {
    return this.o.metric === "cells" ? changedCells(prev, cur, this.o.cellThreshold) : scorePair(prev, cur);
  }
  /** 积分阈值：固定的绝对值（4~5 分/帧 × 帧率 × 秒数）。 */
  integralNeed() {
    return this.o.refScore * this.o.fps * this.o.integralSeconds;
  }
  /**
   * 喂一帧。
   *
   * @param frame - 这一帧的 JPEG、尺寸与网格。
   */
  push(frame) {
    if (this.origin === 0) this.origin = frame.atMs;
    const score = this.prevGrid === null ? null : this.diff(this.prevGrid, frame.grid);
    this.prevGrid = frame.grid;
    const entry = {
      frame: {
        data: frame.data,
        width: frame.width,
        height: frame.height,
        grid: frame.grid,
        atMs: frame.atMs
      },
      score,
      prev: this.lastScore
    };
    this.lastScore = score;
    this.queue.push(entry);
    while (this.queue.length >= 2) {
      const head = this.queue.shift();
      this.decide(head, this.queue[0].score);
    }
    if (this.o.preRoll > 0) {
      this.ring.push(entry.frame);
      while (this.ring.length > Math.max(this.o.preRoll + 2, 24)) this.ring.shift();
    }
  }
  /** 判一帧要不要留。 */
  decide(entry, nextScore) {
    const t = (entry.frame.atMs - this.origin) / 1e3;
    const s = entry.score;
    if (s === null) {
      this.keep(entry, "start");
      return;
    }
    const px = entry.prev ?? 0;
    const nx = nextScore ?? 0;
    const spike = nextScore === null || s > this.o.cutSpike * Math.max(1, px, nx);
    if (s >= this.o.cutAbs && spike && t - this.lastCut >= this.o.cutMinGap) {
      this.lastCut = t;
      this.acc = 0;
      this.keep(entry, "cut");
      return;
    }
    this.acc += s;
    if (this.acc >= this.integralNeed() && t - this.lastBound >= this.o.markMinGap) {
      if (this.keep(entry, "mark")) this.acc = 0;
      return;
    }
    if (t - this.lastBound >= this.o.silentFloorSec) this.keep(entry, "floor");
  }
  /**
   * 留一帧。
   *
   * @returns 是否真的留下来了（被去重挡掉时返回 false）。
   */
  keep(entry, via) {
    const grid = entry.frame.grid;
    const dup = this.lastKeptGrid === null ? null : this.diff(this.lastKeptGrid, grid);
    if (dup !== null && dup < this.o.dupMin && via !== "cut" && via !== "floor") return false;
    if (via === "cut" && this.o.preRoll > 0) this.pushPreRoll(entry.frame.atMs);
    this.lastKeptGrid = grid;
    this.kept.push({ ...entry.frame, via, dup });
    this.lastBound = (entry.frame.atMs - this.origin) / 1e3;
    if (this.kept.length > this.o.maxFrames) this.dropRedundant();
    return true;
  }
  /**
   * 把事件之前攒着的帧补进这一轮（最多 preRoll 张）。
   *
   * @param beforeMs - 事件的时刻；只补比它早的帧。
   */
  pushPreRoll(beforeMs) {
    const older = this.ring.filter((f) => f.atMs < beforeMs);
    const picked = older.slice(-this.o.preRoll);
    if (picked.length === 0) return;
    for (const frame of picked) {
      if (this.kept.some((k) => k.atMs === frame.atMs)) continue;
      this.kept.push({ ...frame, via: "pre", dup: null });
    }
    this.kept.sort((a, b) => a.atMs - b.atMs);
  }
  /**
   * 超过上限时，挤掉一张"删了最不心疼"的。
   *
   * 挑法和旧的多帧路径一样：留那张"和左右邻居都不像"的 —— 留它也不会让模型多知道什么。
   * 首尾两张不动：开头那张给"从哪儿开始"，末尾那张给"现在什么样"。
   */
  dropRedundant() {
    while (this.kept.length > this.o.maxFrames) {
      let victim = -1;
      let cheapest = Number.POSITIVE_INFINITY;
      for (let i = 1; i < this.kept.length - 1; i++) {
        const before = this.kept[i - 1].grid;
        const current2 = this.kept[i].grid;
        const after = this.kept[i + 1].grid;
        const cost = this.diff(before, current2) + this.diff(current2, after) - this.diff(before, after);
        if (cost < cheapest) {
          cheapest = cost;
          victim = i;
        }
      }
      if (victim === -1) {
        this.kept.shift();
        continue;
      }
      this.kept.splice(victim, 1);
    }
  }
  /**
   * 取走这一轮留下的帧。
   *
   * 管线的内部状态（打分基准、去重基准、积分）**不会**被清掉 ——
   * 下一轮要和这一轮接着比，不然画面一变就会被判成"又变了"。
   */
  take() {
    const frames = this.kept;
    this.kept = [];
    return frames;
  }
  /** 丢掉攒下的帧（麦克风关了：这一段画面不该再送给模型）。 */
  reset() {
    this.kept = [];
    this.lastKeptGrid = null;
    this.prevGrid = null;
    this.lastScore = null;
    this.acc = 0;
    this.lastCut = Number.NEGATIVE_INFINITY;
    this.lastBound = Number.NEGATIVE_INFINITY;
    this.queue.length = 0;
    this.origin = 0;
  }
  /** 本轮攒下了几帧。 */
  get pending() {
    return this.kept.length;
  }
  /** 积分累加到哪儿了（调试用）。 */
  get integral() {
    return this.acc;
  }
};
function layoutSheet(n, aspect, width) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cellW = width / cols;
  const cellH = cellW / (Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3);
  return {
    cols,
    rows,
    cellW,
    cellH,
    width,
    height: Math.max(1, Math.round(rows * cellH))
  };
}
async function composeSheet(frames, opts) {
  const n = frames.length;
  if (n === 0) throw new Error("composeSheet: \u6CA1\u6709\u5E27");
  const width = opts.width ?? SHEET_WIDTH;
  const newest = frames[n - 1];
  const sourceWidth = opts.sourceWidth ?? newest.width;
  const sourceHeight = opts.sourceHeight ?? newest.height;
  const aspect = sourceHeight > 0 ? sourceWidth / sourceHeight : 4 / 3;
  const { cols, rows, cellW, cellH, height } = layoutSheet(n, aspect, width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("composeSheet: \u62FF\u4E0D\u5230 2d \u753B\u5E03");
  ctx.fillStyle = "#121214";
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = Math.round(col * cellW);
    const y = Math.round(row * cellH);
    const w = Math.round((col + 1) * cellW) - x;
    const h = Math.round((row + 1) * cellH) - y;
    const bitmap = await decodeFrame(frames[i].data);
    try {
      ctx.drawImage(bitmap, x, y, w, h);
    } finally {
      bitmap.close?.();
    }
    drawBadge(ctx, i + 1, x, y, w, h);
  }
  const url = canvas.toDataURL("image/jpeg", opts.quality ?? SHEET_QUALITY);
  const comma = url.indexOf(",");
  return { data: comma >= 0 ? url.slice(comma + 1) : url, width, height, cols, rows };
}
async function decodeFrame(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  return await createImageBitmap(blob);
}
function drawBadge(ctx, index, x, y, w, h) {
  const scale = Math.max(11, Math.min(30, Math.round(w / 26)));
  ctx.font = `bold ${scale}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineWidth = Math.max(2, Math.round(scale / 6));
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.fillStyle = "#ffeb3b";
  const label = String(index);
  const px = x + 3;
  const py = y + 2;
  ctx.strokeText(label, px, py);
  ctx.fillText(label, px, py);
  void h;
}

// src/client/voice/vision-ids.ts
var ids = /* @__PURE__ */ new Set();
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
async function noteVisionImage(data) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", base64ToBytes(data));
    let hex = "";
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
    ids.add(`sha256:${hex}`);
  } catch (err) {
    console.warn("[ui-voice] \u65E0\u6CD5\u8BA1\u7B97\u753B\u9762\u9644\u4EF6\u6307\u7EB9\uFF1A", err);
  }
}
function isVisionImage(attachmentId) {
  return attachmentId !== void 0 && ids.has(attachmentId);
}

// src/client/voice/vision.ts
var DEFAULT_SAMPLE_MS = 33;
var MIN_SAMPLE_MS = 15;
var CHANGE_THRESHOLD = 1;
var MAX_BURST_FRAMES = 80;
var SCORE_INTERVAL_MS = 83;
function sheetMode() {
  try {
    return localStorage.getItem("s2s.voice.sheet") !== "0";
  } catch {
    return true;
  }
}
function debugMode() {
  try {
    return localStorage.getItem("s2s.voice.sheet.debug") === "1";
  } catch {
    return false;
  }
}
var DEBUG_PROFILE = {
  metric: "cells",
  cellThreshold: 24,
  cutAbs: 2.5,
  refScore: 1.2,
  integralSeconds: 1,
  markMinGap: 0.2,
  cutMinGap: 0.15,
  dupMin: 0.8,
  preRoll: 3
};
var COMPANION_PROFILE = {
  metric: "mean",
  cutAbs: SHEET_DEFAULTS.cutAbs,
  refScore: SHEET_DEFAULTS.refScore,
  integralSeconds: SHEET_DEFAULTS.integralSeconds,
  markMinGap: SHEET_DEFAULTS.markMinGap,
  cutMinGap: SHEET_DEFAULTS.cutMinGap,
  dupMin: SHEET_DEFAULTS.dupMin,
  preRoll: 0
};
function scoreIntervalMs() {
  return debugMode() ? 34 : SCORE_INTERVAL_MS;
}
function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}
var VisionController = class {
  opts;
  camera;
  timer = null;
  /** The frames kept because the picture changed (the burst source). */
  buffer = [];
  /** The fingerprint of the last kept frame: the comparison baseline. */
  baseline = null;
  /** Whether frames may be kept at all (the microphone is listening). */
  capturing = false;
  /** The current sampling period (ms), adapted to the camera's rate. */
  period;
  /** The frame the model was last handed, plus when it happened. */
  delivered = null;
  state = "off";
  /** Bumped on every open/close so a late camera grant cannot revive it. */
  generation = 0;
  listeners = /* @__PURE__ */ new Set();
  deliveryListeners = /* @__PURE__ */ new Set();
  liveListeners = /* @__PURE__ */ new Set();
  /** One fetch at a time: a slow frame must not stack up behind the next. */
  sampling = false;
  /** The sheet pipeline: which frames are worth keeping, and how many. */
  sheet = new SheetPipeline();
  /** The newest frame the camera produced (what the model would see right now). */
  latest = null;
  /** When the last change score was taken (ms). */
  lastScoreAt = 0;
  /** 上一次应用的口径（陪伴 / 调试），切换时才重新下发参数。 */
  debugApplied = null;
  constructor(options = {}) {
    this.opts = {
      sampleMs: options.sampleMs ?? DEFAULT_SAMPLE_MS,
      timeoutMs: options.timeoutMs ?? 8e3
    };
    this.period = this.opts.sampleMs;
    this.camera = new CameraCapture({
      timeoutMs: this.opts.timeoutMs
    });
  }
  /** The reason of the last camera failure, or null. */
  get error() {
    return this.camera.lastError;
  }
  /** Current camera lifecycle state. */
  get status() {
    return this.state;
  }
  /** Whether the camera is supposed to be open. */
  get enabled() {
    return this.state === "on" || this.state === "starting";
  }
  /** How many frames are waiting for the next sentence. */
  get buffered() {
    return this.buffer.length;
  }
  /** Subscribe to camera state changes; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * The frame the model was last given (what the model is looking at right
   * now), plus the time it was handed over. Shown by the preview window: it
   * deliberately lags behind the live camera, because it IS the model's view.
   */
  get lastDelivered() {
    return this.delivered;
  }
  /** Subscribe to "the model got a new frame" events. */
  subscribeDelivery(listener) {
    this.deliveryListeners.add(listener);
    return () => {
      this.deliveryListeners.delete(listener);
    };
  }
  /**
   * Subscribe to the live sampling loop: it fires on every sampled frame (as
   * fast as the camera delivers), so the preview window can show the room as
   * it is right now. The listener also receives null when the camera closes.
   */
  subscribeLive(listener) {
    this.liveListeners.add(listener);
    return () => {
      this.liveListeners.delete(listener);
    };
  }
  /**
   * Open or close the camera. Closing releases the device and stops the
   * sampling loop; opening starts sampling as fast as the camera delivers.
   * @param on - desired state.
   */
  async setEnabled(on) {
    if (on) {
      if (this.state === "on" || this.state === "starting") return;
      this.setState("starting");
      const generation = ++this.generation;
      try {
        await this.camera.start();
      } catch (err) {
        console.error("[ui-voice] camera start failed:", err);
        if (this.generation === generation) this.setState("error");
        return;
      }
      if (this.generation !== generation) {
        this.camera.stop();
        return;
      }
      this.setState("on");
      void this.sample();
      return;
    }
    if (this.state === "off") return;
    this.generation += 1;
    this.setState("off");
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.camera.stop();
    this.buffer.length = 0;
    this.baseline = null;
    this.sheet.reset();
    this.latest = null;
    this.markDelivered(null);
    for (const listener of this.liveListeners) listener(null);
  }
  /**
   * Open or close the frame capture (the microphone switch drives this).
   *
   * Frames are only worth keeping while somebody might speak: from the moment
   * the microphone goes on, the picture is watched for changes and the changed
   * frames pile up for the next sentence. When the microphone goes off again
   * the pile is dropped  - ?a picture from an earlier moment would only confuse
   * the model.
   *
   * @param on - whether frames may be kept.
   */
  setCapturing(on) {
    if (this.capturing === on) return;
    this.capturing = on;
    this.buffer.length = 0;
    this.baseline = null;
    this.sheet.reset();
  }
  /** Close the camera and release every resource. */
  dispose() {
    void this.setEnabled(false);
  }
  /**
   * Prepend the picture kept since the previous turn to a prompt.
   *
   * This is what makes a spoken sentence carry the motion that led up to it:
   * the camera samples as fast as it can, but only the frames where the
   * picture really changed are stored.
   *
   * Two shapes, chosen by `s2s.voice.sheet`:
   *   - **sheet** (default): the kept frames are composed into ONE image
   *     (a grid of cells, cell numbers burned in) plus one full-size frame of
   *     the latest picture. One image instead of up to eighty.
   *   - **burst** (the old path): every kept frame as its own image.
   *
   * @param parts - the prompt content the caller wants to send.
   * @returns the content with the picture in front, or the original parts
   *          when the camera has nothing worth sending.
   */
  async attachFrame(parts) {
    if (!sheetMode()) return this.attachBurst(parts);
    return await this.attachSheet(parts);
  }
  /**
   * 记住刚发出去的这张图（按字节 sha256），界面才能把它和用户自己上传的
   * 图片区分开 —— 对话里默认只留一个「点击查看」的小按钮。
   * @param data - 图片的 base64。
   */
  async markSent(data) {
    await noteVisionImage(data);
  }
  /**
   * The sheet path: one composed image (or the plain frame when there is only
   * one worth sending).
   *
   * 只有一帧时直接送那张原图 —— 拼成 1024 宽反而是一次放大 + 重压缩，更模糊。
   * 两帧以上才拼，并且**不再另附全幅**：最新那一帧本来就是拼图的最后一格，
   * 再送一遍只是多一份 token。
   */
  async attachSheet(parts) {
    if (this.state !== "on") return parts;
    const frames = this.sheet.take();
    if (frames.length === 0) {
      const latest = this.latest;
      if (latest === null) return parts;
      this.markDelivered(latest);
      await this.markSent(latest.data);
      return [{ type: "image", mediaType: latest.mediaType, data: latest.data }, ...parts];
    }
    const newest = frames[frames.length - 1];
    if (frames.length === 1) {
      this.markDelivered(newest);
      await this.markSent(newest.data);
      return [
        { type: "image", mediaType: "image/jpeg", data: newest.data },
        ...parts
      ];
    }
    let sheet;
    try {
      sheet = await composeSheet(frames, {
        sourceWidth: newest.width,
        sourceHeight: newest.height
      });
    } catch (err) {
      console.error("[ui-voice] \u62FC\u56FE\u5931\u8D25\uFF0C\u9000\u56DE\u5355\u5E27\uFF1A", err);
      this.markDelivered(newest);
      await this.markSent(newest.data);
      return [{ type: "image", mediaType: "image/jpeg", data: newest.data }, ...parts];
    }
    this.markDelivered(newest);
    await this.markSent(sheet.data);
    return [
      { type: "image", mediaType: "image/jpeg", data: sheet.data },
      ...parts
    ];
  }
  /**
   * The old path: every kept frame as its own image (up to MAX_BURST_FRAMES).
   */
  async attachBurst(parts) {
    const frames = this.takeBurst();
    if (frames.length === 0) return parts;
    this.markDelivered(frames[frames.length - 1]);
    for (const frame of frames) await this.markSent(frame.data);
    return [
      ...frames.map((frame) => ({ type: "image", mediaType: frame.mediaType, data: frame.data })),
      ...parts
    ];
  }
  /**
   * The frames kept since the last turn.
   * @returns every kept frame not yet sent, in chronological order.
   */
  takeBurst() {
    if (this.state !== "on") {
      this.buffer.length = 0;
      return [];
    }
    const frames = this.buffer.slice();
    this.buffer.length = 0;
    return frames;
  }
  /** Grab one frame and decide whether it is worth keeping. */
  async sample() {
    if (this.state !== "on") return;
    if (this.sampling) return;
    this.sampling = true;
    const started = performance.now();
    try {
      const debug = debugMode();
      if (debug !== this.debugApplied) {
        this.debugApplied = debug;
        this.sheet.configure(debug ? DEBUG_PROFILE : COMPANION_PROFILE);
        this.lastScoreAt = 0;
      }
      const wantGrid = this.capturing && started - this.lastScoreAt >= scoreIntervalMs();
      const frame = await this.camera.grab(wantGrid);
      if (frame === null) return;
      if (this.state !== "on") return;
      this.adaptPeriod(frame.deviceFps);
      this.latest = frame;
      for (const listener of this.liveListeners) listener(frame);
      if (!this.capturing) return;
      if (wantGrid && frame.grid !== null && frame.grid.length > 0) {
        this.lastScoreAt = started;
        this.sheet.push({
          data: frame.data,
          width: frame.width,
          height: frame.height,
          grid: frame.grid,
          atMs: started
        });
        return;
      }
      if (!sheetMode()) this.consider(frame);
    } finally {
      this.sampling = false;
      this.schedule(Math.max(0, this.period - (performance.now() - started)));
    }
  }
  /** Keep the frame only when the picture differs from the last kept one. */
  consider(frame) {
    const fingerprint = frame.fingerprint;
    if (fingerprint === null || fingerprint.length === 0) {
      this.keep(frame);
      return;
    }
    if (this.baseline === null || this.baseline.length !== fingerprint.length) {
      this.keep(frame);
      return;
    }
    if (meanAbsDiff(this.baseline, fingerprint) > CHANGE_THRESHOLD) this.keep(frame);
  }
  /**
   * Store one frame as the new baseline.
   *
   * The frame that arrives is always judged by the plain CHANGE_THRESHOLD, so
   * the newest motion stays dense. If the pile never reaches MAX_BURST_FRAMES
   * it simply stays smaller — nothing is padded or stretched. Only a FULL pile
   * gets compressed, and it is always the older end that gives room.
   */
  keep(frame) {
    this.buffer.push(frame);
    this.baseline = frame.fingerprint;
    if (this.buffer.length > MAX_BURST_FRAMES) this.compressFull();
  }
  /**
   * The pile is full: make room for the newcomer by dropping the one frame
   * that tells the least - the frame whose neighbours look almost the same as
   * it does, so keeping it would barely change what the model learns.
   *
   * A raised threshold was the first idea, but it quantises badly: going from
   * "one frame per frame" to "one frame per two frames" halves the pile to 40,
   * and the burst could never hold 80. Dropping exactly one frame per arrival
   * keeps the count at MAX and still leaves the oldest part sparse and the
   * newest part dense, because the oldest part is where neighbours are the
   * most alike.
   */
  compressFull() {
    while (this.buffer.length > MAX_BURST_FRAMES) {
      let victim = -1;
      let cheapest = Number.POSITIVE_INFINITY;
      for (let i = 1; i < this.buffer.length - 1; i++) {
        const before = this.buffer[i - 1].fingerprint;
        const current2 = this.buffer[i].fingerprint;
        const after = this.buffer[i + 1].fingerprint;
        if (before === null || current2 === null || after === null) continue;
        const cost = meanAbsDiff(before, current2) + meanAbsDiff(current2, after) - meanAbsDiff(before, after);
        if (cost < cheapest) {
          cheapest = cost;
          victim = i;
        }
      }
      if (victim === -1) {
        this.buffer.shift();
        continue;
      }
      this.buffer.splice(victim, 1);
    }
    const last = this.buffer[this.buffer.length - 1];
    this.baseline = last?.fingerprint ?? null;
  }
  /** Follow the camera's own frame rate (30 fps here). */
  adaptPeriod(deviceFps) {
    if (deviceFps <= 0 || deviceFps > 240) return;
    const period = Math.max(MIN_SAMPLE_MS, Math.round(1e3 / deviceFps));
    if (period === this.period) return;
    this.period = period;
  }
  /**
   * Schedule the next sampling tick (after the current one finished).
   * @param delay - how long to wait before the next grab (ms).
   */
  schedule(delay = this.period) {
    if (this.state !== "on") return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.sample();
    }, delay);
  }
  /** Record one frame as delivered to the model and notify the preview. */
  markDelivered(frame) {
    this.delivered = frame === null ? null : { frame, at: performance.now() };
    for (const listener of this.deliveryListeners) listener(frame);
  }
  setState(next) {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
};

// src/client/voice/hide-opener.ts
var PREFIX_MATCH_MIN = 32;
var PREFIX_LENGTH = 48;
var EXACT_SLACK = 6;
var PREFIX_SLACK = 24;
var OPENER_TTL_MS = 12e4;
var INPUT_KINDS = /* @__PURE__ */ new Set(["user", "steering"]);
var CANDIDATES = "[data-chat-flow-kind], [data-pending-steering], [data-submission-echo]";
var openers = [];
var hiddenKeys = /* @__PURE__ */ new Set();
var observer = null;
function visibleText2(root) {
  let text = "";
  const walk = (node) => {
    if (node.nodeType === 3) {
      text += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node;
    if (element.hasAttribute("hidden")) return;
    if (element instanceof HTMLElement && element.style.display === "none") return;
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return squash2(text);
}
function squash2(text) {
  return text.replace(/\s+/g, "");
}
function hidingDisabled() {
  try {
    return localStorage.getItem("s2s.voice.opener.hide") === "0";
  } catch {
    return false;
  }
}
function rowOf(element) {
  const pending = element.closest("[data-pending-steering], [data-submission-echo]");
  if (pending !== null && !pending.hasAttribute("hidden")) return pending;
  const kindRow = element.closest("[data-chat-flow-kind]");
  if (kindRow !== null) return kindRow;
  return null;
}
function hide(element) {
  if (element.hasAttribute("hidden")) return;
  element.setAttribute("hidden", "");
  if (element instanceof HTMLElement) element.style.display = "none";
}
function takeOpener(text) {
  for (const opener of openers) {
    if (opener.done) continue;
    if (opener.prefix === null) {
      const bare = text.replace(/\d{1,2}[:：]\d{2}$/u, "");
      if (Math.abs(bare.length - opener.text.length) > EXACT_SLACK) continue;
      if (bare === opener.text || bare.startsWith(opener.text)) return opener;
      continue;
    }
    if (!text.startsWith(opener.prefix)) continue;
    if (Math.abs(text.length - opener.text.length) > PREFIX_SLACK) continue;
    return opener;
  }
  return null;
}
function check(element) {
  const row = rowOf(element);
  if (row === null || row.hasAttribute("hidden")) return false;
  const key = row.getAttribute("data-chat-node-key");
  if (key !== null && hiddenKeys.has(key)) {
    hide(row);
    return true;
  }
  const kind = row.getAttribute("data-chat-flow-kind");
  if (kind !== null && !INPUT_KINDS.has(kind)) return false;
  if (openers.length === 0) return false;
  const opener = takeOpener(visibleText2(row));
  if (opener === null) return false;
  if (key !== null) {
    hiddenKeys.add(key);
    opener.done = true;
  }
  hide(row);
  const outer = row.closest("[data-chat-flow-kind]");
  if (outer !== null && outer !== row) check(outer);
  return true;
}
function checkTree(element) {
  if (check(element)) return;
  for (const inner of Array.from(element.querySelectorAll(CANDIDATES))) check(inner);
}
function prune(now) {
  for (let index = openers.length - 1; index >= 0; index -= 1) {
    const opener = openers[index];
    if (opener === void 0) continue;
    if (opener.done || now - opener.at > OPENER_TTL_MS) openers.splice(index, 1);
  }
}
function ensureObserver() {
  if (observer !== null) return;
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        const parent = record.target.parentElement;
        if (parent !== null) check(parent);
        continue;
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue;
        checkTree(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
function hideOpenerText(text) {
  if (hidingDisabled()) return;
  const squashed = squash2(text);
  if (squashed.length < 3) return;
  if (openers.some((opener) => !opener.done && opener.text === squashed)) return;
  prune(Date.now());
  openers.push({
    text: squashed,
    prefix: squashed.length >= PREFIX_MATCH_MIN ? squashed.slice(0, PREFIX_LENGTH) : null,
    at: Date.now(),
    done: false
  });
  ensureObserver();
  for (const element of Array.from(document.querySelectorAll(CANDIDATES))) {
    if (check(element)) break;
  }
}
function startOpenerHiding() {
  if (hidingDisabled()) return () => {
  };
  ensureObserver();
  return () => {
    observer?.disconnect();
    observer = null;
  };
}

// src/client/VisionAwareImages.tsx
var import_react16 = require("react");
var import_jsx_runtime14 = require("react/jsx-runtime");
var VisionAwareImages = (0, import_react16.memo)(function VisionAwareImages2(props) {
  markVisionSlotActive();
  const { images, loadImage, align, compact, t, renderFactorySlot } = props;
  const [hidden, setHidden] = (0, import_react16.useState)(visionHidden());
  const [expanded, setExpanded] = (0, import_react16.useState)(false);
  (0, import_react16.useEffect)(() => subscribeVisionVisibility(setHidden), []);
  const list = Array.isArray(images) ? images : [];
  const allOurs = list.length > 0 && list.every((image) => {
    const attachment = image?.attachment;
    if (attachment === void 0) return false;
    if (isVisionImage(attachment.attachmentId)) return true;
    return attachment.name === void 0 && attachment.mediaType === "image/jpeg";
  });
  if (!allOurs || !hidden || expanded) {
    if (typeof renderFactorySlot !== "function") return null;
    return renderFactorySlot("conversation.images.content", {
      images,
      loadImage,
      align,
      compact
    });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(
    "button",
    {
      type: "button",
      onClick: () => setExpanded(true),
      title: t?.("vision.chipHint") ?? "\u70B9\u51FB\u67E5\u770B\u8FD9\u4E00\u8F6E\u5E26\u4E0A\u7684\u753B\u9762",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 10px",
        margin: "2px 0",
        fontSize: "12px",
        lineHeight: "1.6",
        color: "var(--dsw-alias-label-dimmed, #888)",
        background: "rgba(127,127,127,0.12)",
        border: "1px solid rgba(127,127,127,0.22)",
        borderRadius: "8px",
        cursor: "pointer"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("span", { "aria-hidden": "true", children: "\u{1F4F7}" }),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("span", { children: t?.("vision.chip") ?? "\u753B\u9762 \xB7 \u70B9\u51FB\u67E5\u770B" })
      ]
    }
  );
});

// src/client/index.ts
init_bridge();

// src/client/locales.ts
var zh = {
  "mic.title": "\u8BED\u97F3\u8F93\u5165",
  "mic.listening": "\u6B63\u5728\u8046\u542C\u2026\u518D\u70B9\u4E00\u4E0B\u505C\u6B62",
  "mic.transcribing": "\u8BC6\u522B\u4E2D\u2026",
  "mic.error": "\u8BED\u97F3\u8F93\u5165\u4E0D\u53EF\u7528",
  "toggle.onHint": "\u5F00\u542F\u8BED\u97F3\u6717\u8BFB",
  "toggle.offHint": "\u5173\u95ED\u8BED\u97F3\u6717\u8BFB",
  "companion.onHint": "\u663E\u793A\u7A97\u53E3",
  "companion.offHint": "\u9690\u85CF\u7A97\u53E3",
  "interrupt.onHint": "\u63D2\u8BDD\u6A21\u5F0F\uFF1A\u8BF4\u8BDD\u6253\u65AD\u5F53\u524D\u56DE\u590D\u5E76\u7ACB\u5373\u53D1\u9001\uFF08\u70B9\u51FB\u5207\u6362\u4E3A\u6392\u961F\uFF09",
  "interrupt.offHint": "\u6392\u961F\u6A21\u5F0F\uFF1A\u5F53\u524D\u56DE\u590D\u7ED3\u675F\u540E\u81EA\u52A8\u53D1\u9001\uFF0C\u8FDE\u7EED\u5BF9\u8BDD\uFF08\u70B9\u51FB\u5207\u6362\u4E3A\u63D2\u8BDD\uFF09",
  "dh.onHint": "\u5F00\u542F\u6570\u5B57\u4EBA\uFF08\u56DE\u590D\u7B49\u6570\u5B57\u4EBA\u89C6\u9891\u751F\u6210\u540E TTS+\u753B\u9762\u540C\u6B65\u64AD\u653E\uFF09",
  "dh.offHint": "\u5173\u95ED\u6570\u5B57\u4EBA\uFF08\u53BB\u6389\u89C6\u9891\u751F\u6210\uFF0C\u76F4\u63A5\u7528\u63A5\u8FD1\u5373\u65F6\u7684\u8BED\u97F3\u6717\u8BFB\u56DE\u590D\uFF09",
  "balance.hint": "DeepSeek \u4F59\u989D\uFF08\u70B9\u51FB\u5237\u65B0\uFF09",
  "balance.errHint": "\u4F59\u989D\u67E5\u8BE2\u5931\u8D25\uFF0C\u70B9\u51FB\u91CD\u8BD5",
  "balance.loading": "\u4F59\u989D\u52A0\u8F7D\u4E2D\u2026",
  "persona.avatarHint": "\u6570\u5B57\u4EBA\u5F62\u8C61\uFF08\u8BF4\u8BDD\u7684\u6837\u5B50\uFF09",
  "persona.idleHint": "\u5F85\u673A\u52A8\u753B\uFF08\u53D1\u5446\u65F6\u7684\u80CC\u666F\uFF09",
  "camera.title": "\u6444\u50CF\u5934",
  "vision.chip": "\u753B\u9762 \xB7 \u70B9\u51FB\u67E5\u770B",
  "vision.chipHint": "\u70B9\u51FB\u67E5\u770B\u8FD9\u4E00\u8F6E\u5E26\u4E0A\u7684\u753B\u9762",
  "vision.hiddenHint": "\u753B\u9762\uFF1A\u5DF2\u6536\u8D77\uFF08\u70B9\u51FB\u8BA9\u5BF9\u8BDD\u91CC\u7684\u753B\u9762\u5168\u90E8\u663E\u793A\uFF09",
  "vision.shownHint": "\u753B\u9762\uFF1A\u5168\u90E8\u663E\u793A\uFF08\u70B9\u51FB\u628A\u753B\u9762\u6536\u8D77\u6765\uFF09",
  "speaker.idle": "\u58F0\u7EB9 \xB7 \u70B9\u4E00\u4E0B\u6CE8\u518C\uFF08\u8BF4\u5341\u4E8C\u79D2\uFF09",
  "speaker.recording": "\u6B63\u5728\u5F55\u97F3\uFF0C\u8BF7\u8BF4\u8BDD \xB7 \u8FD8\u5269",
  "speaker.saving": "\u58F0\u7EB9\u4FDD\u5B58\u4E2D\u2026\u2026",
  "speaker.done": "\u58F0\u7EB9\u5DF2\u6CE8\u518C",
  "speaker.error": "\u6CE8\u518C\u5931\u8D25\uFF08\u6865\u63A5\u6216\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528\uFF09"
};
var en = {
  "mic.title": "Voice input",
  "mic.listening": "Listening\u2026 click again to stop",
  "mic.transcribing": "Transcribing\u2026",
  "mic.error": "Voice input unavailable",
  "toggle.onHint": "Turn on voice reading",
  "toggle.offHint": "Turn off voice reading",
  "companion.onHint": "Show window",
  "companion.offHint": "Hide window",
  "interrupt.onHint": "Interrupt mode: speaking cuts the reply and sends immediately (click for queue)",
  "interrupt.offHint": "Queue mode: auto-sends after the current reply, for continuous conversation (click for interrupt)",
  "dh.onHint": "Turn on digital human (reply waits for the lip-synced video, then plays TTS + video together)",
  "dh.offHint": "Turn off digital human (no video generation, near-instant voice reading replies)",
  "balance.hint": "DeepSeek balance (click to refresh)",
  "balance.errHint": "Balance query failed, click to retry",
  "balance.loading": "Loading balance\u2026",
  "persona.avatarHint": "Digital-human avatar (the speaking look)",
  "persona.idleHint": "Idle animation (the background while resting)",
  "camera.title": "Camera",
  "vision.chip": "Picture \xB7 click to view",
  "vision.chipHint": "Click to see the picture sent with this turn",
  "vision.hiddenHint": "Pictures: hidden (click to show every picture)",
  "vision.shownHint": "Pictures: shown (click to hide them again)",
  "speaker.idle": "Voiceprint \xB7 click to enroll (12 s of speech)",
  "speaker.recording": "Recording \u2014 keep talking \xB7",
  "speaker.saving": "Saving the voiceprint\u2026",
  "speaker.done": "Voiceprint saved",
  "speaker.error": "Enrollment failed (bridge or mic unavailable)"
};

// src/client/index.ts
var NS = "voice";
var inject = ["slots", "locale", "sessions"];
function apply(ctx) {
  console.log("[ui-voice] loaded, bridge =", bridgeBase());
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-voice: dictionaries");
  ctx.effect(() => {
    applyVisionVisibility();
    return void 0;
  }, "ui-voice: \u753B\u9762\u53EF\u89C1\u6027");
  const speaker = new ReplySpeaker();
  ctx.effect(() => () => speaker.dispose(), "ui-voice: speaker teardown");
  const companion = new CompanionController();
  const modes = new ModeController();
  ctx.effect(() => startOpenerHiding(), "ui-voice: \u9690\u85CF\u81EA\u52A8\u5F00\u573A\u767D");
  let activeSessionId;
  const activeSession = () => {
    if (activeSessionId === void 0) return void 0;
    return ctx.sessions.binding(activeSessionId)?.session;
  };
  const vision = new VisionController();
  ctx.effect(() => () => vision.dispose(), "ui-voice: camera teardown");
  ctx.effect(() => {
    const unsubscribe = modes.subscribe(() => {
      void vision.setEnabled(modes.vision);
    });
    void vision.setEnabled(modes.vision);
    return unsubscribe;
  }, "ui-voice: camera switch");
  ctx.effect(() => {
    const unsubscribe = modes.subscribe(() => {
      vision.setCapturing(modes.mic);
    });
    vision.setCapturing(modes.mic);
    return unsubscribe;
  }, "ui-voice: capture gate");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.s2sBurst = "1";
    style.textContent = "[data-message-attachments]:has(> :nth-child(21)) > :not(:last-child) { display: none !important; }";
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, "ui-voice: collapse burst images");
  let activeTtsController = null;
  let interruptHandler = null;
  let speakerOwner = null;
  const injectFace = (sessionId) => {
    const key = sessionId === void 0 ? "__global__" : String(sessionId);
    if (sessionId !== void 0) {
      if (activeSessionId !== void 0 && activeSessionId !== sessionId) {
        if (speaker.speaking) {
          console.log("[ui-voice] session switched: stopping playback");
          noteStop("index#sendText", { speaking: speaker.speaking });
          speaker.stop();
        }
        clearPendingSmallTalkAudio();
        disarmSmallTalk();
        retireOpener();
      }
      activeSessionId = sessionId;
    }
    return {
      claimSpeaker: () => {
        if (speakerOwner === key) return;
        speakerOwner = key;
        if (speaker.speaking) {
          console.log("[ui-voice] speaker handed over to session", key);
          noteStop("index#claimSpeaker", { speaking: speaker.speaking });
          speaker.stop();
        }
      },
      sendText: async (text) => {
        if (sessionId === void 0) throw new Error("[ui-voice] no session scope for sendText");
        speakerOwner = key;
        noteStop("index#session-switch", { speaking: speaker.speaking });
        speaker.finishCurrent();
        startFillerTimeline(speaker);
        const prepared = takePendingSmallTalkAudio();
        if (prepared !== null && !modes.speaker) {
          console.log("[ui-voice] small talk dropped: the speaker switch is off");
        } else if (prepared !== null) {
          console.log("[ui-voice] small talk in 1.5s:", prepared.length, "clips");
          window.setTimeout(() => {
            if (speaker.speaking) {
              console.log("[ui-voice] small talk dropped: the answer already started");
              return;
            }
            noteSmallTalkAudioQueued(prepared);
            noteRealSpeech();
            for (const wav of prepared) speaker.speak(wav);
          }, 1500);
        }
        const binding = ctx.sessions.binding(sessionId);
        const session = binding?.session;
        if (session === void 0) throw new Error("[ui-voice] session unavailable for sendText");
        const running = session.getSnapshot()?.running === true;
        let interrupt = true;
        try {
          interrupt = localStorage.getItem("s2s.voice.interrupt") !== "0";
        } catch {
        }
        const mode = running && interrupt ? "steer" : "queue";
        const parts = await vision.attachFrame([{ type: "text", text }]);
        const result = await session.prompt(parts, mode);
        setTimeout(learnInlineAltFromDom, 1200);
        if (!result.ok) {
          throw new Error(`[ui-voice] prompt failed: ${result.error.code}: ${result.error.message}`);
        }
      },
      speaker,
      companion,
      modes,
      vision,
      // Small talk: the one short opener sent when the microphone opens, so
      // the model starts thinking right away and the silence is filled while
      // the user is still talking. The reply listener speaks it in trimmed
      // form (see voice/smalltalk.ts).
      startSmallTalk: async (previousUserText) => {
        if (sessionId === void 0) return;
        const binding = ctx.sessions.binding(sessionId);
        const session = binding?.session;
        if (session === void 0) return;
        const line = buildSmallTalkLine(previousUserText);
        if (line === "") return;
        hideOpenerText(line);
        clearPendingSmallTalkAudio();
        armSmallTalk();
        markOpenerLive();
        rememberSmallTalkLine(line);
        console.log("[ui-voice] small talk line:", line);
        const running = session.getSnapshot()?.running === true;
        const mode = running ? "steer" : "queue";
        const result = await session.prompt([{ type: "text", text: line }], mode);
        if (!result.ok) {
          disarmSmallTalk();
          retireOpener();
          console.error("[ui-voice] small talk prompt failed:", result.error.code, result.error.message);
        }
      },
      abortTts: () => {
        activeTtsController?.abort();
        activeTtsController = null;
      },
      // Internal wiring for the reply listener (not part of the public face
      // contract, but typed as the shared holders the listener fills in).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _registerTtsAbort: (controller) => {
        activeTtsController = controller;
      },
      interruptReply: () => {
        noteStop("index#barge-in", { speaking: speaker.speaking });
        speaker.stop();
        activeTtsController?.abort();
        activeTtsController = null;
        companion.notifyMicInterrupt();
        interruptHandler?.();
      },
      _registerInterruptHandler: (handler) => {
        interruptHandler = handler;
      }
    };
  };
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
    {
      name: "conversation.input.dock",
      id: "voice-toolbar",
      order: 0,
      locale: NS,
      inject: injectFace
    },
    VoiceToolbar
  ));
  ctx.slots.inject("conversation.chat.user.images", () => ctx.slots.register(
    {
      name: "conversation.chat.user.images",
      priority: 200,
      locale: NS
    },
    VisionAwareImages
  ));
  ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
    {
      name: "conversation.composer.dock",
      id: "voice-balance-badge",
      order: 1,
      locale: NS,
      inject: injectFace
    },
    BalanceBadge
  ));
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    {
      name: "conversation.input.left",
      id: "voice-reply",
      order: 90,
      locale: NS,
      inject: injectFace
    },
    ReplySpeakerMount
  ));
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    {
      name: "conversation.input.left",
      id: "voice-companion",
      order: 95,
      locale: NS,
      inject: injectFace
    },
    CompanionWindow
  ));
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    {
      name: "conversation.input.left",
      id: "voice-camera-preview",
      order: 97,
      locale: NS,
      inject: injectFace
    },
    CameraPreview
  ));
}
return module.exports; } });
