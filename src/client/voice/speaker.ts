/**
 * ReplySpeaker: plays synthesized reply WAVs through an AudioContext as a
 * FIFO queue (sentence streaming). `speak()` enqueues; the drain plays one
 * clip at a time and `onended` advances to the next, so sentence N+1 starts
 * the moment N finishes (gaps between clips are tiny). `speaking` stays true
 * while anything is queued or playing, so the companion window and the mic
 * echo-guard follow the whole reply, not individual clips.
 *
 * Interruption: `stop()` halts the current clip and clears the queue; a
 * generation counter discards clips that were queued but not yet started.
 */
export class ReplySpeaker {
  private ctx: AudioContext | null = null
  private queue: ArrayBuffer[] = []
  private playing: AudioBufferSourceNode | null = null
  private drainRunning = false
  private gen = 0
  private disposed = false
  private listeners = new Set<() => void>()

  /** True while a reply is being read (playing or waiting in the queue). */
  get speaking(): boolean {
    return this.playing !== null || this.queue.length > 0
  }

  /** Subscribe to speaking-state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Enqueue one clip for playback (order preserved; plays after earlier clips). */
  speak(wav: ArrayBuffer): void {
    if (this.disposed) return
    this.queue.push(wav)
    this.emit()
    void this.drain()
  }

  /**
   * Resume the context if the browser suspended it.
   *
   * Called before every drain attempt: a suspended context plays nothing and
   * never reports an end, which is what left the queue stuck.
   */
  private async ensureRunning(ctx: AudioContext): Promise<void> {
    if (ctx.state !== 'suspended') return
    try {
      await ctx.resume()
    } catch {
      // best-effort: the watchdog above still frees the queue
    }
  }

  private async drain(): Promise<void> {
    if (this.drainRunning) return
    this.drainRunning = true
    try {
      const ctx = this.ctx ?? (this.ctx = new AudioContext())
      await this.ensureRunning(ctx)
      while (this.queue.length > 0 && !this.disposed) {
        const wav = this.queue.shift()!
        await this.playOne(ctx, wav)
      }
    } finally {
      this.drainRunning = false
      this.emit()
    }
  }

  private playOne(ctx: AudioContext, wav: ArrayBuffer): Promise<void> {
    const gen = this.gen
    return new Promise((resolve) => {
      void ctx.decodeAudioData(wav)
        .then((buffer) => {
          if (this.disposed || gen !== this.gen) {
            resolve()
            return
          }
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)
          this.playing = source
          this.emit()
          // Watchdog: `onended` is the ONLY thing that advances the queue, and
          // it does not fire when the AudioContext is suspended mid-clip (a
          // device change, the browser's autoplay policy after a long idle, a
          // throttled tab). The clip then stayed "playing" forever, so `speak()`
          // only ever queued: the reply text was on screen and silent, the
          // narration saw `speaking === true` and stayed quiet too, and flipping
          // the speaker switch (which calls stop()) was the only way out — the
          // exact "turn the speaker off and on and it works for a while" report.
          // A clip cannot outlast its own duration; past that, assume the end.
          const guard = window.setTimeout(() => {
            if (this.playing !== source) return
            try {
              source.stop()
            } catch {
              // already stopped
            }
            this.playing = null
            this.emit()
            resolve()
          }, Math.max(2_000, buffer.duration * 1_000 + 4_000))
          source.onended = () => {
            window.clearTimeout(guard)
            if (this.playing === source) {
              this.playing = null
              this.emit()
            }
            resolve()
          }
          source.start()
        })
        .catch(() => resolve())
    })
  }

  /**
   * Let the clip that is playing finish, then go quiet.
   *
   * Sentences are synthesized one by one, so a new turn arriving between two
   * of them should not chop the one being heard: the queue is dropped, the
   * current clip plays to its end, and whatever comes next plays after it.
   */
  finishCurrent(): void {
    this.gen += 1
    this.queue = []
    this.emit()
  }

  /** Stop the current clip immediately and clear the queued ones. */
  stop(): void {
    this.gen += 1
    if (this.playing !== null) {
      try {
        this.playing.stop()
      } catch {
        // already stopped
      }
      this.playing = null
    }
    this.queue = []
    this.emit()
  }

  /** Release the AudioContext (plugin teardown). */
  dispose(): void {
    this.disposed = true
    this.stop()
    if (this.ctx !== null) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
    }
    this.listeners.clear()
  }
}
