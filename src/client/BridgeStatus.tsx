/**
 * BridgeStatus: composer tool-row indicator that the voice bridge is
 * reachable.
 *
 * The bridge is a local process; it can die (a crash, a manual stop, a
 * machine that went to sleep). The plugin's node half watches it and starts
 * a new one when it stops answering — this chip is the visible half of that
 * story:
 *
 *   - bridge up      -> nothing is shown;
 *   - bridge down    -> a warning triangle that breathes while the plugin
 *                       tries to bring the bridge back (click opens the
 *                       deploy guide);
 *   - bridge back    -> a short green tick, so the user sees that the voice
 *                       path works again without reading logs.
 *
 * The polling is fast while the bridge is down (5 s) and lazy while it is
 * up (30 s).
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bridgeBase } from './bridge.ts'
import type { VoiceInjected } from './contract.ts'
import chips from './chips.css'

/** URL of the companion repo with the full deploy guide. */
const MAIN_REPO_URL = 'https://github.com/c137650/dsh-voice-companion#readme'

/** Poll interval while the bridge answers. */
const POLL_UP_MS = 30_000
/** Poll interval while the bridge is down (we expect it to come back). */
const POLL_DOWN_MS = 5_000
/** How long the "back online" tick stays. */
const RECOVERED_MS = 2_500

/** Full props: framework runtime share + `voice` locale seat + injected face. */
export type BridgeStatusProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/** Warning triangle glyph (inline, follows currentColor). */
function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

/** Check mark glyph (inline, follows currentColor). */
function TickIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/**
 * @param props - framework runtime + locale seats.
 */
export const BridgeStatus = memo(function BridgeStatus(_props: BridgeStatusProps) {
  /** null = not checked yet, true = up, false = down. */
  const [ok, setOk] = useState<boolean | null>(null)
  /** True for a short while after the bridge came back. */
  const [recovered, setRecovered] = useState(false)
  const wasDown = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer = 0
    const check = async () => {
      try {
        const controller = new AbortController()
        const abort = window.setTimeout(() => controller.abort(), 3000)
        let alive = false
        try {
          const resp = await fetch(`${bridgeBase()}/api/health`, { signal: controller.signal })
          alive = resp.ok
        } finally {
          window.clearTimeout(abort)
        }
        if (cancelled) return
        if (!alive && wasDown.current) {
          // Back online: say so for a moment.
          setRecovered(true)
          window.setTimeout(() => { if (!cancelled) setRecovered(false) }, RECOVERED_MS)
        }
        wasDown.current = !alive
        setOk(alive)
      } catch {
        if (cancelled) return
        wasDown.current = true
        setOk(false)
      }
      if (cancelled) return
      timer = window.setTimeout(() => { void check() }, ok === false ? POLL_DOWN_MS : POLL_UP_MS)
    }
    void check()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // The poll cadence follows the last known state; re-arm on every change.
  }, [ok])

  // Show nothing while up (or while the first check is pending).
  if (ok === null) return null

  if (ok === false) {
    return (
      <span
        role="button"
        tabIndex={0}
        className={`${chips.chip} ${chips.bridgeDown}`}
        title="语音桥接断开，正在自动重连……（点按查看部署指南）"
        aria-label="语音桥接断开，正在自动重连 —— 点按查看部署指南"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          padding: 0,
          border: 'none',
          borderRadius: 9,
          cursor: 'pointer',
          margin: '0 4px',
          background: 'color-mix(in srgb, var(--dsw-alias-state-danger-primary) 22%, transparent)',
          color: 'var(--dsw-alias-state-danger-primary, #e5484d)',
          transition: 'color .2s ease, background .2s ease, box-shadow .2s ease',
        }}
        onClick={() => window.open(MAIN_REPO_URL, '_blank', 'noopener')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.open(MAIN_REPO_URL, '_blank', 'noopener') } }}
      >
        <WarnIcon />
      </span>
    )
  }

  if (recovered) {
    return (
      <span
        className={`${chips.chip} ${chips.bridgeBack}`}
        title="语音桥接已恢复"
        aria-label="语音桥接已恢复"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          padding: 0,
          border: 'none',
          borderRadius: 9,
          margin: '0 4px',
          background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 20%, transparent)',
          color: 'var(--dsw-alias-state-success-primary, #30a46c)',
        }}
      >
        <TickIcon />
      </span>
    )
  }

  return null
})
