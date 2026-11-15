/**
 * VoiceToggle: composer tool-row switch for reply TTS reading.
 *
 * The switch itself lives in the shared ModeController (so the mode presets
 * and this chip never disagree); the controller mirrors it into the historical
 * `s2s.voice.enabled` key, which the reply listener re-reads on every snapshot
 * change — the switch therefore takes effect from the next reply.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VoiceInjected } from './contract.ts'
import { chipStyle, chipKey } from './chip.ts'
import chips from './chips.css'

/** Full toggle props: framework runtime share + `voice` locale seat + injected face. */
export type VoiceToggleProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/** Speaker glyph with sound waves (inline, follows currentColor). */
function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}

/**
 * @param props - framework runtime + locale + injected speaker (interrupt).
 */
export const VoiceToggle = memo(function VoiceToggle({ t, speaker, abortTts, modes }: VoiceToggleProps) {
  const [on, setOn] = useState<boolean>(modes.speaker)
  const [speaking, setSpeaking] = useState<boolean>(speaker.speaking)

  // Live "playing" animation while the reply speaker is actually reading.
  useEffect(() => speaker.subscribe(() => setSpeaking(speaker.speaking)), [speaker])

  // The switch lives in the shared mode controller, so the mode presets and
  // this chip always agree (and the reply listener keeps reading the same
  // persisted key it always did).
  useEffect(() => modes.subscribe(() => setOn(modes.speaker)), [modes])

  const toggle = useCallback(() => {
    const next = !modes.speaker
    modes.speaker = next
    if (!next) {
      speaker.stop()
      abortTts()
    }
  }, [modes, speaker, abortTts])

  return (
    <span
      role="button"
      tabIndex={0}
      className={[chips.chip, on ? chips.on : '', speaking ? chips.playing : ''].join(' ')}
      title={on ? t('toggle.offHint') : t('toggle.onHint')}
      aria-label={on ? t('toggle.offHint') : t('toggle.onHint')}
      aria-pressed={on}
      style={chipStyle(on)}
      onClick={toggle}
      onKeyDown={chipKey}
    >
      <SpeakerIcon />
    </span>
  )
})
