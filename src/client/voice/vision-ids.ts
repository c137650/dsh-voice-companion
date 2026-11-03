/**
 * 画面附件的身份标记。
 *
 * 宿主把提示里的图片变成附件时，附件 id 就是**图片字节的 sha256**
 * （`sha256:<64 位十六进制>`，对象就存在 ~/.dsh/attachments/v1/objects/<xx>/<sha>）。
 * 所以客户端只要对同一份字节算一次 sha256，就能认出「这张图是我发的」，
 * 从而把用户的截图和摄像头画面区分开 —— 前端 DOM 里没有别的标识可用。
 */

/** 本插件发出过的图片附件 id。 */
const ids = new Set<string>()

/**
 * base64 → 字节。
 * @param b64 - 纯 base64（没有 data: 前缀）。
 * @returns 解码后的字节。
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 记住一张由本插件发出的图片。
 *
 * 调用点在拼图/单帧成型之后 —— 那时的字节才是真正送进提示里的字节，
 * 附件 id 也会是这份字节的 sha256。
 *
 * @param data - 图片的 base64（不含 data: 前缀）。
 */
export async function noteVisionImage(data: string): Promise<void> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', base64ToBytes(data) as unknown as BufferSource)
    let hex = ''
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
    ids.add(`sha256:${hex}`)
  } catch (err) {
    // 没有 crypto.subtle（非安全上下文）就放弃标记：画面照常发送，
    // 只是界面分不出「我们的图」和「用户自己的图」。
    console.warn('[ui-voice] 无法计算画面附件指纹：', err)
  }
}

/**
 * 这个附件是不是本插件发出的画面。
 * @param attachmentId - 附件 id，形如 `sha256:...`。
 * @returns 是本插件发出的画面时为真。
 */
export function isVisionImage(attachmentId: string | undefined): boolean {
  return attachmentId !== undefined && ids.has(attachmentId)
}
