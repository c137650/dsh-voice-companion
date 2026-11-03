/**
 * ModeController: the three independent switches of the voice/camera plugin.
 *
 * The plugin answers to three questions that can be combined freely:
 *   mic     - is the microphone listening (voice in)?
 *   speaker - are replies read aloud (voice out)?
 *   vision  - is the camera open and does the model see it?
 *
 * There are no presets and no menu: the three chips in the composer row ARE the
 * control surface, and the user presses the ones they want. The flags are
 * persisted, so a reload restores the last combination. The `speaker` flag is
 * mirrored into the historical `s2s.voice.enabled` key because the reply
 * listener (and the bridge's digital-human switch) already read that key;
 * keeping it in sync means the old readers keep working.
 */

/** Historical key the reply listener and the bridge switch already read. */
export const SPEAKER_KEY = 's2s.voice.enabled'

const MIC_KEY = 's2s.voice.mic'

/** Read a persisted boolean key (default when the store is unavailable). */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return raw !== '0'
  } catch {
    return fallback
  }
}

/** Persist a boolean key; failures (private mode) are ignored. */
function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // persistence unavailable — the switch still works for this session
  }
}

export class ModeController {
  private micValue: boolean
  private speakerValue: boolean
  private visionValue: boolean
  private readonly listeners = new Set<() => void>()

  constructor() {
    // The microphone stays off until the user asks for it (an automatic
    // permission prompt on every page load is rude); the speaker keeps its
    // historical default of on.
    this.micValue = readFlag(MIC_KEY, false)
    this.speakerValue = readFlag(SPEAKER_KEY, true)
    this.visionValue = false
  }

  /** Microphone listening (voice input). */
  get mic(): boolean {
    return this.micValue
  }

  set mic(value: boolean) {
    if (this.micValue === value) return
    this.micValue = value
    writeFlag(MIC_KEY, value)
    this.notify()
  }

  /** Replies read aloud (voice output). */
  get speaker(): boolean {
    return this.speakerValue
  }

  set speaker(value: boolean) {
    if (this.speakerValue === value) return
    this.speakerValue = value
    // Mirror into the key the reply listener reads, so the switch takes
    // effect on the next reply without touching that component.
    writeFlag(SPEAKER_KEY, value)
    this.notify()
  }

  /** Camera open; the model sees the picture. */
  get vision(): boolean {
    return this.visionValue
  }

  set vision(value: boolean) {
    if (this.visionValue === value) return
    this.visionValue = value
    this.notify()
  }

  /** Subscribe to flag changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
