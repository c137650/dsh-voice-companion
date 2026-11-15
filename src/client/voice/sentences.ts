/**
 * Sentence splitting for streaming TTS (mirrors the original backend's
 * LMOutputProcessor: the reply is spoken sentence-by-sentence, so synthesis
 * pipelines with playback instead of waiting for the whole text).
 *
 * Chinese/English terminal punctuation: 。！？!?… (plus a closing quote/bracket
 * immediately after the terminator is absorbed into the sentence). The
 * trailing unterminated chunk is returned separately as `partial` — it is not
 * spoken until a terminator completes it.
 */

const TERMINATORS = new Set(['。', '！', '？', '!', '?', '…'])

/** True when the sentence is trivial noise (only punctuation/whitespace, or
 *  a single character) — split fragments from JSON/fence content during
 *  streaming ("！" "？" "…" standalone) must never reach the TTS. */
function isTrivial(sentence: string): boolean {
  if (sentence.length <= 1) return true
  // No CJK, no ASCII alphanumerics => punctuation/whitespace only.
  return !/[\u4e00-\u9fff0-9a-zA-Z]/.test(sentence)
}

export interface SentenceSplit {
  /** Complete sentences, each ending with a terminator (trimmed). */
  sentences: string[]
  /** The trailing chunk without a terminator, or null when the text ends on a boundary. */
  partial: string | null
}

/** 换行与分号也当作断句点：模型输出的清单、条目、markdown 列表往往整段
 *  只有一个句号甚至没有句号，只按 。！？ 切会切出几百字一块，合成一次要
 *  几十秒，听感上等于"没播报"。冒号不参与切分——路径里的 "C:" 会被切成
 *  碎片，念出来全是噪音。 */
const SOFT_BREAKS = new Set(['\n', '；', ';'])

/** 软断点产生的最短块长：短于它的片段继续累积，避免"第一块""C:"这类碎渣。 */
const MIN_SOFT_CHUNK = 10

/** 单块上限（字符）：没有标点的长段落按逗号再切，避免一次合成太久。 */
const MAX_CHUNK_CHARS = 60

/** 段落内再按逗号切开，尽量贴近上限、不要切得太碎。 */
function splitLongChunk(chunk: string): string[] {
  if (chunk.length <= MAX_CHUNK_CHARS) return [chunk]
  const parts: string[] = []
  let buf = ''
  for (const ch of chunk) {
    buf += ch
    if ((ch === '，' || ch === ',' || ch === '、') && buf.length >= MAX_CHUNK_CHARS / 2) {
      parts.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim() !== '') parts.push(buf.trim())
  return parts.filter(p => p !== '' && !isTrivial(p))
}

/** Split text into complete sentences + a trailing partial chunk. */
export function splitSentences(text: string): SentenceSplit {
  const sentences: string[] = []
  let buf = ''
  const flush = (minLen: number): void => {
    const trimmed = buf.trim()
    if (trimmed === '' || isTrivial(trimmed)) {
      buf = ''
      return
    }
    if (trimmed.length < minLen) return
    buf = ''
    for (const piece of splitLongChunk(trimmed)) sentences.push(piece)
  }
  for (const ch of text) {
    buf += ch
    if (TERMINATORS.has(ch)) flush(1)
    else if (SOFT_BREAKS.has(ch)) flush(MIN_SOFT_CHUNK)
  }
  const partial = buf.trim()
  return { sentences, partial: partial === '' || isTrivial(partial) ? null : partial }
}
