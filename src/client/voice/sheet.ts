/**
 * sheet.ts — 拼帧：只留下"值得看的"那几帧，再把它们拼成**一张**图。
 *
 * 思路来自 **dsh-see-now**（SAOS-3624，Apache-2.0）：先给每帧打一个变化分，
 * 只有"画面突然换了一个样"或"一直在动、攒够了量"才留帧；留下来的几帧拼进同一张图，
 * 一张图的固定成本摊到 4~8 帧上。留帧判据（切点 + 积分）逐条移植自它的 pipeline.js。
 *
 * 与 see-now 的两处差别，都是摄像头这条链路逼出来的：
 *
 * 1. **打分原料由桥接算**。摄像头那一侧（OpenCV）已经把当前帧转成 64×36 的 HSV 网格
 *    再送过来，浏览器只比对两张网格 —— 不用解码 JPEG，也不用碰像素。
 * 2. **排布用等分网格，不用它的 DP 装箱**。摄像头的每一帧重要程度是一样的，
 *    而格子必须保持源画面的宽高比 —— 否则人脸会被裁掉（DP 假设的是方形容器 + 16:9 屏幕）。
 *
 * 这套逻辑替掉的正是"一轮最多送 80 张图"：同样的信息量压进 1 张，
 * 请求体从两兆降到一百来 KB，视觉 token 从一万六降到几百。
 */
import { scorePair, changedCells } from './seenow/score.ts'

/** 一帧：JPEG（base64，不带 `data:` 前缀）+ 它的 HSV 网格 + 采样时刻。 */
export interface SheetFrame {
  /** base64 JPEG（不带 `data:` 前缀）。 */
  data: string
  /** 这一帧的像素宽（拼格子时按它保持宽高比）。 */
  width: number
  /** 这一帧的像素高。 */
  height: number
  /** 64×36 的 HSV 网格（GRID_BYTES 字节）。 */
  grid: Uint8Array
  /** 采样时刻（毫秒，同一 monotonic 时钟）。 */
  atMs: number
  /** 留帧理由。 */
  via: 'start' | 'cut' | 'mark' | 'floor' | 'pre'
  /** 与上一张留下的帧的差异分（null = 没有上一张）。 */
  dup: number | null
}

/** 留帧判据的参数。默认值按本机摄像头标定过（见 README 的"画面标定"一节）。 */
export interface SheetOptions {
  /** 打分帧率（Hz）。积分阈值按它换算，所以它必须跟实际的打分帧率一致。 */
  fps?: number
  /** 切点的绝对门槛：变化分要够大。 */
  cutAbs?: number
  /** 切点的尖峰比：这一帧要比前后邻帧大这么多倍，才算"一下子"。 */
  cutSpike?: number
  /** 两个切点之间至少隔多久（秒）。 */
  cutMinGap?: number
  /** 积分取帧：一段"中等强度"的画面要攒这么多秒，才算一个采样点。 */
  integralSeconds?: number
  /** 参考强度：中等强度画面每帧的变化分。 */
  refScore?: number
  /** 两个留帧点之间至少隔多久（秒）。 */
  markMinGap?: number
  /** 画面完全静止时的兜底：这么久都没出帧，也给一张。 */
  silentFloorSec?: number
  /** 和上一张留下的帧差小于这个分就不留（去重）。 */
  dupMin?: number
  /**
   * 一张拼图最多几格。
   *
   * 取 9 而不是 8：格子数是按平方数跳档的（1 / 4 / 9 / 16），
   * 而**画布大小不随格数变**，所以同一档里多塞一帧既不涨 token 也不缩格子。
   * 8 帧已经排成 3×3 了，那第 9 格空着就是白扔 —— 9 才是 3×3 这一档的满格。
   * 要往上加就加到 16（4×4），每格会从 341×256 缩到 256×192。
   */
  maxFrames?: number
  /**
   * 变化分用哪个统计量。
   *
   *   `mean`  全幅平均 —— 陪伴场景的默认值：整幅画面在变，就是"有事发生"。
   *   `cells` 变了多少格 —— 画面里只有一小块在动时的口径（调车、盯仪表、看手部动作）。
   */
  metric?: 'mean' | 'cells'
  /** `cells` 口径下单格算"变了"的门槛（0–765 量纲）。 */
  cellThreshold?: number
  /**
   * 事件前回看：检测到切点时，把**之前**攒在环形缓冲里的这么几帧一起留下。
   *
   * 默认 0（陪伴场景不需要）。调试时要它 —— 不然只能看到"滑完之后"，
   * 看不到"滑之前是什么样"。环形缓冲只在它 > 0 时才占内存。
   */
  preRoll?: number
}

/**
 * 默认值。
 *
 * 阈值是**按这台机器的摄像头标定**的，不是照抄 see-now：
 * 屏幕那边"静止"是 0.00 分，摄像头这边静止也有 1.9 分（传感器噪声 + 自动曝光），
 * 实测平移 15px = 22.7 分、亮度 ±15% = 22~30 分、一个人入画（占宽 12%）= 7.9 分。
 * 于是：
 *   - cutAbs = 12：相当于"确实有件事发生了"，噪声碰不到；
 *   - refScore = 5：安静的房间每帧不到 2 分，3 秒也攒不够 180 分 → 一帧都不出；
 *     人动起来每帧 6 分上下 → 大约 2.5 秒出一帧；
 *   - dupMin = 3.5：刚好压在噪声地板（p75 = 3.3）之上。
 */
export const SHEET_DEFAULTS: Required<SheetOptions> = {
  fps: 12,
  cutAbs: 12,
  cutSpike: 2.5,
  cutMinGap: 0.4,
  integralSeconds: 3,
  refScore: 5,
  markMinGap: 0.5,
  silentFloorSec: 20,
  dupMin: 3.5,
  maxFrames: 9,
  metric: 'mean',
  cellThreshold: 24,
  preRoll: 0,
}

/** 拼图的默认画布宽度（像素）。格子按这个宽度等分。 */
export const SHEET_WIDTH = 1024

/** 拼图 JPEG 的质量。 */
export const SHEET_QUALITY = 0.82

/** 管线内部的一帧：还没判过的。 */
interface Entry {
  frame: Omit<SheetFrame, 'via' | 'dup'>
  /** 相对上一帧的变化分（null = 这是第一帧，没有可比的前帧）。 */
  score: number | null
  /** 上一帧的变化分（尖峰判据要用）。 */
  prev: number | null
}

/**
 * 留帧管线：喂进变化分，留下"值得看"的帧。
 *
 * 三条留帧理由：
 *   - `cut`  画面突然换了一个样（切点：分数够高 + 是邻帧的尖峰 + 距上刀够远）；
 *   - `mark` 一直在动，积分攒够了（不是等间隔抽样：画面越动越密）；
 *   - `floor` 画面静得什么也没发生，也给一张（不然模型永远看不到"没变"）。
 */
export class SheetPipeline {
  private readonly o: Required<SheetOptions>
  /** 上一帧的网格（打分基准）。 */
  private prevGrid: Uint8Array | null = null
  /** 上一张**留下**的帧的网格（去重基准）。 */
  private lastKeptGrid: Uint8Array | null = null
  /** 待判的帧（最多 2：切点判据要看下一帧的分数）。 */
  private readonly queue: Entry[] = []
  /** 上一帧的变化分。 */
  private lastScore: number | null = null
  /** 积分累加器。 */
  private acc = 0
  /** 上一次切点的时刻（秒）。 */
  private lastCut = Number.NEGATIVE_INFINITY
  /** 上一张留下的帧的时刻（秒）。 */
  private lastBound = Number.NEGATIVE_INFINITY
  /** 本轮的零点（毫秒）。 */
  private origin = 0
  /** 本轮留下的帧。 */
  private kept: SheetFrame[] = []
  /** 最近的若干帧（事件前回看用；preRoll = 0 时不占内存）。 */
  private readonly ring: Omit<SheetFrame, 'via' | 'dup'>[] = []

  constructor(options: SheetOptions = {}) {
    this.o = { ...SHEET_DEFAULTS, ...options }
  }

  /**
   * 换一组参数（不重置状态）。
   *
   * 调车那种"盯着一小块区域"的场景要把口径从 `mean` 换成 `cells`、
   * 打开事件前回看 —— 这些开关在运行时切，不该把已经攒下的帧扔掉。
   */
  configure(options: SheetOptions): void {
    for (const key of Object.keys(options) as (keyof SheetOptions)[]) {
      const value = options[key]
      if (value === undefined) continue
      ;(this.o as Record<string, unknown>)[key as string] = value
    }
    if (this.o.preRoll <= 0) this.ring.length = 0
  }

  /** 按当前口径算两帧的差异。 */
  private diff(prev: Uint8Array, cur: Uint8Array): number {
    return this.o.metric === 'cells'
      ? changedCells(prev, cur, this.o.cellThreshold)
      : scorePair(prev, cur)
  }

  /** 积分阈值：固定的绝对值（4~5 分/帧 × 帧率 × 秒数）。 */
  private integralNeed(): number {
    return this.o.refScore * this.o.fps * this.o.integralSeconds
  }

  /**
   * 喂一帧。
   *
   * @param frame - 这一帧的 JPEG、尺寸与网格。
   */
  push(frame: { data: string; width: number; height: number; grid: Uint8Array; atMs: number }): void {
    if (this.origin === 0) this.origin = frame.atMs
    const score = this.prevGrid === null ? null : this.diff(this.prevGrid, frame.grid)
    this.prevGrid = frame.grid
    const entry: Entry = {
      frame: {
        data: frame.data,
        width: frame.width,
        height: frame.height,
        grid: frame.grid,
        atMs: frame.atMs,
      },
      score,
      prev: this.lastScore,
    }
    this.lastScore = score
    this.queue.push(entry)
    // 切点判据要看"下一帧的分数"，所以第 k 帧要到第 k+1 帧到手才判。
    while (this.queue.length >= 2) {
      const head = this.queue.shift()!
      this.decide(head, this.queue[0]!.score)
    }
    // 环形缓冲：只在要"事件前回看"时才留（每条都是 JPEG，白放着占内存）。
    if (this.o.preRoll > 0) {
      this.ring.push(entry.frame)
      while (this.ring.length > Math.max(this.o.preRoll + 2, 24)) this.ring.shift()
    }
  }

  /** 判一帧要不要留。 */
  private decide(entry: Entry, nextScore: number | null): void {
    const t = (entry.frame.atMs - this.origin) / 1000
    const s = entry.score
    // 第一帧没有可比的前帧，先留一张当锚点。
    if (s === null) {
      this.keep(entry, 'start')
      return
    }
    const px = entry.prev ?? 0
    const nx = nextScore ?? 0
    // 尖峰：是不是"一下子"。相对判据在低分区也会成立，所以还要有绝对地板。
    const spike = nextScore === null || s > this.o.cutSpike * Math.max(1, px, nx)
    if (s >= this.o.cutAbs && spike && t - this.lastCut >= this.o.cutMinGap) {
      this.lastCut = t
      this.acc = 0 // 切点之后重新攒（那一帧的变化属于"跨刀"，不算运动）
      this.keep(entry, 'cut')
      return
    }
    // 积分：分不高但一直有，攒够才录一帧。
    this.acc += s
    if (this.acc >= this.integralNeed() && t - this.lastBound >= this.o.markMinGap) {
      // 只有真的录进去才清零：被去重挡掉时保留累积值，否则这段运动白攒了。
      if (this.keep(entry, 'mark')) this.acc = 0
      return
    }
    // 兜底：画面静得什么也没发生，也给一张。
    if (t - this.lastBound >= this.o.silentFloorSec) this.keep(entry, 'floor')
  }

  /**
   * 留一帧。
   *
   * @returns 是否真的留下来了（被去重挡掉时返回 false）。
   */
  private keep(entry: Entry, via: SheetFrame['via']): boolean {
    const grid = entry.frame.grid
    const dup = this.lastKeptGrid === null ? null : this.diff(this.lastKeptGrid, grid)
    // 去重：和上一张留下的帧太像就不留。切点与兜底不过这道闸 ——
    // 切点本来就是新画面，兜底是"确实没变"，都不能吞。
    if (dup !== null && dup < this.o.dupMin && via !== 'cut' && via !== 'floor') return false
    // 事件前回看：切点时把之前那几帧也补上，否则只看得到"之后"。
    if (via === 'cut' && this.o.preRoll > 0) this.pushPreRoll(entry.frame.atMs)
    this.lastKeptGrid = grid
    this.kept.push({ ...entry.frame, via, dup })
    this.lastBound = (entry.frame.atMs - this.origin) / 1000
    if (this.kept.length > this.o.maxFrames) this.dropRedundant()
    return true
  }

  /**
   * 把事件之前攒着的帧补进这一轮（最多 preRoll 张）。
   *
   * @param beforeMs - 事件的时刻；只补比它早的帧。
   */
  private pushPreRoll(beforeMs: number): void {
    const older = this.ring.filter((f) => f.atMs < beforeMs)
    const picked = older.slice(-this.o.preRoll)
    if (picked.length === 0) return
    for (const frame of picked) {
      if (this.kept.some((k) => k.atMs === frame.atMs)) continue
      this.kept.push({ ...frame, via: 'pre', dup: null })
    }
    // 补进来的是更早的帧，得排回时间顺序里。
    this.kept.sort((a, b) => a.atMs - b.atMs)
  }

  /**
   * 超过上限时，挤掉一张"删了最不心疼"的。
   *
   * 挑法和旧的多帧路径一样：留那张"和左右邻居都不像"的 —— 留它也不会让模型多知道什么。
   * 首尾两张不动：开头那张给"从哪儿开始"，末尾那张给"现在什么样"。
   */
  private dropRedundant(): void {
    while (this.kept.length > this.o.maxFrames) {
      let victim = -1
      let cheapest = Number.POSITIVE_INFINITY
      for (let i = 1; i < this.kept.length - 1; i++) {
        const before = this.kept[i - 1]!.grid
        const current = this.kept[i]!.grid
        const after = this.kept[i + 1]!.grid
        // 中间那张比左右邻居多说了多少：接近 0 说明两张邻居已经说了同一件事。
        const cost = this.diff(before, current) + this.diff(current, after) - this.diff(before, after)
        if (cost < cheapest) {
          cheapest = cost
          victim = i
        }
      }
      if (victim === -1) {
        this.kept.shift()
        continue
      }
      this.kept.splice(victim, 1)
    }
  }

  /**
   * 取走这一轮留下的帧。
   *
   * 管线的内部状态（打分基准、去重基准、积分）**不会**被清掉 ——
   * 下一轮要和这一轮接着比，不然画面一变就会被判成"又变了"。
   */
  take(): SheetFrame[] {
    const frames = this.kept
    this.kept = []
    return frames
  }

  /** 丢掉攒下的帧（麦克风关了：这一段画面不该再送给模型）。 */
  reset(): void {
    this.kept = []
    this.lastKeptGrid = null
    this.prevGrid = null
    this.lastScore = null
    this.acc = 0
    this.lastCut = Number.NEGATIVE_INFINITY
    this.lastBound = Number.NEGATIVE_INFINITY
    this.queue.length = 0
    this.origin = 0
  }

  /** 本轮攒下了几帧。 */
  get pending(): number {
    return this.kept.length
  }

  /** 积分累加到哪儿了（调试用）。 */
  get integral(): number {
    return this.acc
  }
}

/** 拼好的那张图。 */
export interface SheetImage {
  /** base64 JPEG（不带 `data:` 前缀）。 */
  data: string
  /** 画布宽。 */
  width: number
  /** 画布高。 */
  height: number
  /** 列数 / 行数。 */
  cols: number
  rows: number
}

/** 拼图的一张格子表：纯算术，不碰画布（便于离线验证）。 */
export interface SheetLayout {
  /** 列数。 */
  cols: number
  /** 行数。 */
  rows: number
  /** 每格宽（像素）。 */
  cellW: number
  /** 每格高（像素）—— 由源画面的宽高比反推，所以格子不会变形。 */
  cellH: number
  /** 画布宽。 */
  width: number
  /** 画布高（= 行数 × 格高，不是固定值）。 */
  height: number
}

/**
 * 算格子表。
 *
 * 列数取 ⌈√n⌉，行数取 ⌈n/列数⌉；**格高由源画面宽高比反推**，
 * 所以每一格恰好是完整的一帧（不裁不压扁）。最后一行不满时空位留在画布上。
 *
 * @param n - 帧数（≥ 1）。
 * @param aspect - 源画面宽 / 高。
 * @param width - 画布宽（像素）。
 */
export function layoutSheet(n: number, aspect: number, width: number): SheetLayout {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))))
  const rows = Math.max(1, Math.ceil(n / cols))
  const cellW = width / cols
  const cellH = cellW / (Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3)
  return {
    cols,
    rows,
    cellW,
    cellH,
    width,
    height: Math.max(1, Math.round(rows * cellH)),
  }
}

/**
 * 把几帧拼成一张图。
 *
 * 格子按**源画面的宽高比**等分，所以每一格都是完整的一帧，不裁也不压扁 ——
 * 人脸不会被切掉。列数取 ⌈√n⌉，最后一行可能不满（空位涂成深灰）。
 *
 * @param frames - 这一轮留下的帧（按时序）。
 * @param opts - 画布宽度、源画面尺寸、JPEG 质量。
 * @returns 拼好的图（base64 JPEG）。
 */
export async function composeSheet(
  frames: SheetFrame[],
  opts: { width?: number; sourceWidth?: number; sourceHeight?: number; quality?: number },
): Promise<SheetImage> {
  const n = frames.length
  if (n === 0) throw new Error('composeSheet: 没有帧')
  const width = opts.width ?? SHEET_WIDTH
  const newest = frames[n - 1]!
  const sourceWidth = opts.sourceWidth ?? newest.width
  const sourceHeight = opts.sourceHeight ?? newest.height
  const aspect = sourceHeight > 0 ? sourceWidth / sourceHeight : 4 / 3
  const { cols, rows, cellW, cellH, height } = layoutSheet(n, aspect, width)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('composeSheet: 拿不到 2d 画布')
  ctx.fillStyle = '#121214'
  ctx.fillRect(0, 0, width, height)

  for (let i = 0; i < n; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = Math.round(col * cellW)
    const y = Math.round(row * cellH)
    const w = Math.round((col + 1) * cellW) - x
    const h = Math.round((row + 1) * cellH) - y
    const bitmap = await decodeFrame(frames[i]!.data)
    try {
      ctx.drawImage(bitmap, x, y, w, h)
    } finally {
      bitmap.close?.()
    }
    drawBadge(ctx, i + 1, x, y, w, h)
  }

  const url = canvas.toDataURL('image/jpeg', opts.quality ?? SHEET_QUALITY)
  const comma = url.indexOf(',')
  return { data: comma >= 0 ? url.slice(comma + 1) : url, width, height, cols, rows }
}

/** 把 base64 JPEG 解成可绘制的位图。 */
async function decodeFrame(base64: string): Promise<ImageBitmap> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'image/jpeg' })
  return await createImageBitmap(blob)
}

/**
 * 烧一个帧号。
 *
 * 描边 + 亮黄字：在亮画面和暗画面上都看得清（see-now 用点阵字，这里直接用系统字体，
 * 少一个自造字库的坑）。
 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  index: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const scale = Math.max(11, Math.min(30, Math.round(w / 26)))
  ctx.font = `bold ${scale}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`
  ctx.textBaseline = 'top'
  ctx.lineWidth = Math.max(2, Math.round(scale / 6))
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.fillStyle = '#ffeb3b'
  const label = String(index)
  const px = x + 3
  const py = y + 2
  ctx.strokeText(label, px, py)
  ctx.fillText(label, px, py)
  void h
}
