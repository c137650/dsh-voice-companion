/**
 * MicRecorder: mic capture with silence-based utterance endpointing.
 *
 * Reuses the embedded mic-capture AudioWorklet (16 kHz PCM16 chunks at ~40 ms
 * plus per-chunk RMS). The main thread accumulates chunks and, once speech has
 * started, ends the utterance after `minSilenceMs` of RMS below threshold
 * (or `maxUtteranceMs` hard cap), then hands the concatenated PCM16 to
 * `onUtterance`. One utterance per activation: the caller stops the recorder
 * after the callback fires (click-to-speak-one-turn semantics; continuous
 * listening is a T7 enhancement).
 */
import { MIC_CAPTURE_WORKLET_SOURCE } from '../worklets/mic-capture.ts'
import type { VadStream } from '../bridge.ts'

const DEFAULT_MIN_SILENCE_MS = 1800
const DEFAULT_MAX_UTTERANCE_MS = 30000
/** Linear amplitude threshold (~ -40 dBFS). */
const DEFAULT_RMS_THRESHOLD = 0.01

export interface MicRecorderOptions {
  minSilenceMs?: number
  maxUtteranceMs?: number
  rmsThreshold?: number
  /** Streamed to the bridge's silero VAD while a reply is playing; its
   *  `speech_start` is the barge-in trigger. When absent, the recorder falls
   *  back to the RMS heuristics below (interruptThreshold / hold / confirm). */
  vad?: VadStream
  /** RMS threshold for barge-in detection during playback (fallback path). */
  interruptThreshold?: number
  /** Sustained above-threshold time (ms) before a barge-in fires (fallback). */
  interruptHoldMs?: number
  /** After a barge-in fires, keep requiring the signal for this long before
   *  accumulating — a false alarm never becomes an utterance (fallback). */
  interruptConfirmMs?: number
  /** Noise gate threshold in dBFS (0 or undefined = disabled). Quiet ambient
   *  audio below this level is faded out of the SENT mic stream — mirrors the
   *  original project's worklet gate (the attack/hold/release envelope
   *  already lives in the embedded worklet; this just arms it). */
  noiseGateDb?: number
  /** 片段最短时长（毫秒）：短于此的声音按噪音丢弃，不发出去识别。 */
  minUtteranceMs?: number
  /** Called once when speech is detected while a reply is playing (barge-in);
   *  the recorder then switches back to normal accumulation so the user's
   *  ongoing speech becomes the next utterance. */
  onSpeechInterrupt?: () => void
  /** Called when the "currently capturing speech" flag flips (true = voice
   *  level above threshold detected, false = utterance ended). The UI uses it
   *  to show the recording state without per-chunk re-renders. */
  onSpeakingChange?: (speaking: boolean) => void
  /** Called once with the complete silence-endpointed utterance (PCM16). */
  onUtterance: (pcm16: ArrayBuffer) => void
}

/** Default barge-in level (~ -24 dBFS) and hold time.
 *  0.06 is well above TTS echo residue that slips past browser AEC, so a
 *  reply playing by itself rarely trips the interrupt; real speech is
 *  typically much louder than this. */
const DEFAULT_INTERRUPT_THRESHOLD = 0.06
const DEFAULT_INTERRUPT_HOLD_MS = 250
/** After a barge-in fires, the signal must STILL be above threshold for this
 *  long before the recorder starts accumulating — otherwise the "interrupt"
 *  was ambient noise / TTS echo and nothing is ever spoken. */
const DEFAULT_INTERRUPT_CONFIRM_MS = 180

export class MicRecorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private chunks: ArrayBuffer[] = []
  private chunkBytes = 0
  private speaking = false
  private lastVoiceAt = 0
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private released = false
  private paused = false
  private interruptMode = false
  private interruptArmed = false
  /** 确认窗已经走完，后续的块开始累积（见 onChunk / onLevel）。 */
  private confirmed = false
  /** 最近约 600 毫秒的音频：打断确认后用它把话头补回来。 */
  private preroll: ArrayBuffer[] = []
  private prerollBytes = 0
  /** 打断已确认、正在把用户的话记下来。 */
  private capturing = false
  private interruptHoldStart = 0
  private confirmArmed = false
  private confirmStart = 0

  constructor(private readonly opts: MicRecorderOptions) {}

  get active(): boolean {
    return !this.released && this.ctx !== null
  }

  /**
   * Pause/resume capture. While paused, incoming chunks and levels are
   * dropped (nothing accumulates, no endpointing fires). Used sparingly —
   * during playback we use {@link setInterruptMode} instead so barge-in
   * detection keeps running.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    if (paused) this.resetBuffers()
  }

  /**
   * Barge-in listening mode (during reply playback): chunks are streamed to
   * the bridge's silero VAD (never accumulated), which fires `speech_start`
   * only for a REAL human voice — TTS echo / music / ambient noise cannot
   * trip it. On `speech_start` the recorder leaves interrupt mode and the
   * user's ongoing speech accumulates normally.
   */
  setInterruptMode(enabled: boolean): void {
    if (this.interruptMode === enabled) return
    this.interruptMode = enabled
    this.interruptArmed = false
    this.confirmArmed = false
    this.confirmed = false
    if (enabled) {
      this.opts.vad?.open(() => this.onVadSpeechStart())
    } else {
      this.opts.vad?.close()
      this.resetBuffers()
    }
  }

  /** Bridge VAD heard a real voice: stop the reply and accumulate the user's
   *  ongoing speech. (silero's speech_start is already the confirmation — no
   *  RMS hold/confirm heuristics needed on this path.) */
  private onVadSpeechStart(): void {
    if (!this.interruptMode) return
    this.interruptMode = false
    this.interruptArmed = false
    this.confirmArmed = false
    this.resetBuffers()
    // silero already confirmed a real voice: keep whatever the pre-roll holds
    // and start accumulating from the next chunk.
    this.confirmed = true
    this.opts.onSpeechInterrupt?.()
  }

  private resetBuffers(): void {
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
    this.chunks = []
    this.chunkBytes = 0
    this.preroll = []
    this.prerollBytes = 0
    this.capturing = false
    this.speaking = false
    this.interruptArmed = false
    this.confirmArmed = false
  }

  /** Acquire the mic and start the capture worklet. */
  async start(): Promise<void> {
    this.released = false
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.stream = stream
    const workletUrl = URL.createObjectURL(
      new Blob([MIC_CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }),
    )
    try {
      await ctx.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'mic-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { chunkMs: 40 },
    })
    // Arm the noise gate (mirrors the original project): quiet ambient audio
    // below `noiseGateDb` is faded out of the SENT stream. The worklet already
    // carries the full attack/hold/release envelope — this message enables it.
    const gateDb = this.opts.noiseGateDb
    // dBFS values are NEGATIVE (e.g. -35); 0 or undefined means disabled —
    // a `> 0` guard would silently never arm the gate and ambient noise
    // would reach STT untouched (phantom messages).
    if (gateDb !== undefined && gateDb !== 0) {
      node.port.postMessage({ kind: 'gate', enabled: true, thresholdDb: gateDb })
    }
    node.port.onmessage = (e) => {
      if (this.released) return
      const data = e.data
      if (data instanceof ArrayBuffer) this.onChunk(data)
      else if (data !== null && typeof data === 'object' && data.kind === 'level') this.onLevel(data.rms)
    }
    source.connect(node)
    this.source = source
    this.node = node
  }

  /** Stop capture and release the mic / AudioContext. */
  stop(): void {
    if (this.released) return
    this.released = true
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
    this.opts.vad?.close()
    this.node?.port.close()
    this.source?.disconnect()
    this.stream?.getTracks().forEach(track => track.stop())
    void this.ctx?.close().catch(() => {})
    this.node = null
    this.source = null
    this.stream = null
    this.ctx = null
    this.chunks = []
    this.chunkBytes = 0
    this.preroll = []
    this.prerollBytes = 0
    this.capturing = false
    this.speaking = false
    this.interruptMode = false
    this.interruptArmed = false
    this.confirmArmed = false
  }

  private onLevel(rms: number): void {
    if (this.released || this.paused) return

    // Barge-in mode: stream to the bridge VAD (never accumulate). RMS 判据与
    // VAD 并行使用——原来只有"VAD 不可用"时才退回 RMS，一旦 VAD 连上了却
    // 判不出人声（模型或阈值问题），就会表现为"完全打不断"。两道判据同时
    // 生效，任一方认定有人在说话就打断。
    if (this.interruptMode) {
      const threshold = this.opts.interruptThreshold ?? DEFAULT_INTERRUPT_THRESHOLD
      const now = performance.now()
      if (rms >= threshold) {
        if (!this.interruptArmed) {
          this.interruptArmed = true
          this.interruptHoldStart = now
        } else if (!this.confirmArmed && now - this.interruptHoldStart >= (this.opts.interruptHoldMs ?? DEFAULT_INTERRUPT_HOLD_MS)) {
          // 确认窗：先不打断。原来在"够响 250 毫秒"这一刻就立刻掐断，于是 TTS
          // 回声、椅子响、鼠标点这类短促噪声也能把念到一半的句子切掉，而随后
          // 的确认窗又过不去——听感就是"播一半被截断，而且没有下文"。真人声会
          // 撑过整个窗口，那时才动手。
          this.confirmArmed = true
          this.confirmStart = now
        } else if (this.confirmArmed && now - this.confirmStart >= (this.opts.interruptConfirmMs ?? DEFAULT_INTERRUPT_CONFIRM_MS)) {
          this.confirmArmed = false
          this.interruptArmed = false
          this.interruptMode = false
          this.capturing = false
          // The pre-roll still holds the words of this very utterance: move it
          // into the accumulation before the next chunk lands.
          this.confirmed = true
          if (!this.capturing) {
            this.capturing = true
            this.chunks.push(...this.preroll)
            this.chunkBytes += this.prerollBytes
            this.preroll = []
            this.prerollBytes = 0
          }
          this.opts.onSpeechInterrupt?.()
          // 不再清空缓冲：刚确认的就是这个人在说话，接下来按正常模式继续累积。
          if (!this.speaking) {
            this.speaking = true
            this.lastVoiceAt = now
            this.armMaxTimer()
            this.opts.onSpeakingChange?.(true)
          }
        }
      } else {
        this.interruptArmed = false
        this.confirmArmed = false
      }
      return
    }

    const threshold = this.opts.rmsThreshold ?? DEFAULT_RMS_THRESHOLD
    if (rms >= threshold) {
      this.lastVoiceAt = performance.now()
      if (!this.speaking) {
        this.speaking = true
        this.armMaxTimer()
        this.opts.onSpeakingChange?.(true)
      }
    }
  }

  /** Keep the last ~600 ms of audio so an interruption can still be recorded. */
  private pushPreroll(buffer: ArrayBuffer): void {
    this.preroll.push(buffer)
    this.prerollBytes += buffer.byteLength
    // 16 kHz PCM16 ≈ 32 kB/s → 600 ms ≈ 19 kB
    while (this.prerollBytes > 19_000 && this.preroll.length > 1) {
      const dropped = this.preroll.shift()
      if (dropped !== undefined) this.prerollBytes -= dropped.byteLength
    }
  }
  private onChunk(buffer: ArrayBuffer): void {
    if (this.released || this.paused) return
    if (this.interruptMode) {
      // Barge-in mode: the audio goes to the VAD, and a short pre-roll is kept
      // so that once the interruption is confirmed the words can still be
      // recorded — dropping them meant "I said something and nothing happened".
      this.opts.vad?.send(buffer)
      this.pushPreroll(buffer)
      // Only a CONFIRMED voice starts accumulating: during the confirmation
      // window the audio is VAD input and pre-roll, nothing else.
      if (this.confirmed && !this.capturing) {
        this.capturing = true
        this.chunks.push(...this.preroll)
        this.chunkBytes += this.prerollBytes
        this.preroll = []
        this.prerollBytes = 0
        this.speaking = true
        this.lastVoiceAt = performance.now()
        this.armMaxTimer()
        this.opts.onSpeakingChange?.(true)
      }
      if (this.capturing) {
        this.chunks.push(buffer)
        this.chunkBytes += buffer.byteLength
      }
      return
    }
    this.chunks.push(buffer)
    this.chunkBytes += buffer.byteLength
    if (!this.speaking) return
    const silenceMs = performance.now() - this.lastVoiceAt
    if (silenceMs >= (this.opts.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS)) this.flush()
  }

  private armMaxTimer(): void {
    if (this.maxTimer !== null) clearTimeout(this.maxTimer)
    this.maxTimer = setTimeout(
      () => this.flush(),
      this.opts.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS,
    )
  }

  private flush(): void {
    if (this.released) return
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer)
      this.maxTimer = null
    }
    const pcm = this.chunkBytes > 0 ? this.concatChunks() : null
    const durationMs = (this.chunkBytes / 2 / 16000) * 1000
    this.chunks = []
    this.chunkBytes = 0
    this.preroll = []
    this.prerollBytes = 0
    this.capturing = false
    if (this.speaking) {
      this.speaking = false
      this.opts.onSpeakingChange?.(false)
    }
    const minMs = this.opts.minUtteranceMs ?? 0
    if (pcm !== null && durationMs >= minMs) this.opts.onUtterance(pcm)
  }

  private concatChunks(): ArrayBuffer {
    const out = new Uint8Array(this.chunkBytes)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }
    return out.buffer
  }
}
