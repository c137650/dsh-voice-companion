/**
 * CameraCapture: the computer's webcam, sampled as JPEG frames.
 *
 * The frames come from the LOCAL BRIDGE, not from the browser. The DSH desktop
 * app answers `getUserMedia` permission requests itself and never shows a
 * prompt, so a browser-side capture just fails silently; the bridge opens the
 * very same camera with OpenCV and hands the picture over as a normal HTTP
 * response, which needs no permission from anybody.
 *
 * Why frames and not a video file: the model route this plugin talks to
 * accepts image content blocks (OpenAI-compatible `image_url` with a
 * `data:` URL). Frames cost a fraction of a video upload and are available
 * within one sampling tick, which is what a "call" needs.
 *
 * The bridge keeps the device open between frames (opening it costs ~200 ms),
 * and releases it again when the camera switch is turned off — otherwise the
 * camera light would stay on.
 */

/** One captured picture, ready to be sent as an image content block. */
export interface CameraFrame {
  /** Base64 JPEG payload, WITHOUT the `data:` prefix. */
  data: string
  /** Always `image/jpeg` for now (the model's accepted raster types). */
  mediaType: 'image/jpeg'
  /** Pixel size of the encoded frame. */
  width: number
  /** Pixel size of the encoded frame. */
  height: number
  /** `performance.now()` at grab time. */
  at: number
  /**
   * 32x24 grayscale fingerprint of the frame (768 bytes), computed by the
   * bridge. The vision path compares fingerprints to decide whether the
   * picture changed — no JPEG decoding needed on this side.
   */
  fingerprint: Uint8Array | null
  /**
   * 64x36 HSV grid of the frame (6912 bytes), computed by the bridge on the
   * SAME picture this JPEG was encoded from. It is the raw material for the
   * change score (see `seenow/score.ts`): scoring only compares two grids, so
   * nothing has to decode the JPEG.
   */
  grid: Uint8Array | null
  /** The camera's own frame rate (fps); 0 when the device does not report it. */
  deviceFps: number
}

export interface CameraOptions {
  /** How long to wait for the bridge to answer one frame (ms). */
  timeoutMs?: number
}

/** Default options. */
export const DEFAULT_CAMERA_OPTIONS: Required<CameraOptions> = {
  timeoutMs: 8000,
}

/** One frame as returned by the bridge. */
interface BridgeFrame {
  data: string
  mediaType: string
  width: number
  height: number
  /** Base64 fingerprint of the frame (optional). */
  fingerprint?: string
  /** Base64 64x36 HSV grid of the frame (optional). */
  grid?: string
  /** The device's own frame rate (optional). */
  deviceFps?: number
}

/**
 * Decode a base64 fingerprint into bytes.
 * @param raw - the base64 payload from the bridge (may be missing).
 * @returns the bytes, or null when there is no usable fingerprint.
 */
function decodeFingerprint(raw: string | undefined): Uint8Array | null {
  if (raw === undefined || raw === '') return null
  try {
    const binary = atob(raw)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * Decode a base64 HSV grid into bytes.
 * @param raw - the base64 payload from the bridge (may be missing).
 * @returns the bytes, or null when there is no usable grid.
 */
function decodeGrid(raw: string | undefined): Uint8Array | null {
  if (raw === undefined || raw === '') return null
  try {
    const binary = atob(raw)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

export class CameraCapture {
  private readonly opts: Required<CameraOptions>
  private started = false
  /** Human-readable reason of the last failure, or null. */
  private error: string | null = null
  /** The bridge base URL, remembered so stop() can release the device. */
  private releaseUrl: string | null = null

  constructor(opts: CameraOptions = {}) {
    this.opts = { ...DEFAULT_CAMERA_OPTIONS, ...opts }
  }

  /** Whether the camera is currently held open. */
  get active(): boolean {
    return this.started
  }

  /** The reason of the last failure, or null when there was none. */
  get lastError(): string | null {
    return this.error
  }

  /**
   * Open the camera by asking the bridge for one frame.
   * @throws when the bridge cannot deliver a frame.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.error = null
    const frame = await this.fetchFrame()
    if (frame === null) {
      throw new Error(this.error ?? '摄像头打不开')
    }
    this.started = true
  }

  /** Release the camera; the bridge gives the device back to the system. */
  stop(): void {
    this.started = false
    const url = this.releaseUrl
    this.releaseUrl = null
    if (url === null) return
    void fetch(`${url}/api/camera/release`, { method: 'POST' }).catch(() => {
      // the bridge may be down — nothing to release then
    })
  }

  /**
   * Grab the current picture as a JPEG.
   * @param wantGrid - also ask the bridge for the 64x36 HSV grid of this very
   *                   frame (the change-score raw material).
   * @returns the frame, or null when the camera has no picture yet.
   */
  async grab(wantGrid = false): Promise<CameraFrame | null> {
    if (!this.started) return null
    const frame = await this.fetchFrame(wantGrid)
    if (frame === null) return null
    return {
      data: frame.data,
      mediaType: 'image/jpeg',
      width: frame.width,
      height: frame.height,
      at: performance.now(),
      fingerprint: decodeFingerprint(frame.fingerprint),
      grid: decodeGrid(frame.grid),
      deviceFps: typeof frame.deviceFps === 'number' ? frame.deviceFps : 0,
    }
  }

  /**
   * One frame from the bridge.
   * @param wantGrid - whether to ask for the HSV grid as well.
   * @returns the frame, or null when it could not be fetched (the reason is
   *          left in `this.error`).
   */
  private async fetchFrame(wantGrid = false): Promise<BridgeFrame | null> {
    // Imported lazily: the bridge module owns the base URL, and a plugin
    // without a bridge must not crash on import.
    const { cameraFrame, bridgeBase } = await import('../bridge.ts')
    this.releaseUrl = bridgeBase()
    try {
      const frame = await cameraFrame(this.opts.timeoutMs, wantGrid)
      if (frame.data === '') {
        this.error = '桥接返回了空画面'
        return null
      }
      this.error = null
      return frame
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      console.error('[ui-voice] camera frame failed:', err)
      return null
    }
  }
}
