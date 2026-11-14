/**
 * score.ts — 画面变化分。
 *
 * 移植自 **dsh-see-now**（SAOS-3624，Apache-2.0）的 `src/cuts.js`：
 * https://github.com/SAOS-3624/dsh-see-now —— 见同目录 NOTICE。
 *
 * 口径没改：把画面降到 64×36 网格、转成 HSV，按
 *
 *   |ΔH|（环形）× min(S) + |ΔS| + |ΔV|
 *
 * 加权求平均，得到 0–255 的"这一帧相对上一帧变了多少"。
 * 色相按环形处理（0 和 255 相邻），低饱和像素的色相降权 ——
 * 灰扑扑的画面不该因为一点点色相抖动就被判成"变了"。
 *
 * 与 see-now 的差别只有一处：**像素不是这里算的**。
 * 摄像头那一侧由桥接（OpenCV）把当前帧转成同一张 64×36 HSV 网格再送过来，
 * 浏览器只负责比对两张网格 —— 于是打分不需要解码 JPEG。
 * 两边的定义是对齐的：OpenCV 的 H 是 0–179，桥接换算成 0–255（同样对应 0–360°）；
 * S、V 两通道两边的定义本来就一样。
 */

/** 网格宽（像素格数）。 */
export const SCAN_W = 64
/** 网格高（像素格数）。 */
export const SCAN_H = 36

/** 一张网格的字节数：64 × 36 × 3 通道。 */
export const GRID_BYTES = SCAN_W * SCAN_H * 3

/**
 * 两张 HSV 网格之间的变化分。
 *
 * @param prev - 上一帧的网格（长度 = GRID_BYTES）。
 * @param cur - 当前帧的网格。
 * @returns 0–255 的变化分；0 表示两帧在网格尺度上完全一样。
 */
export function scorePair(prev: Uint8Array, cur: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i]! - prev[i]!)
    const hueDiff = Math.min(dh, 255 - dh)
    const hueWeight = Math.min(cur[i + 1]!, prev[i + 1]!) / 255
    sum += hueDiff * hueWeight
      + Math.abs(cur[i + 1]! - prev[i + 1]!)
      + Math.abs(cur[i + 2]! - prev[i + 2]!)
  }
  return sum / ((cur.length / 3) * 3)
}

/**
 * 「变了多少格」——给"画面里只有一小块在动"的场景用的统计量。
 *
 * `scorePair` 是全幅平均，一个目标动一下会被整幅画面稀释：实测一个人只占画面
 * 宽度 5% 时，平均分只有 1.11，已经沉在噪声地板（p50 = 1.9）下面了。
 * 这里换成**计数**：逐格算差异，超过阈值的格才算"变了"，最后按比例回到 0–255
 * （全幅都变了 = 255，与平均分同一个量纲，阈值表可以照着用）。
 *
 * 小目标在这一口径下的信噪比好一个数量级：噪声只让零星几格刚过线，
 * 而真正在动的那个东西会让一簇格子大幅过线。
 *
 * @param prev - 上一帧的网格。
 * @param cur - 当前帧的网格。
 * @param threshold - 单格的差异分超过多少算"变了"（0–765 量纲，默认 24）。
 * @returns 0–255 的「变了多少格」。
 */
export function changedCells(prev: Uint8Array, cur: Uint8Array, threshold = 24): number {
  let changed = 0
  let total = 0
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i]! - prev[i]!)
    const hueDiff = Math.min(dh, 255 - dh)
    const hueWeight = Math.min(cur[i + 1]!, prev[i + 1]!) / 255
    const d = hueDiff * hueWeight
      + Math.abs(cur[i + 1]! - prev[i + 1]!)
      + Math.abs(cur[i + 2]! - prev[i + 2]!)
    total += 1
    if (d >= threshold) changed += 1
  }
  return total === 0 ? 0 : (changed / total) * 255
}
