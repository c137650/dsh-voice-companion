# DSH 语音 AI 女友 Plus（dsh-voice-companion）

DeepSeek Harness 的**浏览器语音插件**：麦克风语音输入、回复朗读（TTS）、AI 女友动画窗、摄像头实时画面。

本仓库是 [beiyege-01/dsh-voice-ai-girlfriend](https://github.com/beiyege-01/dsh-voice-ai-girlfriend) 的延续版本：沿用同一套架构与判据，把插件重新打包成独立仓库，改名为 `@c137650/dsh-voice-companion`。

> ⚠️ **它由两部分组成，缺一不可**
>
> | | 位置 | 干什么 |
> |---|---|---|
> | **前端** | `src/` → `lib/client.js` | DSH 客户端插件：麦克风、工具栏、拼帧、拼图、陪伴窗 |
> | **后端** | `bridge/`（`voice_bridge.py`） | 本地 Python 服务（`:8765`）：FunASR 识别、GPT-SoVITS 合成、摄像头取帧 |
>
> **前端会自动把后端挂起来**——DSH 启动时插件的 node 半边会探一下 `http://127.0.0.1:8765/api/health`，没回应就自己拉起 uvicorn（详见 §8）。所以正常情况下你只要装好模型、装好插件，剩下的事插件自己会做。

---

## 目录

1. [安装方式](#1-安装方式)
2. [依赖的库](#2-依赖的库)
3. [目录结构](#3-目录结构)
4. [配置和使用说明](#4-配置和使用说明)
5. [GPT-SoVITS](#5-gpt-sovits)
6. [模型链接](#6-模型链接)
7. [数字人部分](#7-数字人部分没有改动)
8. [前端插件与后端桥接](#8-插件分两部分前端插件会自动挂起后端)

---

## 1. 安装方式

### 1.1 先决条件

| 东西 | 版本 | 说明 |
|---|---|---|
| DeepSeek Harness | 0.1.3 及以后 | 客户端插件走 `dsh.bundle` manifest + 槽位协议 |
| Node.js | ≥ 20 | 构建前端 bundle（`node build.mjs`） |
| Python | 3.10 ~ 3.13 | 后端桥接；需要能装 torch / funasr |
| 显卡 | 建议 6 GB 以上 | STT（FunASR）与 TTS（GPT-SoVITS）都跑在本地；没有显卡也能跑，只是慢 |
| GPT-SoVITS | v3 系列 | 合成引擎，见 §5 |

### 1.2 装后端（voice bridge）

```bash
git clone https://github.com/c137650/dsh-voice-companion.git
cd dsh-voice-companion

# Python 环境：仓库里的 venv 或已有的 conda 环境都行
python -m venv venv-speech
venv-speech\Scripts\pip install -r bridge\requirements.txt      # Windows
# source venv-speech/bin/activate && pip install -r bridge/requirements.txt   # Linux/macOS
```

然后按 [§6 模型链接](#6-模型链接) 把三个模型放进 `models/`：

```
models/
├─ funasr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/   # STT
└─ silero-vad/silero_vad_v4.jit                                                  # VAD（打断）
```

再把参考音频与参考文本放到 `voices/reference/`（或直接用 §6 给的链接下载），
把 `bridge/bridge-config.json` 复制一份改自己的路径：

```bash
cp bridge/bridge-config.example.json bridge/bridge-config.json
```

最后启动：

```bash
cd bridge
..\venv-speech\Scripts\python.exe -m uvicorn voice_bridge:app --host 127.0.0.1 --port 8765
```

Windows 下也可以直接双击 `bridge/start-bridge.cmd`（它会自动找 `venv-speech` 或
`E:\anaconda\envs\tts0\python.exe`）；`bridge/start-all.cmd` 更进一步，会把
桥接 + DSH GUI + 浏览器一起拉起来（需要先设好环境变量 `DSH_HARNESS`）。

健康检查：

```bash
curl http://127.0.0.1:8765/api/health
# {"status":"ok","stt":true,"tts":true,...}
```

### 1.3 装前端插件

```bash
dsh plugin --profile web add github:c137650/dsh-voice-companion
```

> pnpm ≥ 10 对 git 依赖的构建脚本有 `allowBuilds` 限制：按安装时 pnpm 打印的提示，
> 在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 里加一行允许 `esbuild`，然后重跑。

**手动安装**（开发时用）：

```bash
cd dsh-voice-companion
npm install
node build.mjs                       # 产出 lib/index.js（node 半边）+ lib/client.js（浏览器包）
```

再把仓库链接进 profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "@c137650/dsh-voice-companion": "link:E:/dsh-voice-companion"
  }
}
```

装完刷新一次 GUI 页面（浏览器端插件包是页面加载时取的，不刷新看不到新东西）。

---

## 2. 依赖的库

### 2.1 前端（Node / 浏览器）

| 依赖 | 用途 | 许可 |
|---|---|---|
| `react` ^18.2（peer） | 工具栏、陪伴窗、芯片等 UI | MIT |
| `esbuild` ^0.25 | 打包 `src/` → `lib/client.js` | MIT |
| `typescript` ^5 | 类型检查 | Apache-2.0 |
| `@types/react` | 类型 | MIT |
| `@deepseek-ai/dsh-client-runtime` / `-locale` / `-ui-conversation` | DSH 客户端 API（宿主提供，不随包发布） | MIT |

前端**不联网**：所有语音、图像处理都在本机后端完成。

### 2.2 后端（Python）

| 依赖 | 用途 |
|---|---|
| `fastapi` + `uvicorn` | HTTP/WebSocket 服务（`:8765`） |
| `funasr` + `modelscope` | STT：中文语音识别（paraformer-large） |
| `speech-to-speech` 0.2.10 | 拉进 `torch` / `torchaudio` / `transformers` / `numpy` |
| `numpy` | 数值计算（HSV 网格、指纹） |
| `opencv-python` | 摄像头取帧、ROI 裁剪、HSV 网格 |
| `soundfile` + `scipy` | 音频读写与重采样 |
| `pilk` | 音频格式转换 |
| `httpx` | 调 GPT-SoVITS（`:9880`）与 MiniMax 视觉接口 |
| `pydantic` | 配置与请求体 |

完整的 `bridge/requirements.txt` 就在仓库里。

### 2.3 外部服务（可选）

| 服务 | 用途 | 不配会怎样 |
|---|---|---|
| **GPT-SoVITS** `:9880` | TTS 合成 | 桥接会尝试按 `tts.gptsovits.autostart` 自己拉起来；拉不起来就没有声音 |
| **silero-vad** | 语音打断（VAD） | 缺模型时退化为固定静音阈值，打断会迟钝 |
| **MiniMax 视觉接口** | `POST /api/vision` 让多模态模型描述视频 | 只有手动调这个接口才用得上；主流程不依赖 |
| **DeepSeek API key** | 工具栏余额 badge | 不填就没有余额显示 |

---

## 3. 目录结构

```
dsh-voice-companion/
├─ src/                          ← 前端源码（DSH 客户端插件）
│  ├─ index.ts                   node 半边：DSH 启动时把后端桥接拉起来
│  ├─ client/
│  │  ├─ index.ts                浏览器半边：槽位注册、发送、工具栏
│  │  ├─ VoiceToolbar.tsx        工具栏一整行（麦克风/喇叭/摄像头/数字人/待机/插话/画面）
│  │  ├─ VisionAwareImages.tsx   接管图片槽位：我们的画面收成小按钮
│  │  ├─ VisionToggle.tsx        眼睛芯片：画面全显 / 全隐
│  │  ├─ vision-visibility.ts    画面显隐状态 + CSS 兜底
│  │  └─ voice/
│  │     ├─ sheet.ts             拼帧判据 + 拼图排版
│  │     ├─ seenow/              dsh-see-now 的打分代码（Apache-2.0，带 NOTICE）
│  │     ├─ camera.ts            摄像头采样
│  │     ├─ vision.ts            一轮附带画面（拼图路径 / 旧的多帧路径）
│  │     ├─ recorder.ts          麦克风录制（16 kHz PCM16）
│  │     ├─ reply-listener.tsx   回复逐句朗读
│  │     ├─ speaker.ts           播放 / 打断
│  │     ├─ companion.tsx        陪伴动画窗
│  │     └─ modes.ts             三个开关（听/说/看）
│  └─ worklets/mic-capture.ts    浏览器端采集 worklet
├─ lib/                          ← 构建产物（已提交，克隆即用）
│  ├─ index.js                   node 半边
│  └─ client.js                  浏览器包
├─ bridge/                       ← 后端（voice bridge）
│  ├─ voice_bridge.py            FastAPI 服务：STT / TTS / 摄像头 / 数字人
│  ├─ requirements.txt
│  ├─ bridge-config.example.json 配置样例（复制成 bridge-config.json 再改）
│  ├─ start-all.cmd              一键：桥接 + DSH GUI + 浏览器
│  ├─ start-bridge.cmd           只启动桥接
│  ├─ smoke_stt.py / smoke_tts.py                 冒烟测试
│  └─ docker-compose-5060ti.yml  数字人（DUIX）的容器编排
├─ models/                       ← 模型放这里（不提交，见 §6）
├─ assets/                       ← 待机动画 / 说话视频素材（可选）
├─ voices/                       ← 参考音频 / 参考文本（可选）
├─ docs/
│  ├─ INTEGRATION_LOG.md         集成过程记录
│  ├─ UPSTREAM_README.md         上游仓库的原始 README（未改动）
│  └─ README-plugin.md           插件自己的详细笔记（阈值、标定、调试口径）
├─ test-sheet.mjs                离线验证留帧判据
├─ build.mjs                     构建脚本
├─ LICENSE                       Apache-2.0
└─ README.md
```

---

## 4. 配置和使用说明

### 4.1 后端配置 `bridge/bridge-config.json`

```jsonc
{
  "host": "127.0.0.1",
  "port": 8765,
  "cors_origins": ["*"],

  "stt": {                                   // 语音识别
    "backend": "funasr",
    "model_name": "models/funasr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "device": "cuda",
    "torch_dtype": "float16",
    "language": "zh"
  },

  "tts": {
    "engine": "gptsovits",
    "gptsovits": {
      "base": "http://127.0.0.1:9880",      // GPT-SoVITS 的 api_v2 端口
      "autostart": true,                     // 桥接自己把 GPT-SoVITS 拉起来
      "python": "E:/tts/GPT-SoVITS-v3lora-20250228/runtime/python.exe",
      "cwd": "E:/tts/GPT-SoVITS-v3lora-20250228",
      "args": ["api_v2.py", "-a", "127.0.0.1", "-p", "9880",
               "-c", "GPT_SoVITS/configs/tts_infer.yaml"],
      "gpt_weights": "GPT_weights/bronya-e10.ckpt",     // ← 换成你的权重
      "sovits_weights": "SoVITS_weights/bronya_e10_s320.pth",
      "prompt_text": "参考音频里念的那句台词",           // ← 必须和 ref_audio 对得上
      "text_lang": "zh",
      "prompt_lang": "zh",
      "timeout_sec": 300
    }
  },

  "camera": {                                // 摄像头
    "enabled": true,
    "device_index": 0,                      // 电脑摄像头序号
    "max_side": 640,                        // 取帧缩放后的最长边
    "quality": 60,                          // JPEG 质量
    "roi": { "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5 }   // 可选：只取中间那一块
  },

  "vision": {                               // 可选：让多模态模型描述视频（手动调用）
    "enabled": true,
    "api_key": "",                          // 或环境变量 MINIMAX_API_KEY
    "base_url": "https://api.minimaxi.com/v1",
    "model": "MiniMax-M3.1-Flash",
    "fps": 1.0,
    "ffmpeg": "E:/tts/ffmpeg-.../bin/ffmpeg.exe"     // 非 MP4 容器时用来转码
  },

  "digital_human": { "enabled": false, "duix_base": "http://127.0.0.1:9000" },
  "media": { "bg_images_dir": "assets/bg-images", "task_videos_dir": "assets/task-videos" },
  "persona": { "default_voice": "reference", "default_avatar": "my_avatar.mp4", "default_idle": "default" },
  "deepseek": { "api_key": "" }             // 余额 badge 用
}
```

### 4.2 前端开关（localStorage，改完刷新页面即生效）

| 键 | 默认 | 作用 |
|---|---|---|
| `s2s.voice.enabled` | `'1'` | 语音总闸。**关掉时逐句 TTS 与数字人提交都不发生** |
| `s2s.voice.interrupt` | `'1'` | 亮=说话打断回复；灭=回复读完排队接上 |
| `s2s.voice.bridge` | `http://127.0.0.1:8765` | 桥接地址 |
| `s2s.voice.sheet` | `'1'` | `'0'` 切回旧的多帧路径（一轮最多 80 张）做对比 |
| `s2s.voice.hideVision` | `'1'` | `'0'` 让对话里的画面永远显示（默认收成小按钮） |
| `s2s.voice.sheet.debug` | 未设 | `'1'` 调试口径：统计量换成「变了多少格」、打分提到 ~30 fps、事件前回看 3 帧 |

### 4.3 工具栏

从左到右：桥接状态 → 人设 → 麦克风 → 喇叭 → 摄像头 → 数字人 → 陪伴窗 → 插话/排队 → 眼睛（画面显隐）。

- **麦克风**：按住/点击开始录音，自动端点（静音 ~1.2 秒收尾），识别完直接进对话
- **喇叭**：回复逐句朗读；麦克风说话时立刻抢喇叭并停掉旧音频
- **摄像头**：本机摄像头取帧（由后端 OpenCV 直接开设备，**浏览器不弹权限框**）
- **数字人**：把回复交给 DUIX 生成视频并同步播放（关掉＝直接朗读）
- **眼睛**：画面在对话里默认收成「📷 画面 · 点击查看」，这个芯片一键全显/全隐

### 4.4 一轮带多少帧：拼图

旧做法是「攒到 80 张，一轮全发」——实测一轮约 **3.3 万视觉 token**，几轮就把上下文撑满。
现在改成**拼帧**（思路来自 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)，Apache-2.0）：

- **打分**：后端每帧顺带算一张 64×36 的 HSV 网格（OpenCV 一次 resize + 一次转 HSV），
  前端按「色相环形差 + 饱和度降权 + 明度差」算出 0–255 的变化分，打分 12 fps
- **留帧判据**：三条——切点（分数 ≥ 12 且是邻帧 2.5 倍以上、距上刀 ≥ 0.4 秒）、
  积分（每帧分累加，攒够 `5 × 12 × 3 = 180` 才留一帧；安静的房间永远攒不够）、
  兜底（静满 20 秒给一张）；再加一道去重（和上一张太像就不留）
- **拼图**：留下的帧等分排进一张 1024 宽的画布，格子保持源画面宽高比，帧号烧在角标上
- **上限**：一张最多 9 格（3×3）；超了挤掉「和左右邻居最像」的那张，首尾不动

结果：同一轮，旧路径 80 张 ≈ 3.3 万 token；拼图路径 1 张拼图 ≈ 500 token。

阈值是按本机摄像头标定的（不是照抄 see-now 的屏幕口径）：

| 情形 | 变化分 |
|---|---|
| 静止 / 传感器噪声 | p50 = 1.9，p90 = 6.5，p99 = 11.0 |
| 平移 15px / 30px / 60px | 22.7 / 37.4 / 59.5 |
| 亮度 ±15%（自动曝光） | 22 ~ 30 |
| 一个人入画（占宽 12%） | 7.9 |

于是 `cutAbs = 12`（噪声碰不到）、`refScore = 5`（安静房间 3 秒攒不够）、`dupMin = 3.5`（压在噪声地板 p75 = 3.3 之上）。
换机器或换摄像头时按这张表重新标一次即可。

### 4.5 为什么没有「观察轮次」

DSH 的会话层只有一条把内容送给模型的通道：`session.prompt()`。凡是通过它送进去的内容，
都会作为一条用户消息留在对话记录里，没有隐形/后台通道。所以「让模型按固定节奏自己开口」
和「界面上不出现这些消息」无法同时成立。本插件选了后者：帧在后台攒，等你开口时随那一轮一起送。

---

## 5. GPT-SoVITS

语音合成用的是本地 **[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)**（零样本 TTS，几秒参考音频就能克隆音色）。

### 5.1 它在链路里的位置

```
DSH 回复文本
   ↓  POST /api/tts  {"text": "…"}
本仓库 bridge/voice_bridge.py （:8765）
   ↓  HTTP  POST /tts  {"text":…, "ref_audio_path":…, "prompt_text":…}
GPT-SoVITS api_v2.py （:9880）
   ↓  wav
bridge 返 16 kHz PCM16 → 浏览器播放
```

### 5.2 准备

1. 按官方文档装好 GPT-SoVITS 并跑通 `api_v2.py`：

   ```bash
   cd GPT-SoVITS-v3lora-20250228
   runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
   ```

2. 把训练好的权重放进 `GPT_weights/` 和 `SoVITS_weights/`，在
   `bridge-config.json` 的 `tts.gptsovits` 里指过去：

   ```jsonc
   "gpt_weights": "GPT_weights/你的名字-e10.ckpt",
   "sovits_weights": "SoVITS_weights/你的名字_e10_s320.pth"
   ```

3. 准备参考音频 + 参考文本（见 §6 的下载链接）：
   - 参考音频放进 `voices/reference/ref_audio.wav`
   - `ref_text` 必须**逐字对应**音频里念的内容，否则音色会飘
   - `prompt_lang` = `zh`、`text_lang` = `zh`

4. `autostart: true` 时，桥接发现 `:9880` 没回应会自己把 GPT-SoVITS 拉起来
   （`startup_timeout_sec` 默认 240 秒，模型冷启动要 1~3 分钟）。

### 5.3 试一下

```bash
curl -s -X POST http://127.0.0.1:8765/api/tts \
  -H "Content-Type: application/json" -d '{"text":"测试一下声音"}' --output test.wav
```

> ⚠️ 换音色只要改 `ref_audio` / `prompt_text`（或 `persona.default_voice`），
> 不用改代码、不用重启桥接。

---

## 6. 模型链接

三个模型都不在仓库里（体积大），按下面的链接自取，放进 `models/`：

### 6.1 语音模型 + 参考音频

🔗 **<https://www.ai-hobbyist.com/thread-551-1-1.html>**

页面上是本项目用的 **GPT-SoVITS 语音模型权重**与**参考音频**（含参考文本）。
下载后：

- 权重放进 GPT-SoVITS 的 `GPT_weights/` 与 `SoVITS_weights/`（见 §5.2）
- 参考音频放成 `voices/reference/ref_audio.wav`
- 参考文本（音频里念的那句）填进 `bridge-config.json` 的 `tts.gptsovits.prompt_text`

### 6.2 STT（语音识别）

🔗 **<https://ai.gitcode.com/m0_74196153/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch>**

FunASR 的中文 paraformer-large（16 kHz，8404 词表）。放进：

```
models/funasr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/
```

目录结构（`model.pt`、`config.yaml`、`tokens.json`、`am.mvn`、`seg_dict` 等）保持原样即可。
`bridge-config.json` 里 `stt.model_name` 指的就是这个路径。

### 6.3 VAD（打断用的端点检测）

🔗 **<https://github.com/snakers4/silero-vad/tree/v4.0/files/silero_vad.jit>**

silero-vad v4.0 的 JIT 模型，放成：

```
models/silero-vad/silero_vad_v4.jit
```

缺它也能跑，只是打断会退化成固定静音阈值、迟钝一些。

### 6.4 汇总

| 用途 | 下载 | 放到哪 |
|---|---|---|
| 语音模型 + 参考音频 | <https://www.ai-hobbyist.com/thread-551-1-1.html> | GPT-SoVITS 的 `GPT_weights/` `SoVITS_weights/`；参考音频 `voices/reference/ref_audio.wav` |
| STT | <https://ai.gitcode.com/m0_74196153/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch> | `models/funasr/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/` |
| VAD | <https://github.com/snakers4/silero-vad/tree/v4.0/files/silero_vad.jit> | `models/silero-vad/silero_vad_v4.jit` |
| GPT-SoVITS 本体 | <https://github.com/RVC-Boss/GPT-SoVITS> | 装好后按 §5.2 指路 |

---

## 7. 数字人部分没有改动

**数字人（DUIX avatar）这部分和上游一模一样，本仓库没有改动它。** 具体包括：

- `bridge-config.json` 的 `digital_human` 段（`duix_base`、`data_dir`、`container_name`、重试与轮询参数）
- `bridge/voice_bridge.py` 里的 `/api/dh/speak`、`/api/dh/discard`、`/api/dh/status`、`/api/dh/enable`、`/api/dh/history`
- `bridge/docker-compose-5060ti.yml`（DUIX 容器的编排）
- 前端的数字人开关与「生成中绿光 / 分段进度」

要改数字人，请看上游仓库：
🔗 <https://github.com/beiyege-01/dsh-voice-ai-girlfriend>

一句话说明它做什么：把回复文本交给本地 DUIX（`:9000`）生成说话视频，然后**用视频代替朗读**——
所以数字人关掉时回复就是纯 TTS 朗读，开掉时是画面 + 同步声音；它跟着语音总闸走。

> 不装数字人也不影响其它功能：`digital_human.enabled` 设为 `false` 即可。

---

## 8. 插件分两部分：前端插件会自动挂起后端

### 8.1 两个半边

| | 文件 | 运行在哪 | 职责 |
|---|---|---|---|
| **node 半边** | `src/index.ts` → `lib/index.js` | DSH 进程（Node） | 启动时保证后端桥接活着；掉线时看门狗把它拉回来；顺带预热模型 |
| **浏览器半边** | `src/client/**` → `lib/client.js` | GUI 页面（浏览器/Electron） | 麦克风采集、工具栏、拼帧、拼图、发送、播放、陪伴窗 |

两端之间只靠 HTTP/WebSocket 说话（`http://127.0.0.1:8765`），
所以**桥接可以独立运行**（`start-bridge.cmd`），也可以由插件代劳。

### 8.2 自动挂起后端的逻辑

DSH 启动 → 插件的 node 半边被加载 → 它做三件事：

1. **探活**：`GET http://127.0.0.1:8765/api/health`，1.5 秒内有 2xx 就**什么都不做**
   （你手工起的、或上次开机留下的桥接，原样留着）
2. **拉起**：没回应就 `spawn` 一个 detached 的 uvicorn（不弹控制台窗口，DSH 关了它也还在），
   工作目录是找到的 `bridge/` 目录
3. **预热**：轮询到健康检查通过后，请求一次 `POST /api/warmup`，
   把 STT / TTS 模型提前加载好——否则第一句话要等冷启动（10~60 秒）

找 `bridge/` 目录的顺序：

1. 环境变量 `VOICE_BRIDGE_DIR`
2. `<插件目录>/bridge`（从本仓库安装时的默认位置 ✓）
3. `E:\dsh-voice-ai-girlfriend-main\bridge`（旧布局，向后兼容）

环境变量一览：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VOICE_BRIDGE_PYTHON` | `E:\anaconda\envs\tts0\python.exe` | 用哪个 Python 起桥接 |
| `VOICE_BRIDGE_DIR` | 自动查找 | 桥接目录 |
| `VOICE_BRIDGE_PORT` | `8765` | 桥接端口 |
| `VOICE_BRIDGE_WATCHDOG` | 开 | 设成 `0` 关掉看门狗（不想让插件自动重启桥接时用） |
| `VOICE_BRIDGE_WATCHDOG_INTERVAL` | `15000` | 看门狗探活间隔（毫秒） |
| `VOICE_BRIDGE_WATCHDOG_FAILS` | `3` | 连续几次探不到就算掉线 |

### 8.3 自己手动起也行

```bash
cd bridge
python -m uvicorn voice_bridge:app --host 127.0.0.1 --port 8765
```

自动与手动不冲突：健康检查通过时插件不会重复拉起。

### 8.4 掉线检测与自动重连

桥接是一个本地进程，它会崩（模型崩、机器睡眠、手工停掉、端口被占）。
插件不打算让这件事变成"麦克风突然不能用了"，所以前后端各管一半：

**node 半边（看门狗）**——`src/index.ts`：

- 每 15 秒探一次 `GET /api/health`；
- 连续 3 次探不到（≈45 秒静默）就判定桥接没了，重新 spawn 一个；
- 等它起来（最多 120 秒），起来后自动 `POST /api/warmup`，第一句话不用等冷启动；
- 还是没起来就退避重试：30 秒 → 60 秒 → 120 秒（封顶）；
- **一次慢回答不会误伤**：要连续 3 次探不到才动手；
- 桥接被 spawn 时 stdout/stderr 落到 `bridge/bridge.log`——崩了的时候，
  那里还留着原因（DSH 一关，管道就断了，文件不会）。

**浏览器半边**：

- 所有桥接请求都经过一层重试：只有"连接层失败"（桥接正好在重启）才重试一次，
  已经拿到 HTTP 响应的请求不重试（服务器答过了，再来一遍只是白干活）；
- VAD 的 WebSocket 断了会自己重连（2 秒后），用户不用重新开口；
- 工具栏上的芯片跟着状态走：
  - 桥接正常 → 不显示任何东西；
  - 桥接断了 → 红色警告三角在呼吸（提示"正在自动重连"），点开是部署指南；
  - 桥接回来 → 闪一下绿色对勾，让人知道语音又通了。

> 看门狗是**插件的 node 半边**在 DSH 进程里跑的，所以改完插件代码要**重启一次 DSH** 才生效。
> 不方便重启时，可以先用一个独立的守护进程顶上（效果一样）：
>
> ```bash
> node tools/voice-watchdog.mjs
> ```

---

## 致谢与许可

- 本仓库 **Apache-2.0**（见 `LICENSE`，逐字原文；署名与出处见 `NOTICE`）
- 拼帧判据移植自 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0），
  署名与许可文本见 `src/client/voice/seenow/NOTICE` 与 `src/client/voice/seenow/LICENSE`
- 后端部分沿用 [speech-to-speech](https://github.com/huggingface/speech-to-speech)（Apache-2.0）
- DSH 客户端插件结构来自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）
- 上游仓库：<https://github.com/beiyege-01/dsh-voice-ai-girlfriend>

### 附：推不动 `git push` 的时候

有些网络下 `github.com:443` 会被重置（DNS 指到的那个边缘节点连不上），
`git push` 会直接失败，但 `api.github.com` 是通的。
仓库里放了一个绕路的脚本，把工作树通过 Git Data API 传上去：

```bash
node tools/push-via-api.mjs
```

它读 Git 凭据存储里的凭据，建 tree → commit → 更新 `refs/heads/main`，
效果和 `git push` 一样（不需要在仓库里存任何 token）。
