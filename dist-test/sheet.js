// src/client/voice/seenow/score.ts
var SCAN_W = 64;
var SCAN_H = 36;
var GRID_BYTES = SCAN_W * SCAN_H * 3;
function scorePair(prev, cur) {
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return sum / (cur.length / 3 * 3);
}
function changedCells(prev, cur, threshold = 24) {
  let changed = 0;
  let total = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    const d = hueDiff * hueWeight + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
    total += 1;
    if (d >= threshold) changed += 1;
  }
  return total === 0 ? 0 : changed / total * 255;
}

// src/client/voice/sheet.ts
var SHEET_DEFAULTS = {
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
  metric: "mean",
  cellThreshold: 24,
  preRoll: 0
};
var SHEET_WIDTH = 1024;
var SHEET_QUALITY = 0.82;
var SheetPipeline = class {
  o;
  /** 上一帧的网格（打分基准）。 */
  prevGrid = null;
  /** 上一张**留下**的帧的网格（去重基准）。 */
  lastKeptGrid = null;
  /** 待判的帧（最多 2：切点判据要看下一帧的分数）。 */
  queue = [];
  /** 上一帧的变化分。 */
  lastScore = null;
  /** 积分累加器。 */
  acc = 0;
  /** 上一次切点的时刻（秒）。 */
  lastCut = Number.NEGATIVE_INFINITY;
  /** 上一张留下的帧的时刻（秒）。 */
  lastBound = Number.NEGATIVE_INFINITY;
  /** 本轮的零点（毫秒）。 */
  origin = 0;
  /** 本轮留下的帧。 */
  kept = [];
  /** 最近的若干帧（事件前回看用；preRoll = 0 时不占内存）。 */
  ring = [];
  constructor(options = {}) {
    this.o = { ...SHEET_DEFAULTS, ...options };
  }
  /**
   * 换一组参数（不重置状态）。
   *
   * 调车那种"盯着一小块区域"的场景要把口径从 `mean` 换成 `cells`、
   * 打开事件前回看 —— 这些开关在运行时切，不该把已经攒下的帧扔掉。
   */
  configure(options) {
    for (const key of Object.keys(options)) {
      const value = options[key];
      if (value === void 0) continue;
      this.o[key] = value;
    }
    if (this.o.preRoll <= 0) this.ring.length = 0;
  }
  /** 按当前口径算两帧的差异。 */
  diff(prev, cur) {
    return this.o.metric === "cells" ? changedCells(prev, cur, this.o.cellThreshold) : scorePair(prev, cur);
  }
  /** 积分阈值：固定的绝对值（4~5 分/帧 × 帧率 × 秒数）。 */
  integralNeed() {
    return this.o.refScore * this.o.fps * this.o.integralSeconds;
  }
  /**
   * 喂一帧。
   *
   * @param frame - 这一帧的 JPEG、尺寸与网格。
   */
  push(frame) {
    if (this.origin === 0) this.origin = frame.atMs;
    const score = this.prevGrid === null ? null : this.diff(this.prevGrid, frame.grid);
    this.prevGrid = frame.grid;
    const entry = {
      frame: {
        data: frame.data,
        width: frame.width,
        height: frame.height,
        grid: frame.grid,
        atMs: frame.atMs
      },
      score,
      prev: this.lastScore
    };
    this.lastScore = score;
    this.queue.push(entry);
    while (this.queue.length >= 2) {
      const head = this.queue.shift();
      this.decide(head, this.queue[0].score);
    }
    if (this.o.preRoll > 0) {
      this.ring.push(entry.frame);
      while (this.ring.length > Math.max(this.o.preRoll + 2, 24)) this.ring.shift();
    }
  }
  /** 判一帧要不要留。 */
  decide(entry, nextScore) {
    const t = (entry.frame.atMs - this.origin) / 1e3;
    const s = entry.score;
    if (s === null) {
      this.keep(entry, "start");
      return;
    }
    const px = entry.prev ?? 0;
    const nx = nextScore ?? 0;
    const spike = nextScore === null || s > this.o.cutSpike * Math.max(1, px, nx);
    if (s >= this.o.cutAbs && spike && t - this.lastCut >= this.o.cutMinGap) {
      this.lastCut = t;
      this.acc = 0;
      this.keep(entry, "cut");
      return;
    }
    this.acc += s;
    if (this.acc >= this.integralNeed() && t - this.lastBound >= this.o.markMinGap) {
      if (this.keep(entry, "mark")) this.acc = 0;
      return;
    }
    if (t - this.lastBound >= this.o.silentFloorSec) this.keep(entry, "floor");
  }
  /**
   * 留一帧。
   *
   * @returns 是否真的留下来了（被去重挡掉时返回 false）。
   */
  keep(entry, via) {
    const grid = entry.frame.grid;
    const dup = this.lastKeptGrid === null ? null : this.diff(this.lastKeptGrid, grid);
    if (dup !== null && dup < this.o.dupMin && via !== "cut" && via !== "floor") return false;
    if (via === "cut" && this.o.preRoll > 0) this.pushPreRoll(entry.frame.atMs);
    this.lastKeptGrid = grid;
    this.kept.push({ ...entry.frame, via, dup });
    this.lastBound = (entry.frame.atMs - this.origin) / 1e3;
    if (this.kept.length > this.o.maxFrames) this.dropRedundant();
    return true;
  }
  /**
   * 把事件之前攒着的帧补进这一轮（最多 preRoll 张）。
   *
   * @param beforeMs - 事件的时刻；只补比它早的帧。
   */
  pushPreRoll(beforeMs) {
    const older = this.ring.filter((f) => f.atMs < beforeMs);
    const picked = older.slice(-this.o.preRoll);
    if (picked.length === 0) return;
    for (const frame of picked) {
      if (this.kept.some((k) => k.atMs === frame.atMs)) continue;
      this.kept.push({ ...frame, via: "pre", dup: null });
    }
    this.kept.sort((a, b) => a.atMs - b.atMs);
  }
  /**
   * 超过上限时，挤掉一张"删了最不心疼"的。
   *
   * 挑法和旧的多帧路径一样：留那张"和左右邻居都不像"的 —— 留它也不会让模型多知道什么。
   * 首尾两张不动：开头那张给"从哪儿开始"，末尾那张给"现在什么样"。
   */
  dropRedundant() {
    while (this.kept.length > this.o.maxFrames) {
      let victim = -1;
      let cheapest = Number.POSITIVE_INFINITY;
      for (let i = 1; i < this.kept.length - 1; i++) {
        const before = this.kept[i - 1].grid;
        const current = this.kept[i].grid;
        const after = this.kept[i + 1].grid;
        const cost = this.diff(before, current) + this.diff(current, after) - this.diff(before, after);
        if (cost < cheapest) {
          cheapest = cost;
          victim = i;
        }
      }
      if (victim === -1) {
        this.kept.shift();
        continue;
      }
      this.kept.splice(victim, 1);
    }
  }
  /**
   * 取走这一轮留下的帧。
   *
   * 管线的内部状态（打分基准、去重基准、积分）**不会**被清掉 ——
   * 下一轮要和这一轮接着比，不然画面一变就会被判成"又变了"。
   */
  take() {
    const frames = this.kept;
    this.kept = [];
    return frames;
  }
  /** 丢掉攒下的帧（麦克风关了：这一段画面不该再送给模型）。 */
  reset() {
    this.kept = [];
    this.lastKeptGrid = null;
    this.prevGrid = null;
    this.lastScore = null;
    this.acc = 0;
    this.lastCut = Number.NEGATIVE_INFINITY;
    this.lastBound = Number.NEGATIVE_INFINITY;
    this.queue.length = 0;
    this.origin = 0;
  }
  /** 本轮攒下了几帧。 */
  get pending() {
    return this.kept.length;
  }
  /** 积分累加到哪儿了（调试用）。 */
  get integral() {
    return this.acc;
  }
};
function layoutSheet(n, aspect, width) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cellW = width / cols;
  const cellH = cellW / (Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3);
  return {
    cols,
    rows,
    cellW,
    cellH,
    width,
    height: Math.max(1, Math.round(rows * cellH))
  };
}
async function composeSheet(frames, opts) {
  const n = frames.length;
  if (n === 0) throw new Error("composeSheet: \u6CA1\u6709\u5E27");
  const width = opts.width ?? SHEET_WIDTH;
  const newest = frames[n - 1];
  const sourceWidth = opts.sourceWidth ?? newest.width;
  const sourceHeight = opts.sourceHeight ?? newest.height;
  const aspect = sourceHeight > 0 ? sourceWidth / sourceHeight : 4 / 3;
  const { cols, rows, cellW, cellH, height } = layoutSheet(n, aspect, width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("composeSheet: \u62FF\u4E0D\u5230 2d \u753B\u5E03");
  ctx.fillStyle = "#121214";
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = Math.round(col * cellW);
    const y = Math.round(row * cellH);
    const w = Math.round((col + 1) * cellW) - x;
    const h = Math.round((row + 1) * cellH) - y;
    const bitmap = await decodeFrame(frames[i].data);
    try {
      ctx.drawImage(bitmap, x, y, w, h);
    } finally {
      bitmap.close?.();
    }
    drawBadge(ctx, i + 1, x, y, w, h);
  }
  const url = canvas.toDataURL("image/jpeg", opts.quality ?? SHEET_QUALITY);
  const comma = url.indexOf(",");
  return { data: comma >= 0 ? url.slice(comma + 1) : url, width, height, cols, rows };
}
async function decodeFrame(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  return await createImageBitmap(blob);
}
function drawBadge(ctx, index, x, y, w, h) {
  const scale = Math.max(11, Math.min(30, Math.round(w / 26)));
  ctx.font = `bold ${scale}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineWidth = Math.max(2, Math.round(scale / 6));
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.fillStyle = "#ffeb3b";
  const label = String(index);
  const px = x + 3;
  const py = y + 2;
  ctx.strokeText(label, px, py);
  ctx.fillText(label, px, py);
  void h;
}
export {
  SHEET_DEFAULTS,
  SHEET_QUALITY,
  SHEET_WIDTH,
  SheetPipeline,
  composeSheet,
  layoutSheet
};
