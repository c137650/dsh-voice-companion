/**
 * ui-voice slot contract: the registrant-side props composition for the
 * conversation-owned `conversation.input.left` slot, plus the injected face
 * the plugin apply provides (sendText bound to the session-scoped
 * conversation service).
 */

import type { CompanionController } from './voice/companion-controller.ts'
import type { ReplySpeaker } from './voice/speaker.ts'
import type { ModeController } from './voice/modes.ts'
import type { VisionController } from './voice/vision.ts'

/** Injected behavior face the voice components receive from the plugin apply. */
export interface VoiceInjected {
  /**
   * Send a recognized utterance into the current session as a user prompt
   * (equivalent to typing it). Rejects when no session scope or the
   * conversation service is unavailable.
   * @param text - recognized utterance text.
   */
  sendText: (text: string) => Promise<void>
  /** Plays synthesized reply audio; one shared instance per plugin fiber. */
  speaker: ReplySpeaker
  /** Shared companion-window visibility (rendered by the window, flipped by the toggle). */
  companion: CompanionController
  /** The three switches (microphone / speaker / camera) and the presets. */
  modes: ModeController
  /** The camera controller: capture, frame cache, observation turns. */
  vision: VisionController
  /**
   * Abort any TTS request currently in flight (the reply listener registers
   * its AbortController here; the voice toggle calls this when turned off so
   * the backend stops synthesizing instead of draining its queue).
   */
  abortTts: () => void
  /**
   * 某个会话要开始出声前调用：喇叭若归别的会话，先把它停掉再交给本会话。
   * 切换会话本身不会打断播放（旧会话会继续念完），只有"另一会话真的有新
   * 内容要说"或用户用麦克风说话时，喇叭才会易主。
   */
  claimSpeaker: () => void
  /**
   * Internal wiring (plugin-private): the reply listener registers its
   * current TTS AbortController so `abortTts()` can cancel it.
   */
  _registerTtsAbort: (controller: AbortController | null) => void
  /**
   * Mic barge-in: stop playback, abort the in-flight TTS request, and ask the
   * reply listener to swallow the rest of the current reply (its remaining
   * sentences are not spoken; the next reply speaks normally).
   */
  interruptReply: () => void
  /**
   * Internal wiring (plugin-private): the reply listener registers a handler
   * invoked by `interruptReply()` to mark its current reply as interrupted.
   */
  _registerInterruptHandler: (handler: (() => void) | null) => void
}
