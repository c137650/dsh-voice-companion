/**
 * Mic control for the composer tool row (`conversation.input.left`).
 *
 * Continuous listening mode: click once to start a MicRecorder (mic-capture
 * worklet + 1800 ms silence endpointing); every silence-endpointed utterance
 * is queued, sent to the bridge /api/stt, and injected into the conversation
 * via `sendText` — serially, one at a time. Listening stays active until the
 * user clicks again (which stops the recorder and drops queued utterances).
 * Starting capture barges in on any reply being read aloud.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-chat's `useChat` into SessionStandardProps (0.1.3).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { stt, VadStream } from './bridge.ts'
import type { VoiceInjected } from './contract.ts'
import { MicRecorder } from './voice/recorder.ts'
import { assistantNodeText, chatNodes } from './voice/chat-nodes.ts'
import { clearPendingSmallTalkAudio, disarmSmallTalk, isOpenerLive, isSmallTalkReplyText, keepOpenerAlive, retireOpener, touchPendingSmallTalkAudio } from './voice/smalltalk.ts'
import { noteUserTalking } from './voice/speech-gate.ts'
import css from './MicButton.module.css'
import chips from './chips.css'

/** Full mic-control props: framework runtime share + `voice` locale seat + injected sendText. */
export type MicButtonProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

type Phase = 'idle' | 'listening' | 'transcribing' | 'rejected' | 'error'

/** Mic glyph (inline, follows currentColor). */
function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

/**
 * @param props - framework runtime + locale seats + injected sendText/speaker.
 */
export const MicButton = memo(function MicButton({ t, sendText, startSmallTalk, speaker, interruptReply, modes, useChat, useSession }: MicButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  // Voiceprint score of the last rejected utterance (shown in the tooltip).
  const [rejectedScore, setRejectedScore] = useState<number | null>(null)
  // Recording state: true while the mic hears speech (driven by the recorder's
  // onSpeakingChange — flips only, no per-chunk re-renders).
  const [voiceActive, setVoiceActive] = useState(false)
  const recorderRef = useRef<MicRecorder | null>(null)
  const queueRef = useRef<ArrayBuffer[]>([])
  const drainRunningRef = useRef(false)
  // The chat view (for the small talk's call-back line). The snapshot is kept
  // in a ref so the delayed check below reads the freshest one.
  const chat = useChat((s: never) => s)
  const chatRef = useRef(chat)
  chatRef.current = chat
  // The session snapshot: opening the microphone while the agent is already
  // producing output must NOT send an opener — that would interrupt a turn the
  // user only wanted to talk over.
  const session = useSession((s: never) => s)
  const sessionRef = useRef(session)
  sessionRef.current = session
  // The small talk fires once per microphone opening, never again in that
  // listening session.
  const smallTalkDoneRef = useRef(false)
  // Which real opening this component has already answered. On mount it is set
  // to whatever the controller has reached, so attaching to an already-open
  // microphone (switching conversations) never sends a fresh opener.
  const handledOpenRef = useRef(modes.micOpenCount)
  // When the current listening session started (the voiceprint check is
  // skipped for a moment after it, while gain control settles).
  const listenStartedAtRef = useRef(0)

  // Release the mic if the control unmounts mid-capture.
  useEffect(() => () => {
    recorderRef.current?.stop()
    recorderRef.current = null
  }, [])

  // Barge-in listening during reply playback: while the speaker is reading,
  // the recorder drops chunks (TTS echo never forms an utterance) but keeps
  // watching the level — sustained speech fires onSpeechInterrupt → the reply
  // is stopped and the user's ongoing speech becomes the next utterance.
  // The browser AEC (echoCancellation) keeps the TTS out of the mic signal.
  useEffect(() => {
    return speaker.subscribe(() => {
      const rec = recorderRef.current
      if (rec === null) return
      rec.setPaused(false)
      rec.setInterruptMode(speaker.speaking)
    })
  }, [speaker])

  // Drain queued utterances serially: STT -> send -> next (continuous mode).
  const drain = useCallback(async () => {
    if (drainRunningRef.current) return
    drainRunningRef.current = true
    try {
      while (queueRef.current.length > 0) {
        if (recorderRef.current === null) break // user stopped listening
        const pcm = queueRef.current.shift()!
        setPhase('transcribing')
        try {
          // The first second or two after the microphone opens: the browser's
          // gain control is still settling and a voiceprint taken there is
          // unreliable — do not let it throw the owner's first sentence away.
          const warmingUp = Date.now() - listenStartedAtRef.current < 3000
          const result = await stt(pcm, warmingUp)
          const text = result.text
          if (result.rejected === true) {
            // Say so instead of silently swallowing the sentence: the owner
            // needs to see that the voiceprint, not the recognizer, dropped it.
            console.log('[ui-voice] stt rejected by the voiceprint:', result.score)
            setRejectedScore(result.score ?? null)
            setPhase('rejected')
            window.setTimeout(() => {
              setPhase((current) => (current === 'rejected' ? 'listening' : current))
            }, 1500)
            continue
          }
          if (text !== undefined && text.trim() !== '') {
            // Do not await the send: session.prompt() resolves only when the
            // agent has taken the turn, and waiting here left the mic stuck in
            // "transcribing" while the model was busy. Fire and move on.
            void sendText(text.trim()).catch((err) => {
              console.error('[ui-voice] send failed:', err)
            })
            // The user really talked: the cached opener is used up, so the
            // next microphone opening starts a new one. (Done after the send
            // was handed over — the send takes the prepared clip, and it needs
            // the opener to still count as live while it does that.)
            retireOpener()
          }
        } catch (err) {
          console.error('[ui-voice] stt/send failed:', err)
        }
      }
    } finally {
      drainRunningRef.current = false
      setPhase(recorderRef.current !== null ? 'listening' : 'idle')
    }
  }, [sendText])

  const toggle = useCallback(() => {
    // The listening switch lives in the shared mode controller, so a mode
    // preset ("只播报", "只输入", …) can turn the microphone on or off and
    // this chip follows it.
    modes.mic = !modes.mic
  }, [modes])

  const stopListening = useCallback(() => {
    // The user may have opened the microphone and said nothing at all. The
    // opener that was sent for it is then NOT thrown away: it stays cached
    // (with the audio cut from its reply), so the next opening reuses it
    // instead of sending another one. Only a message the user actually sent
    // ends it.
    if (isOpenerLive()) {
      console.log('[ui-voice] mic closed without speech: keeping the cached opener')
      keepOpenerAlive()
    } else {
      clearPendingSmallTalkAudio()
      disarmSmallTalk()
    }
    smallTalkDoneRef.current = false
    if (recorderRef.current === null) return
    // Stop: end continuous listening, drop any queued utterances.
    recorderRef.current.stop()
    recorderRef.current = null
    queueRef.current = []
    noteUserTalking(false)
    setPhase('idle')
  }, [])

  const startListening = useCallback(async () => {
    if (recorderRef.current !== null) return

    // Barge-in: the user is about to speak — cut any reply being read aloud
    // AND swallow the rest of the current reply (its remaining sentences are
    // not spoken; the next reply speaks normally).
    interruptReply()

    // Small talk: once per microphone opening, send a short opener so the
    // model starts thinking right away (the silence before the first answer
    // is the part the user feels most). It runs whether or not the user
    // says anything.
    const running = (sessionRef.current as { running?: boolean } | undefined)?.running === true
    const openCount = modes.micOpenCount
    const genuineOpen = openCount !== handledOpenRef.current
    handledOpenRef.current = openCount
    if (!genuineOpen) {
      // The microphone was already on: this is a re-attach (session switched,
      // component re-mounted), not the user opening it. No opener belongs to
      // this moment.
      console.log('[ui-voice] mic already open: no opener for this attach')
      smallTalkDoneRef.current = true
    } else if (running) {
      // The agent is mid-turn: the first-opening trigger is cancelled for this
      // opening. The rest (fillers, narration) still follows the speaker
      // switch, so nothing else changes.
      console.log('[ui-voice] mic opened while the agent is running: opener skipped')
      smallTalkDoneRef.current = true
    } else if (!smallTalkDoneRef.current) {
      smallTalkDoneRef.current = true
      // The conversation snapshot loads asynchronously: right after a page
      // refresh the chat view can still be empty even though the session has
      // history. Give it a moment before deciding that this is a fresh
      // conversation — otherwise a mid-conversation opening would get one of
      // the greeting openers instead of a call-back to the last answer.
      void (async () => {
        // The opener from an earlier opening is still cached (the microphone
        // was opened before without the user saying anything): reuse it
        // instead of putting a second greeting into the conversation.
        if (isOpenerLive()) {
          console.log('[ui-voice] small talk: reusing the cached opener')
          keepOpenerAlive()
          touchPendingSmallTalkAudio()
          return
        }
        const resolvePrevious = (): string | null => {
          let previous: string | null = null
          for (const node of chatNodes(chatRef.current)) {
            if (node.kind !== 'assistant-step') continue
            const text = assistantNodeText(node)
            if (text === '' || isSmallTalkReplyText(text)) continue
            previous = text
          }
          return previous
        }
        let previous = resolvePrevious()
        if (previous === null) {
          for (let attempt = 0; attempt < 3 && previous === null; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            previous = resolvePrevious()
          }
        }
        await startSmallTalk(previous)
      })().catch((err) => {
        console.error('[ui-voice] small talk failed:', err)
      })
    }

    listenStartedAtRef.current = Date.now()
    const recorder = new MicRecorder({
      // 断句静音从 1800ms 降到 900ms：说完少等将近一秒。
      minSilenceMs: 900,
      maxUtteranceMs: 30000,
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
        // The user started talking over the reply: stop it and swallow the
        // rest; the recorder (now accumulating) turns their speech into the
        // next utterance automatically.
        interruptReply()
      },
      onSpeakingChange: (speaking) => {
        setVoiceActive(speaking)
        // Publish it: the filler timeline and the narrator both stay quiet
        // while the owner has the floor.
        noteUserTalking(speaking)
      },
      onUtterance: (pcm) => {
        // Continuous listening: queue the utterance and drain serially.
        queueRef.current.push(pcm)
        void drain()
      },
    })
    recorderRef.current = recorder
    setVoiceActive(false)
    setPhase('listening')
    try {
      await recorder.start()
    } catch (err) {
      console.error('[ui-voice] mic start failed:', err)
      recorder.stop()
      recorderRef.current = null
      setVoiceActive(false)
      setPhase('error')
    }
  }, [interruptReply, drain, startSmallTalk, chat])

  // Follow the shared mode controller: the presets and this chip drive the
  // same switch, so the microphone state is always the mode's state.
  useEffect(() => {
    const sync = (): void => {
      if (modes.mic) {
        void startListening()
      } else {
        stopListening()
      }
    }
    const unsubscribe = modes.subscribe(sync)
    sync()
    return unsubscribe
  }, [modes, startListening, stopListening])

  // Hover explanation: current state + its color meaning (no label under the
  // icon anymore). idle = off, listening+quiet = standby, listening+voice =
  // recording, transcribing = recognizing, error = unavailable.
  const statusTitle = phase === 'idle'
    ? '已关闭（灰）·点击开启聆听'
    : phase === 'error'
      ? '不可用（红）·点击重试'
      : phase === 'rejected'
        ? `声纹未通过（相似度 ${(rejectedScore ?? 0).toFixed(2)}）· 这句话没有发送`
        : phase === 'transcribing'
          ? '识别中（深绿）'
          : voiceActive ? '收音中（绿）' : '待命（蓝）'
  const className = [
    chips.chip,
    css.mic,
    phase === 'listening' ? css.listening : '',
    phase === 'transcribing' ? css.transcribing : '',
    phase === 'error' ? css.error : '',
    phase === 'listening' && voiceActive ? css.voice : '',
  ].filter(Boolean).join(' ')

  const phaseColor =
    phase === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : phase === 'rejected'
        ? 'var(--dsw-alias-state-danger-primary, #e5484d)'
        : phase === 'transcribing'
          ? 'var(--dsw-alias-state-success-primary)'
          : phase === 'listening'
          ? (voiceActive ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-business-primary)')
          : 'var(--dsw-alias-label-dimmed)'

  return (
    <span
      role="button"
      tabIndex={0}
      className={className}
      title={`${t('mic.title')} · ${statusTitle}`}
      aria-label={`${t('mic.title')} · ${statusTitle}`}
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
        position: 'relative',
        background: 'rgba(127,127,127,0.14)',
        color: phaseColor,
        boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.18)',
        transition: 'color 0.2s ease, background 0.2s ease',
      }}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
    >
      <MicIcon />
      <span className={css.waves} aria-hidden="true"><i /><i /><i /></span>
    </span>
  )
})
