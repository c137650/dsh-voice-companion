/**
 * 拼图格子表的离线验证：格子必须保持源画面宽高比（否则人脸会被裁）。
 *
 * 跑法见同目录的构建命令（先 esbuild 打 sheet.ts，再 node 这个文件）。
 */
import { layoutSheet } from './dist-test/sheet.js'

const aspect = 640 / 480
let bad = 0
console.log('n   cols x rows   cell            canvas        每格宽高比')
for (let n = 1; n <= 9; n++) {
  const l = layoutSheet(n, aspect, 1024)
  const cellAspect = l.cellW / l.cellH
  const ok = Math.abs(cellAspect - aspect) < 1e-6
  const fit = l.cols * l.rows >= n
  if (!ok || !fit) bad++
  console.log(
    `${n}   ${l.cols} x ${l.rows}       ${l.cellW.toFixed(1)}x${l.cellH.toFixed(1)}`.padEnd(34) +
      `${l.width}x${l.height}`.padEnd(14) +
      `${cellAspect.toFixed(4)} ${ok ? 'OK' : '坏了'} ${fit ? '' : '格数不够'}`,
  )
}
console.log(bad === 0 ? '全部通过：每格都是完整的一帧，格数够放下所有帧' : `有 ${bad} 处不对`)
