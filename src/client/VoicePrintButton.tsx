/**
 * VoicePrintButton: register the owner's voice with one click.
 *
 * The bridge keeps a 192-dimensional cam++ embedding of the owner and drops
 * other voices on /api/stt. Registering it used to mean recording a wav by
 * hand and converting it with ffmpeg — this chip records straight from the
 * microphone instead: click, speak for about twelve seconds, done.
 *
 * Everything stays local (the browser talks to 127.0.0.1 only).
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { enrollSpeaker } from './bridge.ts'
import type { VoiceInjected } from './contract.ts'
import chips from './chips.css'

/** How long one enrollment recording lasts. */
const RECORD_MS = 12_000
/** The bridge wants 16 kHz mono PCM16. */
const TARGET_RATE = 16_000

/** Full props: dock runtime share + `voice` locale seat + injected face. */
export type VoicePrintButtonProps =
  PropsRuntime<'conversation.input.dock'> & PropsLocale<'voice'> & VoiceInjected

type Phase = 'idle' | 'recording' | 'saving' | 'done' | 'error'

/** Fingerprint glyph (inline, follows currentColor). */
function PrintIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 10a2 2 0 0 1 2 2v3" />
      <path d="M8 12a4 4 0 0 1 8 0v4" />
      <path d="M5 12a7 7 0 0 1 14 0v3" />
      <path d="M12 18v2" />
    </svg>
  )
}

/** Convert float samples to little-endian PCM16. */
function toPcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out.buffer
}

/** Linear resample; browsers do not always honour a requested sample rate. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input
  const ratio = to / from
  const length = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio
    const low = Math.floor(position)
    const high = Math.min(input.length - 1, low + 1)
    const weight = position - low
    out[i] = (input[low] ?? 0) * (1 - weight) + (input[high] ?? 0) * weight
  }
  return out
}

/**
 * @param props - locale + injected face.
 */
export const VoicePrintButton = memo(function VoicePrintButton({ t }: VoicePrintButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [seconds, setSeconds] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)

  // Release the device if the chip unmounts mid-recording.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void ctxRef.current?.close().catch(() => undefined)
  }, [])

  const start = useCallback(async () => {
    if (phase === 'recording' || phase === 'saving') return
    setPhase('recording')
    setSeconds(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const ctx = new AudioContext()
      ctxRef.current = ctx
      await ctx.resume().catch(() => undefined)
      const source = ctx.createMediaStreamSource(stream)
      const collector = ctx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []
      collector.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(collector)
      collector.connect(ctx.destination)

      const startedAt = Date.now()
      const timer = window.setInterval(() => {
        setSeconds(Math.min(RECORD_MS, Date.now() - startedAt) / 1000)
      }, 200)

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, RECORD_MS)
      })
      window.clearInterval(timer)

      collector.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      streamRef.current = null

      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const merged = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      const mono16k = resample(merged, ctx.sampleRate, TARGET_RATE)
      await ctx.close().catch(() => undefined)
      ctxRef.current = null

      setPhase('saving')
      await enrollSpeaker(toPcm16(mono16k))
      setPhase('done')
      window.setTimeout(() => setPhase('idle'), 2500)
    } catch (err) {
      console.error('[ui-voice] voiceprint enrollment failed:', err)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setPhase('error')
      window.setTimeout(() => setPhase('idle'), 3000)
    }
  }, [phase])

  const label = phase === 'recording'
    ? `${t('speaker.recording')} ${Math.max(0, Math.ceil(RECORD_MS / 1000 - seconds))}s`
    : phase === 'saving'
      ? t('speaker.saving')
      : phase === 'done'
        ? t('speaker.done')
        : phase === 'error'
          ? t('speaker.error')
          : t('speaker.idle')

  const color = phase === 'recording'
    ? 'var(--dsw-alias-state-danger-primary, #e5484d)'
    : phase === 'done'
      ? 'var(--dsw-alias-state-success-primary, #30a46c)'
      : phase === 'error'
        ? 'var(--dsw-alias-state-danger-primary, #e5484d)'
        : 'var(--dsw-alias-label-dimmed)'

  return (
    <span
      role="button"
      tabIndex={0}
      className={chips.chip}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        padding: 0,
        border: 'none',
        borderRadius: 9,
        cursor: phase === 'recording' || phase === 'saving' ? 'progress' : 'pointer',
        margin: '0 4px',
        background: 'rgba(127,127,127,0.14)',
        color,
        boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.18)',
        transition: 'color 0.2s ease, background 0.2s ease',
      }}
      onClick={() => { void start() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void start()
        }
      }}
    >
      <PrintIcon />
    </span>
  )
})
