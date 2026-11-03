/**
 * 离线验证留帧判据（不碰 canvas、不碰浏览器）。
 *
 * 用合成网格喂管线，检查三件事：
 *   1. 静着的房间几乎不留帧（只有开头的锚点 + 20 秒兜底）；
 *   2. 画面一直在变时，按"积分攒够"留帧，节奏跟着变化量走；
 *   3. 硬切（一下子换画面）会被切点判据抓住。
 *
 * 跑法：node --experimental-strip-types test-sheet.mjs（Node ≥ 22.6）
 * 或先 esbuild 打包。这里直接用打包后的临时文件，见同目录的命令。
 */
import { SheetPipeline } from './dist-test/sheet.js'

const W = 64
const H = 36

/** 造一张"画面"：灰度渐变 + 一个可移动的亮块。 */
function grid(brightness, blockX = -1) {
  const g = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      // 低饱和的灰：色相随便（低饱和时会被降权），S 很小，V 决定亮度
      g[i] = 0
      g[i + 1] = 12
      g[i + 2] = brightness
      if (blockX >= 0 && x >= blockX && x < blockX + 12) g[i + 2] = Math.min(255, brightness + 90)
    }
  }
  return g
}

function frame(brightness, blockX, atMs) {
  return { data: 'x', width: 640, height: 480, grid: grid(brightness, blockX), atMs }
}

function run(name, opts, feeds) {
  const p = new SheetPipeline({ fps: 12, ...opts })
  for (const f of feeds) p.push(f)
  const kept = p.take()
  console.log(
    `${name}: 留下 ${kept.length} 帧 · 理由 ${kept.map((k) => k.via).join(',') || '(无)'}`,
  )
  return kept
}

// 1. 静止 30 秒（12 fps = 360 帧）
const still = []
for (let i = 0; i < 380; i++) still.push(frame(120 + (i % 3), -1, 1000 + i * 83))
run('静止 30 秒', {}, still)

// 2. 一个人慢慢走过画面（每帧亮块右移 1 格）30 秒
const walk = []
for (let i = 0; i < 380; i++) walk.push(frame(120, (i % 52) - 6, 1000 + i * 83))
run('缓慢走动 30 秒', {}, walk)

// 3. 硬切：静止 5 秒后画面整幅换掉
const cut = []
for (let i = 0; i < 60; i++) cut.push(frame(120, -1, 1000 + i * 83))
for (let i = 60; i < 120; i++) cut.push(frame(200, -1, 1000 + i * 83))
run('中间硬切一次', {}, cut)

// 4. 上限：不停变化 60 秒，看会不会超过 maxFrames
const busy = []
for (let i = 0; i < 720; i++) busy.push(frame(120, (i * 7) % 52, 1000 + i * 83))
const keptBusy = run('持续变化 60 秒', { maxFrames: 9 }, busy)
console.log(`  上限检查: ${keptBusy.length <= 9 ? 'OK（≤ 9）' : '超出上限!'}`)

// 5. 小目标：占画面宽度约 5% 的一块在动 —— 平均口径会漏，计数口径应该抓得到
const tiny = []
for (let i = 0; i < 380; i++) tiny.push(frame(120, (i % 20) - 3, 1000 + i * 83))
const meanKept = run('小目标 · 平均口径', {}, tiny)
const cellKept = run('小目标 · 计数口径', {
  metric: 'cells',
  cellThreshold: 24,
  cutAbs: 2.5,
  refScore: 1.2,
  markMinGap: 0.2,
  cutMinGap: 0.15,
}, tiny)
console.log(
  `  对比: 平均口径 ${meanKept.length} 帧 vs 计数口径 ${cellKept.length} 帧` +
    (cellKept.length > meanKept.length ? '（计数口径更敏感，符合预期）' : '（没差别，需要重标）'),
)

// 6. 事件前回看：硬切时应该把切点之前的几帧补进来
const withPre = []
for (let i = 0; i < 60; i++) withPre.push(frame(120, -1, 1000 + i * 83))
for (let i = 60; i < 70; i++) withPre.push(frame(200, -1, 1000 + i * 83))
const preKept = run('硬切 · 回看 3 帧', { preRoll: 3 }, withPre)
const cutAt = preKept.find((k) => k.via === 'cut')?.atMs ?? 0
const before = preKept.filter((k) => k.atMs < cutAt).length
console.log(`  切点之前留下 ${before} 帧 ${before >= 1 ? 'OK（看得到"之前"）' : '没补进来'}`)
