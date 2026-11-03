/**
 * CameraPreview: the small floating window that mirrors the camera.
 *
 * The big picture is the LIVE frame (the sampling loop runs at 10 fps), so the
 * window shows the camera the moment the switch is flipped, whether or not a
 * single word has been spoken. The footer keeps the honest other half: when
 * the model last actually received a frame, because frames only ride along
 * with a turn.
 *
 * The window is draggable: pointer-down grabs it, and the position is
 * remembered in localStorage so it stays where it was put.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VoiceInjected } from './contract.ts'
import css from './CameraPreview.module.css'

/** Full props: framework runtime share + `voice` locale seat + injected face. */
export type CameraPreviewProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/** Where the saved window position lives. */
const POS_KEY = 's2s.voice.previewPos'

/** A remembered window position, in viewport pixels. */
interface Pos {
  x: number
  y: number
}

/** Read the saved window position (null = default corner). */
function readPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<Pos>
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

/** Remember the window position. */
function savePos(pos: Pos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    // persistence unavailable — the window still drags, it just forgets
  }
}

/** One sampled / delivered picture plus the moment it arrived. */
interface Shot {
  data: string
  at: number
}

/** "刚刚" / "3 秒前" / "还没…" for a picture age. */
function ageLabel(age: number | null, empty: string): string {
  if (age === null) return empty
  if (age < 1.5) return '刚刚'
  if (age < 60) return `${Math.round(age)} 秒前`
  return `${Math.round(age / 60)} 分钟前`
}

/**
 * @param props - framework runtime + locale seats + injected modes/vision.
 */
export const CameraPreview = memo(function CameraPreview({ modes, vision }: CameraPreviewProps) {
  const [open, setOpen] = useState(modes.vision)
  const [live, setLive] = useState<Shot | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(() => vision.lastDelivered?.at ?? null)
  const [now, setNow] = useState(() => performance.now())
  const [pos, setPos] = useState<Pos | null>(() => readPos())
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  // Follow the camera switch: the window exists only while the camera is on.
  useEffect(() => modes.subscribe(() => setOpen(modes.vision)), [modes])

  // The live picture (10 fps while the camera is open).
  useEffect(() => vision.subscribeLive((frame) => {
    if (frame === null) {
      setLive(null)
      return
    }
    setLive({ data: frame.data, at: frame.at })
  }), [vision])

  // The other half of the truth: when the model last got one.
  useEffect(() => vision.subscribeDelivery((frame) => {
    setSentAt(frame === null ? null : performance.now())
  }), [vision])

  // Keep both age labels ticking (the pictures do not change between events,
  // the ages do).
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(performance.now()), 500)
    return () => clearInterval(timer)
  }, [open])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const box = event.currentTarget.getBoundingClientRect()
    dragRef.current = { dx: event.clientX - box.left, dy: event.clientY - box.top }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    const width = event.currentTarget.offsetWidth
    const height = event.currentTarget.offsetHeight
    const x = Math.min(Math.max(0, event.clientX - drag.dx), window.innerWidth - width)
    const y = Math.min(Math.max(0, event.clientY - drag.dy), window.innerHeight - height)
    setPos({ x, y })
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // capture already gone (pointer cancelled) — nothing to release
    }
    if (pos !== null) savePos(pos)
  }, [pos])

  if (!open) return null

  const liveAge = live === null ? null : Math.max(0, (now - live.at) / 1000)
  const sentAge = sentAt === null ? null : Math.max(0, (now - sentAt) / 1000)

  const style = pos === null
    ? undefined
    : { left: pos.x, top: pos.y, right: 'auto' as const, bottom: 'auto' as const }

  return (
    <div
      className={css.wrap}
      style={style}
      title="摄像头实时画面（拖动可以挪位置）"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className={css.head}>
        <span className={css.dot} aria-hidden="true" />
        <span className={css.title}>摄像头</span>
        <span className={css.age}>{ageLabel(liveAge, '等待画面')}</span>
      </div>
      {live === null
        ? <div className={css.empty}>摄像头正在打开…</div>
        : <img className={css.frame} alt="摄像头实时画面" src={`data:image/jpeg;base64,${live.data}`} draggable={false} />}
      <div className={css.foot}>
        <span className={css.footLabel}>模型最后收到</span>
        <span className={css.footValue}>{ageLabel(sentAge, '还没有')}</span>
      </div>
    </div>
  )
})
