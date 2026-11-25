/**
 * CameraToggle: the composer chip that opens the camera.
 *
 * The chip is a view of one fact (`modes.vision`); the camera itself lives in
 * the shared VisionController, so the chip only flips the switch and shows
 * the camera's lifecycle state:
 *
 *   off      - grey, the camera is closed
 *   starting - amber, the bridge is opening the device
 *   on       - green pulse, frames are flowing to the model
 *   error    - red, the camera could not be opened (click to retry)
 */
import { memo, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VoiceInjected } from './contract.ts'
import { chipStyle, chipKey } from './chip.ts'
import chips from './chips.css'

/** Full toggle props: framework runtime share + `voice` locale seat + injected face. */
export type CameraToggleProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/** Camera glyph (inline, follows currentColor). */
function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  )
}

/**
 * @param props - framework runtime + locale seats + injected modes/vision.
 */
export const CameraToggle = memo(function CameraToggle({ t, modes, vision }: CameraToggleProps) {
  const [state, setState] = useState(vision.status)

  // The camera controller owns the truth; the chip only mirrors it.
  useEffect(() => vision.subscribe(setState), [vision])

  const on = modes.vision
  const toggle = (): void => {
    modes.vision = !modes.vision
  }

  const statusTitle =
    state === 'error'
      ? `摄像头不可用（红）·${vision.error ?? '点击重试'}`
      : state === 'starting'
        ? '正在打开摄像头…（画面由本地桥接从电脑摄像头抓取）'
        : on
          ? '摄像头已开（绿）·模型正在看画面，点击关闭'
          : '已关闭（灰）·点击打开摄像头，模型就能看到画面'

  const color =
    state === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : state === 'starting'
        ? 'var(--dsw-alias-state-warning-primary)'
        : on
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-label-dimmed)'

  // The camera chip wears its own colours (green = live, amber = starting,
  // red = failed) instead of the generic business-blue of the other chips.
  const style = {
    ...chipStyle(on),
    color,
    background: on
      ? `color-mix(in srgb, ${color} 22%, transparent)`
      : 'rgba(127,127,127,0.14)',
    boxShadow: on
      ? `inset 0 0 0 1px color-mix(in srgb, ${color} 62%, transparent)`
      : 'inset 0 0 0 1px rgba(127,127,127,0.18)',
    position: 'relative' as const,
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={[chips.chip, on ? chips.on : ''].join(' ')}
      title={`${t('camera.title')} · ${statusTitle}`}
      aria-label={`${t('camera.title')} · ${statusTitle}`}
      aria-pressed={on}
      style={style}
      onClick={toggle}
      onKeyDown={chipKey}
    >
      <CameraIcon />
      {on ? <span className={chips.camDot} aria-hidden="true" /> : null}
    </span>
  )
})
