/**
 * VisionToggle: 工具栏上「画面显不显」的芯片。
 *
 * 语音每一轮都会带上摄像头画面，默认在对话里收成一个小按钮（点一下展开）。
 * 这个芯片是全局开关：隐藏时显示闭眼，全显时显示睁眼。
 */
import { memo, useEffect, useState } from 'react'
import { setVisionHidden, subscribeVisionVisibility, visionHidden } from './vision-visibility.ts'
import type { VoiceKey } from './locales.ts'
import { chipStyle, chipKey } from './chip.ts'
import chips from './chips.css'

/** 芯片属性：只需要本插件自己的词典。 */
interface VisionToggleProps {
  t?: (key: VoiceKey) => string
}

/** 睁眼（画面全显）。 */
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/** 闭眼（画面已收起）。 */
function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

/**
 * @returns 芯片。
 */
export const VisionToggle = memo(function VisionToggle({ t }: VisionToggleProps) {
  const [hidden, setHidden] = useState(visionHidden())

  useEffect(() => subscribeVisionVisibility(setHidden), [])

  const title = hidden
    ? (t?.('vision.hiddenHint') ?? '画面：已收起（点击让对话里的画面全部显示）')
    : (t?.('vision.shownHint') ?? '画面：全部显示（点击把画面收起来）')

  const style = {
    ...chipStyle(!hidden),
    color: hidden
      ? 'var(--dsw-alias-label-dimmed, #888)'
      : 'var(--dsw-alias-state-success-primary, #3a9)',
    background: hidden
      ? 'rgba(127,127,127,0.14)'
      : `color-mix(in srgb, var(--dsw-alias-state-success-primary, #3a9) 22%, transparent)`,
    boxShadow: hidden
      ? 'inset 0 0 0 1px rgba(127,127,127,0.18)'
      : 'inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-success-primary, #3a9) 62%, transparent)',
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={[chips.chip, hidden ? '' : chips.on].join(' ')}
      title={title}
      aria-label={title}
      aria-pressed={!hidden}
      style={style}
      onClick={() => setVisionHidden(!hidden)}
      onKeyDown={chipKey}
    >
      {hidden ? <EyeOffIcon /> : <EyeIcon />}
    </span>
  )
})
