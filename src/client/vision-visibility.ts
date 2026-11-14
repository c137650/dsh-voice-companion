/**
 * 画面在对话里的可见性。
 *
 * 语音每一轮都会带上摄像头画面，那张图在对话里一览无余，看着总有点怪。
 * 这里管两件事：
 *
 *   1. **默认隐藏**：对话里的画面缩成一个「📷 画面 · 点击查看」的小按钮，
 *      点一下就地展开。真正的隐藏由 `VisionAwareImages` 这个槽位组件负责 ——
 *      它认得哪些附件是本插件发的（见 vision-ids.ts）。
 *   2. **总开关**：工具栏上的「画面」芯片可以一键全显 / 全隐，
 *      状态记在 localStorage（`s2s.voice.hideVision`）。
 *
 * 槽位组件万一没接管（宿主换了渲染路径），这里还有一层 CSS 兜底：
 * 把带图片的附件行藏起来，靠总开关再调出来。
 */

/** localStorage 键：'1' = 隐藏（默认），'0' = 全显。 */
const KEY = 's2s.voice.hideVision'

/** 状态订阅者。 */
const listeners = new Set<(hidden: boolean) => void>()

/** 槽位组件是否接管过渲染（接管后就不再用 CSS 兜底）。 */
let slotActive = false

/** 学到的「内联图片」通用 alt（内联图片没有文件名，alt 是通用标签）。 */
let inlineAlt = ''

/** 注入的样式表。 */
let styleEl: HTMLStyleElement | null = null

/**
 * 当前的隐藏状态。
 * @returns 真表示默认隐藏画面。
 */
export function visionHidden(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * 切换隐藏状态并广播。
 * @param hidden - 真表示隐藏。
 */
export function setVisionHidden(hidden: boolean): void {
  try {
    localStorage.setItem(KEY, hidden ? '1' : '0')
  } catch {
    // 存储不可用：状态只在本次会话里有效。
  }
  for (const fn of listeners) fn(hidden)
  applyVisionVisibility()
}

/**
 * 订阅隐藏状态。
 * @param fn - 状态变化时调用。
 * @returns 退订函数。
 */
export function subscribeVisionVisibility(fn: (hidden: boolean) => void): () => void {
  listeners.add(fn)
  fn(visionHidden())
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 槽位组件接管渲染时调用一次：之后不再用 CSS 兜底。
 */
export function markVisionSlotActive(): void {
  if (slotActive) return
  slotActive = true
  applyVisionVisibility()
}

/**
 * 记住内联图片的通用 alt（CSS 兜底要靠它精确区分内联图片和用户上传的图片）。
 * @param alt - 从 DOM 上读到的 alt 文本。
 */
export function learnInlineAlt(alt: string): void {
  if (alt === '' || alt === inlineAlt) return
  inlineAlt = alt
  applyVisionVisibility()
}

/**
 * 从 DOM 里学一次内联图片的通用 alt。
 *
 * 内联图片（提示里的图片）没有文件名，alt 是宿主的通用标签；用户自己上传的
 * 图片 alt 是文件名。发送一轮之后看一眼最后一张图的 alt，就知道通用标签是什么。
 */
export function learnInlineAltFromDom(): void {
  const images = document.querySelectorAll('[data-message-attachments] img')
  const last = images[images.length - 1]
  const alt = last?.getAttribute('alt') ?? ''
  if (alt !== '') learnInlineAlt(alt)
}

/**
 * 把当前状态落到 DOM：body 类 + 兜底样式。
 */
export function applyVisionVisibility(): void {
  const hidden = visionHidden()
  document.body.classList.toggle('s2s-vision-hidden', hidden)
  if (styleEl === null) {
    styleEl = document.createElement('style')
    styleEl.dataset.s2sVision = '1'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = cssRules(hidden)
}

/**
 * 兜底样式。
 *
 * 槽位组件接管后（slotActive）不需要它 —— 画面已经被换成了小按钮。
 * 没接管时：优先用学到的通用 alt 精确命中内联图片；学不到就先把
 * 「带图片的附件行」整体藏起来（宁可多藏，也不要把用户的截图漏出去）。
 *
 * @param hidden - 当前是否处于隐藏状态。
 * @returns 样式表文本。
 */
function cssRules(hidden: boolean): string {
  if (!hidden) return ''
  if (slotActive) return ''
  if (inlineAlt !== '') {
    return `body.s2s-vision-hidden [data-message-attachments]:has(img[alt="${escapeAttr(inlineAlt)}"]) { display: none !important; }`
  }
  return 'body.s2s-vision-hidden [data-message-attachments]:has(img) { display: none !important; }'
}

/**
 * 给属性选择器里的值转义（引号和反斜杠）。
 * @param value - 原始文本。
 * @returns 可直接放进 [attr="..."] 的文本。
 */
function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
