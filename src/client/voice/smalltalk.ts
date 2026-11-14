/**
 * Small talk: the one short line the plugin sends when the microphone opens.
 *
 * Why: the inference latency of a voice turn is unavoidable — the model has
 * to hear the whole utterance, then think, then the first audio has to be
 * synthesized. What CAN be removed is the silence: as soon as the mic opens,
 * the plugin sends a tiny opener, the model starts thinking right away, and
 * the answer to that opener is turned into audio while the user is still
 * talking. When the user's own words finally go to the model, that prepared
 * audio is played — so the gap between "I stopped talking" and "the answer"
 * is filled with the model's own voice instead of nothing.
 *
 * Two cases:
 *   - a fresh conversation: one of a few fixed openers ("在吗？" and friends);
 *   - mid-conversation: a bridge line built on this model's own last answer —
 *     it carries the thread over (承上) and points at what comes next (启下),
 *     so the opener sounds like the same conversation, not a caption.
 *
 * The prompt that goes to the model never carries a character limit — the
 * trimming happens here, on the reply, so the model is free to answer
 * normally and we only *speak* a short version of it.
 */

/** Fixed openers for a fresh conversation. */
export const SMALL_TALK_LINES = ['在吗？', '我来了。', '还在吗？'] as const

/** Maximum length of the compressed call-back line (case 2). */
export const CALLBACK_MAX_CHARS = 10

/** Maximum length of the spoken opening. */
export const CLAUSE_MAX_CHARS = 16

/** A truncated clause is only spoken when at least this share of it fits. */
export const CLAUSE_MIN_COVERAGE = 0.6

/**
 * Characters the synthesizer can actually say: CJK, Latin letters, digits and
 * spaces. Everything else — punctuation, emoji, markdown leftovers — is
 * dropped ("剔除特殊不能播符号").
 */
const SPEAKABLE = /[^一-鿿A-Za-z0-9 \u00b0.\u0000]/g

/** A dot between digits is a decimal point, not a sentence end. */
const DOT_BETWEEN_DIGITS = /(\d)\.(\d)/g

/** Remove the characters that must not be spoken, and tidy the rest. */
export function stripUnspoken(text: string): string {
  const protectedText = text.replace(DOT_BETWEEN_DIGITS, '$1\u0000$2')
  return protectedText
    .replace(SPEAKABLE, '')
    .replace(/\s+/g, ' ')
    .replace(/\u0000/g, '.')
    .trim()
}

/**
 * Split a reply into the phrases that may be spoken.
 *
 * The cut points are the commas AND the sentence ends: a phrase that ends on
 * a full stop is already a complete thought, so cutting there keeps the
 * spoken fragments readable ("舰长的声音没有漏掉" instead of a chunk that
 * runs into the next sentence).
 *
 * A phrase is complete once its delimiter arrives; the trailing chunk stays
 * a partial until the reply settles.
 *
 * @param text - the reply text.
 * @returns the complete phrases and the trailing partial (null when the text
 *          ends on a delimiter).
 */
export function splitClauses(text: string): { clauses: string[]; partial: string | null } {
  const clauses: string[] = []
  let buf = ''
  const flush = (): void => {
    const trimmed = buf.trim()
    if (trimmed !== '') clauses.push(trimmed)
    buf = ''
  }
  for (const ch of text) {
    if (ch === '，' || ch === ',' || ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
      flush()
      continue
    }
    buf += ch
  }
  const partial = buf.trim()
  return { clauses, partial: partial === '' ? null : partial }
}

/** Where a cut may land without sounding chopped: a dash, a space, or the
 *  end of a particle. */
const CUT_BOUNDARY = /[—\- 、·]/u
/** Particles that end a phrase nicely. */
const TAIL_PARTICLE = /[的了吗呢吧啊哦嘛着]$/u

/**
 * Decide whether a phrase may be spoken, and how much of it.
 *
 * - a phrase that fits (≤12 characters) is spoken as it is;
 * - a longer phrase is cut to 12 characters — but only when at least 60% of
 *   it fits there, otherwise the fragment would be too mangled to say;
 * - the cut prefers a natural boundary (dash, space, particle) so the result
 *   still ends like a phrase;
 * - the first phrase is always spoken, even when it fails the test.
 *
 * @param clause - one phrase of the reply.
 * @param force - speak it even when the coverage test fails.
 * @returns the text to speak, or null when the phrase must be skipped.
 */
export function clauseToSpeak(clause: string, force = false): string | null {
  const clean = stripUnspoken(clause)
  if (clean === '') return null
  if (clean.length <= CLAUSE_MAX_CHARS) return clean
  const head = clean.slice(0, CLAUSE_MAX_CHARS)
  const coverage = CLAUSE_MAX_CHARS / clean.length
  if (coverage < CLAUSE_MIN_COVERAGE && !force) return null
  // Prefer a cut that lands on a phrase boundary inside the head.
  const boundary = Math.max(
    ...[...head].map((_, index) => index).filter((index) => CUT_BOUNDARY.test(head[index] ?? '')),
  )
  if (boundary >= Math.floor(CLAUSE_MAX_CHARS / 2)) return head.slice(0, boundary + 1).trim()
  if (TAIL_PARTICLE.test(head)) return head.trim()
  return head
}

/**
 * Build the ONE line that opens the small talk.
 *
 * The opening is not "the first comma phrase" — that is how a one-character
 * "在" ended up being played. The phrases are joined in order until the
 * budget is used up:
 *
 *   - a phrase that still fits is added whole;
 *   - the phrase that would overflow is cut to the remaining room, and only
 *     kept when at least 60% of it fits there (a mangled half-phrase is worse
 *     than stopping a little early);
 *   - when not even the first phrase qualifies, the first one is cut to the
 *     full budget so something is always said.
 *
 * @param phrases - the phrases of the reply, in order.
 * @param force - at the end of the reply, fall back to the first phrase cut
 *        to the budget even when it does not qualify.
 * @param limit - how many characters the opening may use.
 * @returns the text to speak, or null when nothing should be spoken.
 */
export function pickOpeningPhrase(phrases: string[], force = false, limit = CLAUSE_MAX_CHARS): string | null {
  const cleaned: string[] = []
  for (const phrase of phrases) {
    const clean = stripUnspoken(phrase)
    if (clean !== '') cleaned.push(clean)
  }
  if (cleaned.length === 0) return null
  let opening = ''
  for (const phrase of cleaned) {
    const candidate = opening === '' ? phrase : `${opening}，${phrase}`
    if (candidate.length <= limit) {
      opening = candidate
      continue
    }
    // The very first phrase is a whole thought (a summary is one sentence):
    // cutting it mid-word is worse than running a little past the budget.
    if (opening === '' && phrase.length <= limit * 2) return phrase
    const room = limit - (opening === '' ? 0 : opening.length + 1)
    if (room <= 0) break
    if (room / phrase.length >= CLAUSE_MIN_COVERAGE) {
      opening = opening === '' ? phrase.slice(0, room) : `${opening}，${phrase.slice(0, room)}`
    }
    break
  }
  if (opening === '') {
    if (!force) return null
    return cleaned[0]!.slice(0, limit)
  }
  return opening
}

/**
 * Pick the phrases of a reply that may be spoken.
 *
 * @param reply - the reply text (complete).
 * @returns the speakable phrases (at least one when the reply has any).
 */
export function pickClauses(reply: string): string[] {
  const { clauses, partial } = splitClauses(reply)
  const all = partial === null ? clauses : [...clauses, partial]
  const picked: string[] = []
  for (const clause of all) {
    const speak = clauseToSpeak(clause)
    if (speak !== null) picked.push(speak)
  }
  if (picked.length === 0 && all.length > 0) {
    // "至少要播1个逗号句子"：一句都不合格时，把第一句截出来照播。
    const first = clauseToSpeak(all[0]!, true)
    if (first !== null) picked.push(first)
  }
  return picked
}

/**
 * Compress a piece of text into a short call-back line.
 *
 * The result is at most `max` characters; when the text has a natural break
 * (a space) inside the limit, the cut lands there.
 *
 * @param text - the text to compress.
 * @param max - maximum length.
 * @returns the compressed line ('' when nothing usable is left).
 */
export function compressToLine(text: string, max = CALLBACK_MAX_CHARS): string {
  const clean = stripUnspoken(text)
  if (clean === '') return ''
  if (clean.length <= max) return clean
  const head = clean.slice(0, max)
  const boundary = head.lastIndexOf(' ')
  if (boundary >= Math.floor(max / 2)) return head.slice(0, boundary).trim()
  return head
}

/**
 * Pick the opener for a fresh conversation.
 *
 * @returns one of the fixed openers (rotating, so two mic openings in a row
 *          do not sound identical).
 */
export function pickSmallTalkLine(): string {
  const index = Math.floor(Math.random() * SMALL_TALK_LINES.length)
  return SMALL_TALK_LINES[index] ?? SMALL_TALK_LINES[0]
}

/**
 * The instruction sent with the previous answer when the microphone opens
 * mid-conversation.
 *
 * It asks for a BRIDGE, not a summary: the line picks up the thread of what
 * was just said (承上) and leads into what comes next (启下). A summary looks
 * backwards and reads like a caption; a bridge sounds like someone still in
 * the middle of thinking out loud — which is what opening the microphone is
 * supposed to interrupt.
 */
const CALLBACK_INSTRUCTION =
  '（上面这段是你自己刚说过的话。不要总结它，也不要复述它——用口语接一句承上启下的话：' +
  '先顺着上面那句的尾巴接住，再自然地带出你接下来要说的方向，十六个字以内，' +
  '像在跟人当面说话，不要像标题、不要像摘要、不要用书面语，只输出这一句话，不要解释，不要加引号。）'

/**
 * Build the line to send when the microphone opens.
 *
 * A fresh conversation has no previous answer, so it opens with a fixed
 * line. Mid-conversation the model is handed its own last answer verbatim
 * plus a request to bridge it forward — the answer to that request is a real
 * spoken line and is short enough to be spoken immediately.
 *
 * @param previousAnswer - the model's last answer in this session (null in a
 *        fresh conversation).
 * @returns the text to send as the opener.
 */
export function buildSmallTalkLine(previousAnswer: string | null): string {
  const material = (previousAnswer ?? '').trim()
  if (material === '') return pickSmallTalkLine()
  return `${material}\n\n${CALLBACK_INSTRUCTION}`
}

/* ------------------------------------------------------------------ *
 * The armed state: the reply listener has to know that the reply it is
 * looking at is the small talk's (it is spoken in trimmed form, not read
 * out in full).
 * ------------------------------------------------------------------ */

/** How long the reply listener waits for the small talk's reply before it
 *  gives up (and lets normal replies speak again). */
const ARMED_TTL_MS = 45_000

let armed = false
let armedAt = 0
let armedTtl = ARMED_TTL_MS

/**
 * How long a cached opener keeps waiting for its reply.
 *
 * An opener that was sent but never used (the user opened the microphone and
 * said nothing) may sit around for a while; its reply must still be captured
 * as the small talk instead of being read out as a normal reply.
 *
 * It is deliberately not hours: while the opener is armed the reply listener
 * treats the next reply as the small talk's, so an opener that never gets an
 * answer would keep the normal replies from being spoken.
 */
export const CACHED_SMALL_TALK_TTL_MS = 3 * 60_000

/**
 * How long the prepared clip of a cached opener survives.
 *
 * The clip is the answer to the opener; it waits for the moment the user
 * actually says something, which may be a while.
 */
export const CACHED_PENDING_AUDIO_TTL_MS = 30 * 60_000

/**
 * Announce that the next assistant reply is the small talk's.
 *
 * @param ttlMs - how long to wait for that reply.
 */
export function armSmallTalk(ttlMs = ARMED_TTL_MS): void {
  armed = true
  armedAt = Date.now()
  armedTtl = ttlMs
}

/** Whether a small-talk reply is still expected (and not timed out). */
export function isSmallTalkArmed(): boolean {
  if (!armed) return false
  if (Date.now() - armedAt > armedTtl) {
    armed = false
    return false
  }
  return true
}

/** The small-talk reply was handled (spoken or abandoned). */
export function disarmSmallTalk(): void {
  armed = false
}

/* ------------------------------------------------------------------ *
 * The cached opener
 *
 * Opening the microphone sends one short opener so the model starts
 * thinking. If the user says nothing and closes the microphone again, that
 * opener is not thrown away: it stays alive, the next opening reuses it
 * instead of sending another one, and only a message the user actually
 * sent ends it.
 * ------------------------------------------------------------------ */

/** An opener was sent and the user has not spoken yet. */
let openerLive = false
/** The opener's reply was already captured (trimmed and stored). */
let openerReplyCaptured = false

/** Note that an opener was sent (it becomes the live one). */
export function markOpenerLive(): void {
  openerLive = true
}

/** Whether an opener is waiting to be used. */
export function isOpenerLive(): boolean {
  return openerLive
}

/** The user really spoke: the opener is spent. */
export function retireOpener(): void {
  openerLive = false
  openerReplyCaptured = false
}

/** The opener's reply was trimmed and stored (nothing left to wait for). */
export function markOpenerReplyCaptured(): void {
  openerReplyCaptured = true
}

/**
 * Keep a cached opener alive after the microphone was closed.
 *
 * Its reply may still be on its way; without this the reply listener would
 * give up after its short timeout and read that reply out in full.
 */
export function keepOpenerAlive(): void {
  if (!openerLive) return
  if (openerReplyCaptured) return
  armSmallTalk(CACHED_SMALL_TALK_TTL_MS)
}

/**
 * Refresh the age of the prepared clip.
 *
 * The clip belongs to a cached opener: as long as the opener waits, the clip
 * waits with it (the user may open and close the microphone many times
 * before finally saying something).
 */
export function touchPendingSmallTalkAudio(): void {
  if (pendingClips === null) return
  pendingAt = Date.now()
}

/* ------------------------------------------------------------------ *
 * The prepared audio: the small talk's answer is synthesized while the
 * user is still talking, and played when their own words go to the model.
 * ------------------------------------------------------------------ */

let pendingClips: ArrayBuffer[] | null = null
let pendingAt = 0

/** Store the synthesized clips of the small talk's answer. */
export function setPendingSmallTalkAudio(clips: ArrayBuffer[]): void {
  pendingClips = clips
  pendingAt = Date.now()
}

/**
 * Take the prepared clips (they are played once).
 *
 * @param maxAgeMs - clips older than this are dropped. A cached opener waits
 *        for the user to speak, which may take a long time, so it gets the
 *        long window; a fresh one keeps the short one.
 * @returns the clips, or null when there are none.
 */
export function takePendingSmallTalkAudio(
  maxAgeMs = openerLive ? CACHED_PENDING_AUDIO_TTL_MS : 120_000,
): ArrayBuffer[] | null {
  if (pendingClips === null) return null
  const clips = pendingClips
  pendingClips = null
  if (Date.now() - pendingAt > maxAgeMs) return null
  return clips
}

/** Forget the prepared clips (the microphone was closed, or the mic opened
 *  again before the user said anything). */
export function clearPendingSmallTalkAudio(): void {
  pendingClips = null
}

/** Until when the queued small-talk audio is expected to be audible. */
let audioUntil = 0

/**
 * Note that the prepared clips just went into the speaker queue.
 *
 * The reply listener must not stop playback for a new user message or a new
 * reply while this audio is still running: the clips ARE the answer to the
 * user's silence, and cutting them is what makes the small talk "skip".
 *
 * The duration comes from the WAV header, not from a fixed byte rate — the
 * bridge returns 32 kHz audio, and assuming 16 kHz doubled the window during
 * which normal preemption was suppressed.
 *
 * @param clips - the clips that were queued.
 */
export function noteSmallTalkAudioQueued(clips: ArrayBuffer[]): void {
  let ms = 0
  for (const clip of clips) ms += wavDurationMs(clip)
  if (ms <= 0) ms = 1500
  audioUntil = Date.now() + Math.min(60_000, ms) + 400
}

/**
 * Read a PCM WAV's duration from its header.
 *
 * @param buffer - a WAV file.
 * @returns the duration in milliseconds (0 when the header is unreadable).
 */
function wavDurationMs(buffer: ArrayBuffer): number {
  try {
    const view = new DataView(buffer)
    if (view.byteLength < 44) return 0
    const byteRate = view.getUint32(28, true)
    const dataBytes = view.getUint32(40, true)
    if (byteRate <= 0) return 0
    return Math.round((dataBytes / byteRate) * 1000)
  } catch {
    return 0
  }
}

/** Whether the small-talk audio is probably still playing. */
export function smallTalkAudioPlaying(): boolean {
  return Date.now() < audioUntil
}

/* ------------------------------------------------------------------ *
 * The lines we already sent: they are user messages in the transcript
 * too, but they must not be mistaken for "what the user last said" when
 * the next call-back line is built.
 * ------------------------------------------------------------------ */

const sentLines = new Set<string>()
/** The leading characters of every opener sent (mid-conversation openers are
 *  whole previous answers — far too long to compare exactly). */
const sentPrefixes = new Set<string>()

/** How many leading characters identify an opener. */
const OPENER_PREFIX = 24

/** Collapse whitespace so a re-rendered message still matches. */
function squash(text: string): string {
  return text.replace(/\s+/g, '').trim()
}

/** Remember the opener that was just sent. */
export function rememberSmallTalkLine(line: string): void {
  const key = line.trim()
  if (key === '') return
  sentLines.add(key)
  const prefix = squash(key).slice(0, OPENER_PREFIX)
  if (prefix.length >= 4) sentPrefixes.add(prefix)
}

/**
 * Whether this user message is one of our own openers.
 *
 * A fixed opener matches exactly; a call-back opener is a whole previous
 * answer plus an instruction, so it is matched by its leading characters.
 *
 * @param text - the rendered user message.
 * @returns true when this message was sent by the small talk.
 */
export function isSmallTalkLine(text: string): boolean {
  const key = text.trim()
  if (sentLines.has(key)) return true
  if (sentPrefixes.size === 0) return false
  const squashed = squash(key)
  if (squashed === '') return false
  for (const prefix of sentPrefixes) {
    if (squashed.startsWith(prefix)) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * The replies we already used as small talk: the next call-back line
 * must not be built from them (it would quote our own filler).
 * ------------------------------------------------------------------ */

const replyTexts = new Set<string>()

/** Remember that this reply was the answer to an opener. */
export function rememberSmallTalkReplyText(text: string): void {
  const key = text.trim()
  if (key !== '') replyTexts.add(key)
}

/** Whether this assistant text was an answer to one of our openers. */
export function isSmallTalkReplyText(text: string): boolean {
  return replyTexts.has(text.trim())
}
