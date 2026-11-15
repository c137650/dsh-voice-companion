/**
 * Fillers: short pre-synthesized lines that keep the voice path alive while
 * the model works.
 *
 * The audio is rendered once (bridge/fillers/*.wav) and served by
 * `/api/filler/{group}` — playing one costs a local fetch, not an inference,
 * and the bridge picks a random clip from the group every time. Nothing here
 * touches the conversation: a filler is never sent to the model and never
 * enters the transcript.
 *
 * The schedule is deliberately short. It used to be a ladder — notice at 24 s,
 * working lines at 1/2/4/8 minutes, a closing line at 12 — and that ladder is
 * gone: progress is now narrated for real (see voice/narrate.ts), so a fixed
 * cadence only competes with it.
 *
 * What is left:
 *
 *   - 3 s: the thinking sound (语气词). Unchanged — it is the sound of the
 *     model starting to work, not an announcement;
 *   - 10 s: ONE working line, played only if nothing has been said out loud
 *     by then. Once the answer starts speaking the whole timeline is
 *     cancelled, so this line means "10 seconds of silence, one word to show
 *     the line is still open" — and nothing after it.
 *
 * What counts as "said": anything that carries the model's own voice — the
 * opener's clip, a reply sentence, a narration sentence. It decides the 3 s
 * step only: if the opener's audio already played, the ear has had its
 * 语气词, so the thinking sound is skipped. The 10 s working line is a
 * different question — it asks "has the ANSWER started?" — and the answer
 * starting is what cancels this whole timeline.
 *
 * Everything here follows the SPEAKER switch, never the microphone: the
 * narration and the fillers keep working after the mic is closed.
 */
import { bridgeBase, readVoiceEnabled } from '../bridge.ts'
import { isUserTalking } from './speech-gate.ts'
import type { ReplySpeaker } from './speaker.ts'

/** One pre-synthesized clip. */
type Clip = ArrayBuffer

/** Filler groups served by the bridge. */
export type FillerGroup = 'thinking' | 'working' | 'notice' | 'close'

/**
 * Fetch one filler clip — no caching: the bridge chooses a random clip of the
 * group per request, and caching would pin the same line for the whole
 * session.
 *
 * @param group - which shelf to pick from.
 * @returns the WAV bytes, or null when the bridge has none.
 */
async function fetchFiller(group: FillerGroup): Promise<Clip | null> {
  try {
    const resp = await fetch(`${bridgeBase()}/api/filler/${group}`, { cache: 'no-store' })
    if (!resp.ok) return null
    return await resp.arrayBuffer()
  } catch {
    return null
  }
}

/** One scheduled step, measured from the moment the turn's message went out. */
interface Step {
  atMs: number
  group: FillerGroup
  played: boolean
}

/**
 * The whole schedule of one turn.
 *
 * Two steps, both absolute: the thinking sound at 3 s, the single working line
 * at 10 s. Nothing repeats, nothing restarts the count — the model either
 * starts talking (which cancels the timeline) or it does not.
 */
const STEPS: Array<{ atMs: number; group: FillerGroup }> = [
  { atMs: 3_000, group: 'thinking' },
  { atMs: 10_000, group: 'working' },
]

/** One turn's filler timeline. */
export class FillerTimeline {
  private speaker: ReplySpeaker
  private steps: Step[] = []
  private timers: number[] = []
  private cancelled = false
  /** When this turn's countdown started. */
  private base = 0
  /** Waiting for the previous turn's audio to finish. */
  private unwatch: (() => void) | null = null
  /** Until when a filler is expected to be audible. */
  private playingUntil = 0
  /** When this turn last said something real (0 = not yet in this turn). */
  private spokenAt = 0

  /**
   * @param speaker - the shared player (fillers go through the same queue).
   */
  constructor(speaker: ReplySpeaker) {
    this.speaker = speaker
  }

  /** Note that this turn said something real. */
  markSpoken(): void {
    this.spokenAt = Date.now()
  }

  /** Arm the timeline for a fresh turn. */
  start(): void {
    this.cancelled = false
    this.steps = STEPS.map((step) => ({ ...step, played: false }))
    this.clearTimers()
    // Already waiting for the room to go quiet: the clock is not restarted.
    if (this.unwatch !== null) return
    // The previous turn's last sentence may still be finishing: the clock
    // starts when the room goes quiet, not when the message arrived. Otherwise
    // the 3 s mark would fire into a busy speaker and be lost.
    if (this.speaker.speaking) {
      this.armWhenQuiet()
      return
    }
    this.arm()
  }

  /** Start the countdown from now. */
  private arm(): void {
    this.base = Date.now()
    for (const step of this.steps) {
      const delay = Math.max(0, this.base + step.atMs - Date.now())
      const id = window.setTimeout(() => {
        if (this.cancelled) return
        if (step.played) return
        void this.play(step)
      }, delay)
      this.timers.push(id)
    }
  }

  /** Wait for the speaker to go quiet, then start the countdown. */
  private armWhenQuiet(): void {
    this.stopWatching()
    this.unwatch = this.speaker.subscribe(() => {
      if (this.cancelled) {
        this.stopWatching()
        return
      }
      if (this.speaker.speaking) return
      this.stopWatching()
      if (this.cancelled) return
      this.arm()
    })
  }

  private stopWatching(): void {
    if (this.unwatch !== null) {
      this.unwatch()
      this.unwatch = null
    }
  }

  /**
   * Disarm the timeline.
   *
   * @param stopPlaying - cut a filler that is being heard right now. Off by
   *        default: the answer simply queues behind it.
   */
  cancel(stopPlaying = false): void {
    this.cancelled = true
    this.clearTimers()
    this.stopWatching()
    if (stopPlaying && Date.now() < this.playingUntil) this.speaker.stop()
  }

  /** Whether a filler is audible right now. */
  playingNow(): boolean {
    return Date.now() < this.playingUntil
  }

  /**
   * Play one step.
   *
   * The answer may have started speaking between the timer firing and the clip
   * arriving — that is what the cancelled/speaking checks are for.
   */
  private async play(step: Step): Promise<void> {
    if (this.cancelled) return
    // The speaker switch, not the microphone, decides whether anything is said.
    if (!readVoiceEnabled()) return
    // The owner has the floor: a filler over their sentence is the one thing
    // that must never happen.
    if (isUserTalking()) return
    if (this.speaker.speaking) return
    // The thinking sound speaks into true silence only: if the opener's clip
    // already played this turn, skip it and leave the floor to the 10 s line.
    if (step.group === 'thinking' && this.spokenAt >= this.base) return
    const clip = await fetchFiller(step.group)
    if (clip === null || this.cancelled) return
    if (this.speaker.speaking) return
    const duration = wavDurationMs(clip)
    step.played = true
    this.playingUntil = Date.now() + duration
    this.speaker.speak(clip)
  }

  private clearTimers(): void {
    for (const id of this.timers) window.clearTimeout(id)
    this.timers = []
  }
}

/**
 * Read a PCM WAV's duration from its header.
 *
 * @param buffer - a WAV file.
 * @returns the duration in milliseconds (0 when the header is unreadable).
 */
function wavDurationMs(buffer: ArrayBuffer): number {
  try {
    const view = new DataView(buffer)
    if (view.byteLength < 44) return 0
    const byteRate = view.getUint32(28, true)
    const dataBytes = view.getUint32(40, true)
    if (byteRate <= 0) return 0
    return Math.round((dataBytes / byteRate) * 1000)
  } catch {
    return 0
  }
}

/**
 * Note that the turn just said something real.
 *
 * Called whenever model audio is queued — a reply sentence, a small-talk clip
 * or a narration sentence. It is what makes the 10 s working line mean
 * "silence so far" instead of "10 s have passed". It belongs to the timeline
 * (and so to its conversation): speech in another conversation must not
 * silence this one's 语气词.
 */
export function noteRealSpeech(): void {
  if (current === null) return
  current.markSpoken()
}

/**
 * The timeline of the current turn.
 *
 * It belongs to ONE conversation: the fillers (语气词, the working line) are
 * about the turn the user is watching, so a turn the user walked away from
 * must not keep its countdown. The owner is remembered, and a timeline armed
 * for another conversation is dropped instead of taking over.
 */
let current: FillerTimeline | null = null
/** The conversation the current timeline belongs to ('' = unknown). */
let currentOwner = ''
/** When a turn last asked for a timeline (two call sites arm the same turn). */
let lastArmRequest = 0

/**
 * Arm the filler timeline for a new turn.
 *
 * @param speaker - the shared player.
 * @param owner - the conversation this turn belongs to.
 */
export function startFillerTimeline(speaker: ReplySpeaker, owner = ''): void {
  // Another conversation: its countdown is over. Dropping it here is what
  // stops the 语气词 and the working line of a turn the user switched away
  // from — they used to keep running (the timeline was a module-level
  // singleton) and fired in whatever conversation came next.
  if (current !== null && owner !== '' && currentOwner !== '' && owner !== currentOwner) {
    current.cancel(false)
    current = null
    lastArmRequest = 0
  }
  if (current === null) current = new FillerTimeline(speaker)
  if (owner !== '') currentOwner = owner
  // Two call sites arm the same turn — the voice send and the new user node
  // that lands right after it. Re-arming milliseconds later would push the
  // 3 s / 10 s marks back, so a turn already armed keeps its clock.
  if (Date.now() - lastArmRequest < 2_000) return
  lastArmRequest = Date.now()
  current.start()
}

/**
 * Disarm the timeline — the real answer is starting (or the turn is over).
 *
 * @param stopPlaying - cut a filler that is being heard right now.
 * @param owner - only disarm when the timeline belongs to this conversation.
 */
export function cancelFillerTimeline(stopPlaying = false, owner?: string): void {
  if (owner !== undefined && currentOwner !== '' && owner !== currentOwner) return
  current?.cancel(stopPlaying)
}

/**
 * Whether a filler is audible right now.
 *
 * The reply listener uses this to leave a filler alone: cutting it mid-word to
 * start the answer reads as a glitch, and the answer queues behind it anyway.
 *
 * @returns true while a filler is expected to be playing.
 */
export function fillerPlaying(): boolean {
  return current !== null && current.playingNow()
}
