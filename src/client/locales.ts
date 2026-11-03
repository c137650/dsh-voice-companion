/** `voice` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mic.title': '语音输入',
  'mic.listening': '正在聆听…再点一下停止',
  'mic.transcribing': '识别中…',
  'mic.error': '语音输入不可用',
  'toggle.onHint': '开启语音朗读',
  'toggle.offHint': '关闭语音朗读',
  'companion.onHint': '显示窗口',
  'companion.offHint': '隐藏窗口',
  'interrupt.onHint': '插话模式：说话打断当前回复并立即发送（点击切换为排队）',
  'interrupt.offHint': '排队模式：当前回复结束后自动发送，连续对话（点击切换为插话）',
  'dh.onHint': '开启数字人（回复等数字人视频生成后 TTS+画面同步播放）',
  'dh.offHint': '关闭数字人（去掉视频生成，直接用接近即时的语音朗读回复）',
  'balance.hint': 'DeepSeek 余额（点击刷新）',
  'balance.errHint': '余额查询失败，点击重试',
  'balance.loading': '余额加载中…',
  'persona.avatarHint': '数字人形象（说话的样子）',
  'persona.idleHint': '待机动画（发呆时的背景）',
  'camera.title': '摄像头',
  'vision.chip': '画面 · 点击查看',
  'vision.chipHint': '点击查看这一轮带上的画面',
  'vision.hiddenHint': '画面：已收起（点击让对话里的画面全部显示）',
  'vision.shownHint': '画面：全部显示（点击把画面收起来）',
} satisfies Record<string, string>

/** The voice namespace key union. */
export type VoiceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mic.title': 'Voice input',
  'mic.listening': 'Listening… click again to stop',
  'mic.transcribing': 'Transcribing…',
  'mic.error': 'Voice input unavailable',
  'toggle.onHint': 'Turn on voice reading',
  'toggle.offHint': 'Turn off voice reading',
  'companion.onHint': 'Show window',
  'companion.offHint': 'Hide window',
  'interrupt.onHint': 'Interrupt mode: speaking cuts the reply and sends immediately (click for queue)',
  'interrupt.offHint': 'Queue mode: auto-sends after the current reply, for continuous conversation (click for interrupt)',
  'dh.onHint': 'Turn on digital human (reply waits for the lip-synced video, then plays TTS + video together)',
  'dh.offHint': 'Turn off digital human (no video generation, near-instant voice reading replies)',
  'balance.hint': 'DeepSeek balance (click to refresh)',
  'balance.errHint': 'Balance query failed, click to retry',
  'balance.loading': 'Loading balance…',
  'persona.avatarHint': 'Digital-human avatar (the speaking look)',
  'persona.idleHint': 'Idle animation (the background while resting)',
  'camera.title': 'Camera',
  'vision.chip': 'Picture · click to view',
  'vision.chipHint': 'Click to see the picture sent with this turn',
  'vision.hiddenHint': 'Pictures: hidden (click to show every picture)',
  'vision.shownHint': 'Pictures: shown (click to hide them again)',
} satisfies Record<VoiceKey, string>
