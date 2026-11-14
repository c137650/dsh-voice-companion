/**
 * Browser voice plugin: the composer tool-row seat for the mic control.
 *
 * T5: capture (embedded mic-capture worklet) + silence endpointing ->
 * bridge /api/stt -> conversation.send(text). T6 adds reply TTS playback;
 * T7 the toggles; T8 the companion animation window.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-conversation's SlotMap merge so PropsRuntime resolves.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VoiceToolbar } from './VoiceToolbar.tsx'
import { BalanceBadge } from './BalanceBadge.tsx'
import { CameraPreview } from './CameraPreview.tsx'
import { ReplySpeakerMount } from './voice/reply-listener.tsx'
import { ReplySpeaker } from './voice/speaker.ts'
import { CompanionWindow } from './voice/companion.tsx'
import { CompanionController } from './voice/companion-controller.ts'
import { ModeController } from './voice/modes.ts'
import { VisionController } from './voice/vision.ts'
import { armSmallTalk, buildSmallTalkLine, clearPendingSmallTalkAudio, disarmSmallTalk, markOpenerLive, retireOpener, noteSmallTalkAudioQueued, rememberSmallTalkLine, takePendingSmallTalkAudio } from './voice/smalltalk.ts'
import { cancelFillerTimeline, noteRealSpeech, startFillerTimeline } from './voice/fillers.ts'
import { noteStop } from './voice/stop-trace.ts'
import { hideOpenerText, startOpenerHiding } from './voice/hide-opener.ts'
import { VisionAwareImages } from './VisionAwareImages.tsx'
import { applyVisionVisibility, learnInlineAltFromDom } from './vision-visibility.ts'
import { bridgeBase } from './bridge.ts'
import type { VoiceInjected } from './contract.ts'
import { en, zh, type VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The voice control's copy. */
    voice: VoiceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voice'

/** Required services: the slot registry, this plugin's copy, and the sessions service. */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Client plugin body: register the `voice` dictionaries and the mic control
 * into the composer tool row (`conversation.input.left`, a list seat beside
 * the resident chrome — never replaces it). The injected `sendText` resolves
 * the session-scoped conversation service at call time (scope addressing).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Diagnostic stamp: tells us which bundle build the browser actually runs.
  console.log('[ui-voice] loaded, bridge =', bridgeBase())

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')

  // 画面在对话里的显隐：默认收起成一个小按钮，工具栏上的芯片可以全显。
  ctx.effect(() => {
    applyVisionVisibility()
    return undefined
  }, 'ui-voice: 画面可见性')

  // One shared speaker per plugin fiber: the reply listener plays through it
  // and the companion window reads its `speaking` state.
  const speaker = new ReplySpeaker()
  ctx.effect(() => () => speaker.dispose(), 'ui-voice: speaker teardown')

  // One shared companion controller: the window renders it, the toggle flips it.
  const companion = new CompanionController()

  // The three switches (microphone / speaker / camera). One controller per
  // plugin fiber: the toolbar presets and the individual chips all drive it.
  const modes = new ModeController()

  // Small talk: the opener is a normal user message and its answer a normal
  // reply. The answer stays in the transcript; the opener itself is hidden
  // where it renders, so the page shows only what the speaker said out loud.
  ctx.effect(() => startOpenerHiding(), 'ui-voice: 隐藏自动开场白')

  // The session the camera's frames ride along with. The dock slot is
  // re-injected whenever the UI switches sessions, so the last injection
  // names the session the user is looking at.
  let activeSessionId: SessionId | undefined

  /**
   * Resolve the session the camera path submits into.
   * @returns the session handle, or undefined when no session is bound.
   */
  const activeSession = () => {
    if (activeSessionId === undefined) return undefined
    return ctx.sessions.binding(activeSessionId)?.session
  }

  // One shared camera controller: it owns the capture and the frame cache.
  // Frames are never sent on their own — they are attached to the user's own
  // turns, so the transcript stays free of camera traffic.
  const vision = new VisionController()
  ctx.effect(() => () => vision.dispose(), 'ui-voice: camera teardown')

  // The camera switch and the vision controller are two views of one fact:
  // when the camera switch flips, the camera really opens or closes. The
  // picture always comes from the computer's own webcam.
  ctx.effect(() => {
    const unsubscribe = modes.subscribe(() => {
      void vision.setEnabled(modes.vision)
    })
    // The switch may already be on (remembered from the last session).
    void vision.setEnabled(modes.vision)
    return unsubscribe
  }, 'ui-voice: camera switch')

  // The microphone switch decides whether frames are worth keeping: from the
  // moment it goes on, the picture is watched for changes and the changed
  // frames wait for the next sentence. While the microphone is off nothing is
  // stored — a still room must not cost the model anything.
  ctx.effect(() => {
    const unsubscribe = modes.subscribe(() => {
      vision.setCapturing(modes.mic)
    })
    vision.setCapturing(modes.mic)
    return unsubscribe
  }, 'ui-voice: capture gate')

  // 一轮送几十帧的时候，对话记录里那一排缩略图会糊满整屏。DSH 把一条消息的
  // 附件逐张渲染在 [data-message-attachments] 里，模型那边收到的还是全部帧，
  // 界面上只留最后一张（最后一张就是最新的一帧）。只在附件数超过 20 时生效，
  // 平时贴一两张图不受影响。
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.s2sBurst = '1'
    style.textContent = '[data-message-attachments]:has(> :nth-child(21)) > :not(:last-child) { display: none !important; }'
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, 'ui-voice: collapse burst images')

  // One shared TTS abort holder: the reply listener registers its current
  // AbortController; the voice toggle aborts it when turned off so the bridge
  // stops synthesizing (client disconnect) instead of draining its queue.
  let activeTtsController: AbortController | null = null
  // Barge-in handler registered by the reply listener (swallow the current
  // reply when the user starts speaking).
  let interruptHandler: (() => void) | null = null

  /**
   * 喇叭的归属会话。规则：
   *   - 切换会话本身不打断播放，旧会话念完为止；
   *   - 另一个会话真的要开口（claimSpeaker）时才易主；
   *   - 用户用麦克风说话（sendText）时立即易主并停掉旧音频。
   */
  let speakerOwner: string | null = null

  const injectFace = (sessionId: SessionId | undefined): VoiceInjected => {
    const key = sessionId === undefined ? '__global__' : String(sessionId)
    // The camera's frames ride along with the session the UI shows.
    if (sessionId !== undefined) {
      // Switching the conversation stops whatever was being read, NOW: the
      // reply belongs to the chat the user just left. This is the one place
      // where the clip being heard is cut — everywhere else it plays out.
      if (activeSessionId !== undefined && activeSessionId !== sessionId) {
        if (speaker.speaking) {
          console.log('[ui-voice] session switched: stopping playback')
          noteStop('index#sendText', { speaking: speaker.speaking })
          speaker.stop()
        }
        // An opener belongs to the conversation it was sent to. Carrying it
        // over would make the new conversation answer a question it never got.
        clearPendingSmallTalkAudio()
        disarmSmallTalk()
        retireOpener()
      }
      activeSessionId = sessionId
    }
    return {
    claimSpeaker: () => {
      if (speakerOwner === key) return
      speakerOwner = key
      if (speaker.speaking) {
        console.log('[ui-voice] speaker handed over to session', key)
        noteStop('index#claimSpeaker', { speaking: speaker.speaking })
        speaker.stop()
      }
    },
    sendText: async (text: string) => {
      if (sessionId === undefined) throw new Error('[ui-voice] no session scope for sendText')
      // 用麦克风说话 = 立刻把喇叭拿过来（并静音其它会话残留的播报）。
      speakerOwner = key
      noteStop('index#session-switch', { speaking: speaker.speaking })
      speaker.finishCurrent()
      // 小聊天的音频早就合成好了（用户还在说话的时候就在合成）：现在放出来，
      // 正好填上"说完 → 模型开始推理"这段沉默。稍微等一下再放——一发出消息
      // 就立刻开口太生硬，留出一点呼吸听起来更像在接话。
      startFillerTimeline(speaker)
      const prepared = takePendingSmallTalkAudio()
      if (prepared !== null && !modes.speaker) {
        // The speaker switch is off: the opener was generated (the mic opened,
        // that is its trigger) but nothing is synthesized nor played.
        console.log('[ui-voice] small talk dropped: the speaker switch is off')
      } else if (prepared !== null) {
        console.log('[ui-voice] small talk in 1.5s:', prepared.length, 'clips')
        window.setTimeout(() => {
          // The real answer may already be playing by now: the filler would
          // land after it and sound like a comment on the answer. Drop it.
          if (speaker.speaking) {
            console.log('[ui-voice] small talk dropped: the answer already started')
            return
          }
          noteSmallTalkAudioQueued(prepared)
          noteRealSpeech()
          for (const wav of prepared) speaker.speak(wav)
        }, 1500)
      }
      const binding = ctx.sessions.binding(sessionId)
      const session = binding?.session
      if (session === undefined) throw new Error('[ui-voice] session unavailable for sendText')
      // Voice input must send IMMEDIATELY: when the agent's turn is still
      // running (my reply streaming), a plain queue would sit as a pending
      // item in the input dock, needing a manual send — the "second sentence
      // stuck" bug. Default: steer, which interrupts the running turn.
      // The BusyToggle flips this to pure queue for continuous conversation
      // (let the current turn finish, then the sentence auto-sends).
      const running = session.getSnapshot()?.running === true
      let interrupt = true
      try {
        interrupt = localStorage.getItem('s2s.voice.interrupt') !== '0'
      } catch {
        // persistence unavailable — fall back to the interrupt default
      }
      const mode = running && interrupt ? 'steer' : 'queue'
      // 摄像头开着时，这一轮带上画面——模型看到的是"你说话那一刻"的场景。
      // 默认是一张拼图 + 最新全幅；旧的多帧路径由 s2s.voice.sheet=0 切回去。
      const parts = await vision.attachFrame([{ type: 'text', text }])
      const result = await session.prompt(parts, mode)
      // 记一次内联图片的通用 alt（CSS 兜底用来区分「我们的画面」和用户上传的图）。
      setTimeout(learnInlineAltFromDom, 1200)
      if (!result.ok) {
        throw new Error(`[ui-voice] prompt failed: ${result.error.code}: ${result.error.message}`)
      }
    },
    speaker,
    companion,
    modes,
    vision,
    // Small talk: the one short opener sent when the microphone opens, so
    // the model starts thinking right away and the silence is filled while
    // the user is still talking. The reply listener speaks it in trimmed
    // form (see voice/smalltalk.ts).
    startSmallTalk: async (previousUserText: string | null) => {
      if (sessionId === undefined) return
      const binding = ctx.sessions.binding(sessionId)
      const session = binding?.session
      if (session === undefined) return
      const line = buildSmallTalkLine(previousUserText)
      if (line === '') return
      // Hide the row this opener will render as (display only: the model still
      // receives it). Registered before the prompt so it never flashes.
      hideOpenerText(line)
      // A new opening: the audio prepared for the previous one is stale.
      clearPendingSmallTalkAudio()
      // Arm the reply listener BEFORE the prompt: the reply may already be
      // in the snapshot by the time we get the ack.
      armSmallTalk()
      // The opener is now live: it is reused when the microphone is opened
      // again without the user having said anything.
      markOpenerLive()
      rememberSmallTalkLine(line)
      console.log('[ui-voice] small talk line:', line)
      const running = session.getSnapshot()?.running === true
      const mode = running ? 'steer' : 'queue'
      const result = await session.prompt([{ type: 'text', text: line }], mode)
      if (!result.ok) {
        disarmSmallTalk()
        // The opener never reached the model: it is not a cached one.
        retireOpener()
        console.error('[ui-voice] small talk prompt failed:', result.error.code, result.error.message)
      }
    },
    abortTts: () => {
      activeTtsController?.abort()
      activeTtsController = null
    },
    // Internal wiring for the reply listener (not part of the public face
    // contract, but typed as the shared holders the listener fills in).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _registerTtsAbort: (controller: AbortController | null) => {
      activeTtsController = controller
    },
    interruptReply: () => {
      // Mic barge-in: the user is talking over the reply, so silence it now
      // rather than letting the sentence finish; the rest of the reply is
      // swallowed by the reply listener.
      noteStop('index#barge-in', { speaking: speaker.speaking })
      speaker.stop()
      activeTtsController?.abort()
      activeTtsController = null
      // 用户占用麦克风/说话：同时停止数字人视频播放（只停播放，不涉及
      // 桥接的生成任务与磁盘文件）。
      companion.notifyMicInterrupt()
      interruptHandler?.()
    },
    _registerInterruptHandler: (handler: (() => void) | null) => {
      interruptHandler = handler
    },
    }
  }

  // ── composer tool controls live ABOVE the input card (conversation.input.dock):
  //    one compact row (mic / toggles / bridge-status), so the card's own tool
  //    row stays short and the model select keeps its place on the same line.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    {
      name: 'conversation.input.dock',
      id: 'voice-toolbar',
      order: 0,
      locale: NS,
      inject: injectFace,
    },
    VoiceToolbar,
  ))

  // 用户消息里的图片：接管宿主的图片槽位，把「我们发的画面」收成一个小按钮，
  // 用户自己上传的图片照常显示。优先级高于宿主自带的那个（100）。
  ctx.slots.inject('conversation.chat.user.images', () => ctx.slots.register(
    {
      name: 'conversation.chat.user.images',
      priority: 200,
      locale: NS,
    },
    VisionAwareImages as never,
  ))

  // DeepSeek balance chip lives in the bottom status dock (next to the
  // turns/steps/tool-time stats line): shows ¥/USD on load; click to refresh.
  // Zero polling — the bridge caches the upstream answer 10 minutes.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    {
      name: 'conversation.composer.dock',
      id: 'voice-balance-badge',
      order: 1,
      locale: NS,
      inject: injectFace,
    },
    BalanceBadge,
  ))

  // Hidden per-session reply listener: speaks finalized assistant text.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      name: 'conversation.input.left',
      id: 'voice-reply',
      order: 90,
      locale: NS,
      inject: injectFace,
    },
    ReplySpeakerMount,
  ))

  // Full-height companion animation window (idle bg-images / speaking task-videos).
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      name: 'conversation.input.left',
      id: 'voice-companion',
      order: 95,
      locale: NS,
      inject: injectFace,
    },
    CompanionWindow,
  ))

  // Small floating window that mirrors EXACTLY what the model is looking at
  // (the last frame it was handed — it lags behind the live camera on purpose).
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      name: 'conversation.input.left',
      id: 'voice-camera-preview',
      order: 97,
      locale: NS,
      inject: injectFace,
    },
    CameraPreview,
  ))
}
