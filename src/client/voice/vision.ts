/**
 * VisionController: keeps the camera open and feeds the picture to the model.
 *
 * Two different speeds, on purpose:
 *
 *   1. The SAMPLING loop runs as fast as the camera delivers frames (30 fps
 *      on this machine), so the preview window shows the room live.
 *   2. What the MODEL gets is not every sampled frame. A frame is only kept
 *      when the picture actually changed: the change is measured by the
 *      64x36 HSV grid the bridge hands along with every frame (see
 *      `seenow/score.ts`). Below the threshold nothing is stored - a still
 *      room costs the model nothing at all.
 *
 * The kept frames wait for the next spoken sentence and ride along with it.
 * There is no separate image turn: DSH has exactly one way to hand content to
 * a model (session.prompt), and everything sent that way lands in the visible
 * transcript, so the frames travel with the user's own words instead.
 *
 * ## 拼图（默认）
 *
 * The frames ride along as **one sheet**: the kept frames are composed into a
 * single image (a grid of cells, each cell one frame, cell numbers burned in)
 * plus one full-size frame of the very latest picture. That is one image
 * instead of up to eighty, so the request body drops from ~2 MB to ~100 KB and
 * the visual tokens from ~16k to a few hundred.
 *
 * The old burst path (every kept frame as its own image) is still there
 * behind a switch (`s2s.voice.sheet` = '0' in localStorage) for comparison.
 */
import { CameraCapture, type CameraFrame } from './camera.ts'
import { SheetPipeline, composeSheet, SHEET_DEFAULTS } from './sheet.ts'
import { noteVisionImage } from './vision-ids.ts'

/** One prompt content part the vision path can submit. */
export type VisionPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: 'image/jpeg'; readonly data: string }

/** Camera lifecycle as the UI shows it. */
export type VisionState = 'off' | 'starting' | 'on' | 'error'

/** Sampling period (ms) used until the camera reports its own rate. */
const DEFAULT_SAMPLE_MS = 33

/** Fastest sampling period (ms): quicker than this only duplicates frames. */
const MIN_SAMPLE_MS = 15

/**
 * How much the picture has to change for a frame to be worth keeping: the
 * mean absolute difference of the two 32x24 grayscale fingerprints (0..255 per
 * pixel).
 *
 * Measured on this machine: two neighbouring frames of a still room differ by
 * 0.5 on average, a person moving differs by 10 or more. 1.0 therefore sits
 * just above the noise floor and well below anything worth looking at.
 */
export const CHANGE_THRESHOLD = 1.0

/** Hard cap on the frames one turn may carry (DSH accepts 80 per message). */
export const MAX_BURST_FRAMES = 80

/**
 * How often the change score is measured (ms).
 *
 * The preview keeps the camera's own rate (30 fps here), but the *scoring*
 * runs at 12 fps — the same rate dsh-see-now uses. Two reasons: the grid has
 * to travel with the frame (it is the raw material for the score), and at
 * 12 fps a frame's delta already means "something happened in 80 ms" instead
 * of "something happened in 33 ms".
 */
export const SCORE_INTERVAL_MS = 83

/**
 * Whether the model gets one composed sheet (true) or the old burst of frames
 * (false). Switchable in localStorage (`s2s.voice.sheet` = '0') so the two
 * paths can be compared on the same machine without a rebuild.
 */
export function sheetMode(): boolean {
  try {
    return localStorage.getItem('s2s.voice.sheet') !== '0'
  } catch {
    return true
  }
}

/**
 * 调试口径（localStorage `s2s.voice.sheet.debug` = '1'）。
 *
 * 陪伴场景看的是"整幅画面有没有变"，而调车、盯仪表这类场景看的是
 * "画面里那一小块有没有动" —— 后者会被全幅平均稀释掉，所以切到
 * 「变了多少格」的计数口径，并且提高打分帧率、缩短积分窗口、补上事件前的帧。
 */
export function debugMode(): boolean {
  try {
    return localStorage.getItem('s2s.voice.sheet.debug') === '1'
  } catch {
    return false
  }
}

/** 调试口径下一套参数（阈值随口径一起换，不能照抄平均口径的数）。 */
const DEBUG_PROFILE = {
  metric: 'cells' as const,
  cellThreshold: 24,
  cutAbs: 2.5,
  refScore: 1.2,
  integralSeconds: 1,
  markMinGap: 0.2,
  cutMinGap: 0.15,
  dupMin: 0.8,
  preRoll: 3,
}

/** 陪伴口径（改回来时用）。 */
const COMPANION_PROFILE = {
  metric: 'mean' as const,
  cutAbs: SHEET_DEFAULTS.cutAbs,
  refScore: SHEET_DEFAULTS.refScore,
  integralSeconds: SHEET_DEFAULTS.integralSeconds,
  markMinGap: SHEET_DEFAULTS.markMinGap,
  cutMinGap: SHEET_DEFAULTS.cutMinGap,
  dupMin: SHEET_DEFAULTS.dupMin,
  preRoll: 0,
}

/**
 * 打分间隔（ms）。调试时提到约 30 fps —— 遥控器回中那种几百毫秒的瞬变，
 * 12 fps 的节奏容易整段跳过。
 */
export function scoreIntervalMs(): number {
  return debugMode() ? 34 : SCORE_INTERVAL_MS
}

export interface VisionOptions {
  /** Frame sampling period in ms (default: the camera's own rate). */
  sampleMs?: number
  /** How long to wait for one bridge frame (default 8000). */
  timeoutMs?: number
}

/**
 * Mean absolute difference of two fingerprints.
 * @param a - the baseline fingerprint.
 * @param b - the fingerprint of the new frame.
 * @returns the average per-pixel difference (0 when the shapes differ).
 */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / n
}

export class VisionController {
  private readonly opts: Required<VisionOptions>
  private readonly camera: CameraCapture
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The frames kept because the picture changed (the burst source). */
  private readonly buffer: CameraFrame[] = []
  /** The fingerprint of the last kept frame: the comparison baseline. */
  private baseline: Uint8Array | null = null
  /** Whether frames may be kept at all (the microphone is listening). */
  private capturing = false
  /** The current sampling period (ms), adapted to the camera's rate. */
  private period: number
  /** The frame the model was last handed, plus when it happened. */
  private delivered: { frame: CameraFrame; at: number } | null = null
  private state: VisionState = 'off'
  /** Bumped on every open/close so a late camera grant cannot revive it. */
  private generation = 0
  private readonly listeners = new Set<(state: VisionState) => void>()
  private readonly deliveryListeners = new Set<(frame: CameraFrame | null) => void>()
  private readonly liveListeners = new Set<(frame: CameraFrame | null) => void>()
  /** One fetch at a time: a slow frame must not stack up behind the next. */
  private sampling = false
  /** The sheet pipeline: which frames are worth keeping, and how many. */
  private readonly sheet = new SheetPipeline()
  /** The newest frame the camera produced (what the model would see right now). */
  private latest: CameraFrame | null = null
  /** When the last change score was taken (ms). */
  private lastScoreAt = 0
  /** 上一次应用的口径（陪伴 / 调试），切换时才重新下发参数。 */
  private debugApplied: boolean | null = null

  constructor(options: VisionOptions = {}) {
    this.opts = {
      sampleMs: options.sampleMs ?? DEFAULT_SAMPLE_MS,
      timeoutMs: options.timeoutMs ?? 8000,
    }
    this.period = this.opts.sampleMs
    this.camera = new CameraCapture({
      timeoutMs: this.opts.timeoutMs,
    })
  }

  /** The reason of the last camera failure, or null. */
  get error(): string | null {
    return this.camera.lastError
  }

  /** Current camera lifecycle state. */
  get status(): VisionState {
    return this.state
  }

  /** Whether the camera is supposed to be open. */
  get enabled(): boolean {
    return this.state === 'on' || this.state === 'starting'
  }

  /** How many frames are waiting for the next sentence. */
  get buffered(): number {
    return this.buffer.length
  }

  /** Subscribe to camera state changes; returns the unsubscribe function. */
  subscribe(listener: (state: VisionState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The frame the model was last given (what the model is looking at right
   * now), plus the time it was handed over. Shown by the preview window: it
   * deliberately lags behind the live camera, because it IS the model's view.
   */
  get lastDelivered(): { frame: CameraFrame; at: number } | null {
    return this.delivered
  }

  /** Subscribe to "the model got a new frame" events. */
  subscribeDelivery(listener: (frame: CameraFrame | null) => void): () => void {
    this.deliveryListeners.add(listener)
    return () => {
      this.deliveryListeners.delete(listener)
    }
  }

  /**
   * Subscribe to the live sampling loop: it fires on every sampled frame (as
   * fast as the camera delivers), so the preview window can show the room as
   * it is right now. The listener also receives null when the camera closes.
   */
  subscribeLive(listener: (frame: CameraFrame | null) => void): () => void {
    this.liveListeners.add(listener)
    return () => {
      this.liveListeners.delete(listener)
    }
  }

  /**
   * Open or close the camera. Closing releases the device and stops the
   * sampling loop; opening starts sampling as fast as the camera delivers.
   * @param on - desired state.
   */
  async setEnabled(on: boolean): Promise<void> {
    if (on) {
      if (this.state === 'on' || this.state === 'starting') return
      this.setState('starting')
      const generation = ++this.generation
      try {
        await this.camera.start()
      } catch (err) {
        console.error('[ui-voice] camera start failed:', err)
        if (this.generation === generation) this.setState('error')
        return
      }
      if (this.generation !== generation) {
        // Switched off while the device was still opening.
        this.camera.stop()
        return
      }
      this.setState('on')
      void this.sample()
      return
    }
    if (this.state === 'off') return
    this.generation += 1
    this.setState('off')
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.camera.stop()
    this.buffer.length = 0
    this.baseline = null
    this.sheet.reset()
    this.latest = null
    this.markDelivered(null)
    for (const listener of this.liveListeners) listener(null)
  }

  /**
   * Open or close the frame capture (the microphone switch drives this).
   *
   * Frames are only worth keeping while somebody might speak: from the moment
   * the microphone goes on, the picture is watched for changes and the changed
   * frames pile up for the next sentence. When the microphone goes off again
   * the pile is dropped  - ?a picture from an earlier moment would only confuse
   * the model.
   *
   * @param on - whether frames may be kept.
   */
  setCapturing(on: boolean): void {
    if (this.capturing === on) return
    this.capturing = on
    this.buffer.length = 0
    this.baseline = null
    this.sheet.reset()
  }

  /** Close the camera and release every resource. */
  dispose(): void {
    void this.setEnabled(false)
  }

  /**
   * Prepend the picture kept since the previous turn to a prompt.
   *
   * This is what makes a spoken sentence carry the motion that led up to it:
   * the camera samples as fast as it can, but only the frames where the
   * picture really changed are stored.
   *
   * Two shapes, chosen by `s2s.voice.sheet`:
   *   - **sheet** (default): the kept frames are composed into ONE image
   *     (a grid of cells, cell numbers burned in) plus one full-size frame of
   *     the latest picture. One image instead of up to eighty.
   *   - **burst** (the old path): every kept frame as its own image.
   *
   * @param parts - the prompt content the caller wants to send.
   * @returns the content with the picture in front, or the original parts
   *          when the camera has nothing worth sending.
   */
  async attachFrame(parts: VisionPart[]): Promise<VisionPart[]> {
    if (!sheetMode()) return this.attachBurst(parts)
    return await this.attachSheet(parts)
  }

  /**
   * 记住刚发出去的这张图（按字节 sha256），界面才能把它和用户自己上传的
   * 图片区分开 —— 对话里默认只留一个「点击查看」的小按钮。
   * @param data - 图片的 base64。
   */
  private async markSent(data: string): Promise<void> {
    await noteVisionImage(data)
  }

  /**
   * The sheet path: one composed image (or the plain frame when there is only
   * one worth sending).
   *
   * 只有一帧时直接送那张原图 —— 拼成 1024 宽反而是一次放大 + 重压缩，更模糊。
   * 两帧以上才拼，并且**不再另附全幅**：最新那一帧本来就是拼图的最后一格，
   * 再送一遍只是多一份 token。
   */
  private async attachSheet(parts: VisionPart[]): Promise<VisionPart[]> {
    if (this.state !== 'on') return parts
    const frames = this.sheet.take()
    if (frames.length === 0) {
      // Nothing was worth keeping (the picture never changed). The model still
      // gets to see the room as it is right now — one frame, no sheet.
      const latest = this.latest
      if (latest === null) return parts
      this.markDelivered(latest)
      await this.markSent(latest.data)
      return [{ type: 'image' as const, mediaType: latest.mediaType, data: latest.data }, ...parts]
    }
    const newest = frames[frames.length - 1]!
    if (frames.length === 1) {
      this.markDelivered(newest)
      await this.markSent(newest.data)
      return [
        { type: 'image' as const, mediaType: 'image/jpeg' as const, data: newest.data },
        ...parts,
      ]
    }
    let sheet: { data: string; width: number; height: number; cols: number; rows: number }
    try {
      sheet = await composeSheet(frames, {
        sourceWidth: newest.width,
        sourceHeight: newest.height,
      })
    } catch (err) {
      console.error('[ui-voice] 拼图失败，退回单帧：', err)
      this.markDelivered(newest)
      await this.markSent(newest.data)
      return [{ type: 'image' as const, mediaType: 'image/jpeg' as const, data: newest.data }, ...parts]
    }
    this.markDelivered(newest)
    await this.markSent(sheet.data)
    // 只送拼图本身，不附任何说明文字 —— 那段「几格、按时间顺序、跨度几秒」的
    // 提示词是塞进对话里的额外注入，界面上也会跟着冒出来，舰长不需要它。
    // 格数和时间顺序已经烧在画面的角标上，模型看得见。
    return [
      { type: 'image' as const, mediaType: 'image/jpeg' as const, data: sheet.data },
      ...parts,
    ]
  }

  /**
   * The old path: every kept frame as its own image (up to MAX_BURST_FRAMES).
   */
  private async attachBurst(parts: VisionPart[]): Promise<VisionPart[]> {
    const frames = this.takeBurst()
    if (frames.length === 0) return parts
    this.markDelivered(frames[frames.length - 1]!)
    for (const frame of frames) await this.markSent(frame.data)
    return [
      ...frames.map((frame) => ({ type: 'image' as const, mediaType: frame.mediaType, data: frame.data })),
      ...parts,
    ]
  }

  /**
   * The frames kept since the last turn.
   * @returns every kept frame not yet sent, in chronological order.
   */
  private takeBurst(): CameraFrame[] {
    if (this.state !== 'on') {
      this.buffer.length = 0
      return []
    }
    const frames = this.buffer.slice()
    this.buffer.length = 0
    return frames
  }

  /** Grab one frame and decide whether it is worth keeping. */
  private async sample(): Promise<void> {
    if (this.state !== 'on') return
    // One fetch at a time: a frame that takes longer than a tick must be
    // dropped rather than queued behind the next one.
    if (this.sampling) return
    this.sampling = true
    const started = performance.now()
    try {
      // 口径可以在运行时切（localStorage 一改就生效）：陪伴 / 调试两套参数。
      const debug = debugMode()
      if (debug !== this.debugApplied) {
        this.debugApplied = debug
        this.sheet.configure(debug ? DEBUG_PROFILE : COMPANION_PROFILE)
        this.lastScoreAt = 0
      }
      // 预览按摄像头自己的帧率跑，**打分**只在到点的那一次取帧时顺带要网格 ——
      // 网格是同一帧算出来的，所以网格和 JPEG 描述的是同一个瞬间。
      const wantGrid = this.capturing && started - this.lastScoreAt >= scoreIntervalMs()
      const frame = await this.camera.grab(wantGrid)
      if (frame === null) return
      if (this.state !== 'on') return
      this.adaptPeriod(frame.deviceFps)
      this.latest = frame
      for (const listener of this.liveListeners) listener(frame)
      if (!this.capturing) return
      if (wantGrid && frame.grid !== null && frame.grid.length > 0) {
        this.lastScoreAt = started
        this.sheet.push({
          data: frame.data,
          width: frame.width,
          height: frame.height,
          grid: frame.grid,
          atMs: started,
        })
        return
      }
      // 旧的多帧路径只在开关打开时才攒（拼图路径不碰这个 buffer）。
      if (!sheetMode()) this.consider(frame)
    } finally {
      this.sampling = false
      // Keep the beat: the fetch itself costs a few milliseconds, so the wait
      // is what is left of the period, not the whole period.
      this.schedule(Math.max(0, this.period - (performance.now() - started)))
    }
  }

  /** Keep the frame only when the picture differs from the last kept one. */
  private consider(frame: CameraFrame): void {
    const fingerprint = frame.fingerprint
    if (fingerprint === null || fingerprint.length === 0) {
      // No fingerprint to compare (older bridge): keep every frame.
      this.keep(frame)
      return
    }
    if (this.baseline === null || this.baseline.length !== fingerprint.length) {
      this.keep(frame)
      return
    }
    if (meanAbsDiff(this.baseline, fingerprint) > CHANGE_THRESHOLD) this.keep(frame)
  }

  /**
   * Store one frame as the new baseline.
   *
   * The frame that arrives is always judged by the plain CHANGE_THRESHOLD, so
   * the newest motion stays dense. If the pile never reaches MAX_BURST_FRAMES
   * it simply stays smaller — nothing is padded or stretched. Only a FULL pile
   * gets compressed, and it is always the older end that gives room.
   */
  private keep(frame: CameraFrame): void {
    this.buffer.push(frame)
    this.baseline = frame.fingerprint
    if (this.buffer.length > MAX_BURST_FRAMES) this.compressFull()
  }

  /**
   * The pile is full: make room for the newcomer by dropping the one frame
   * that tells the least - the frame whose neighbours look almost the same as
   * it does, so keeping it would barely change what the model learns.
   *
   * A raised threshold was the first idea, but it quantises badly: going from
   * "one frame per frame" to "one frame per two frames" halves the pile to 40,
   * and the burst could never hold 80. Dropping exactly one frame per arrival
   * keeps the count at MAX and still leaves the oldest part sparse and the
   * newest part dense, because the oldest part is where neighbours are the
   * most alike.
   */
  private compressFull(): void {
    while (this.buffer.length > MAX_BURST_FRAMES) {
      let victim = -1
      let cheapest = Number.POSITIVE_INFINITY
      for (let i = 1; i < this.buffer.length - 1; i++) {
        const before = this.buffer[i - 1]!.fingerprint
        const current = this.buffer[i]!.fingerprint
        const after = this.buffer[i + 1]!.fingerprint
        if (before === null || current === null || after === null) continue
        // How much the middle frame adds over its neighbours: near zero means
        // the two neighbours already say the same thing.
        const cost = meanAbsDiff(before, current) + meanAbsDiff(current, after) - meanAbsDiff(before, after)
        if (cost < cheapest) {
          cheapest = cost
          victim = i
        }
      }
      if (victim === -1) {
        // No fingerprints to compare (older bridge): just drop the oldest.
        this.buffer.shift()
        continue
      }
      this.buffer.splice(victim, 1)
    }
    // The newest kept frame is still the comparison baseline.
    const last = this.buffer[this.buffer.length - 1]
    this.baseline = last?.fingerprint ?? null
  }

  /** Follow the camera's own frame rate (30 fps here). */
  private adaptPeriod(deviceFps: number): void {
    if (deviceFps <= 0 || deviceFps > 240) return
    const period = Math.max(MIN_SAMPLE_MS, Math.round(1000 / deviceFps))
    if (period === this.period) return
    this.period = period
  }

  /**
   * Schedule the next sampling tick (after the current one finished).
   * @param delay - how long to wait before the next grab (ms).
   */
  private schedule(delay: number = this.period): void {
    if (this.state !== 'on') return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.sample()
    }, delay)
  }

  /** Record one frame as delivered to the model and notify the preview. */
  private markDelivered(frame: CameraFrame | null): void {
    this.delivered = frame === null ? null : { frame, at: performance.now() }
    for (const listener of this.deliveryListeners) listener(frame)
  }

  private setState(next: VisionState): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.listeners) listener(next)
  }
}
