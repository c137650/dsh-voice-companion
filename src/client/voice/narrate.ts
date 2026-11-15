/**
 * Progress narration: one short spoken sentence about the current thinking
 * phase, plus the questions the agent asks out loud.
 *
 * DSH runs a step as a sequence of phases the room can see in the transcript:
 * 思考 (reasoning), 运行命令 (a command tool call), 写入 (a file write), 查看图片
 * (reading an image). A long step produces a rhythm the eye can follow but the
 * ear cannot. This module turns each finished thinking phase into a line.
 *
 * The rules, and why each one exists:
 *
 *   - WHAT the line is about: the steps between the PREVIOUS thinking phase
 *     and this one — interval (last thinking, this thinking]. Describing the
 *     whole task again every time sounds like a machine reading its own log.
 *   - WHY it waits: the 3 s 语气词 and the 10 s working line own the first
 *     moments of a turn; the first narration is held until
 *     NARRATE_FLOOR_MS after the user's message, so the two never overlap.
 *   - WHY it is quiet: two narrations are at least NARRATE_GAP_MS apart,
 *     measured from the END of the previous clip. Anything that finishes in
 *     between is not narrated.
 *   - HOW OFTEN: time alone decides. There is no minimum length — the gates
 *     are the floor after the user's message, the gap after the previous clip,
 *     and the quiet in the room.
 *   - WHO speaks: the node half, with the conversation's own persona loaded —
 *     the narration is out of band and never enters the transcript.
 *   - WHEN: only while the SPEAKER switch is on. The microphone is irrelevant
 *     here: closing it must not silence the running commentary.
 *
 * A question is different from a narration. When the agent calls a question
 * tool it is waiting for an answer from the user — that question is read out
 * verbatim instead of being summarised, and it ignores the thinking floor.
 */
import { bridgeBase, readVoiceEnabled, tts } from '../bridge.ts'
import { cancelFillerTimeline, noteRealSpeech } from './fillers.ts'
import { splitSentences } from './sentences.ts'
import { isUserTalking, noteQuestionSpoken, quietForMs, repliedInTurn } from './speech-gate.ts'
import { stripUnspoken } from './smalltalk.ts'
import type { ReplySpeaker } from './speaker.ts'

/** A rendered chat node (the slice this module reads). */
interface RawNode {
  kind: string
  key: string
  anchorSeq: number
  data?: unknown
}

/** A rendered block of an assistant step. */
interface RawBlock {
  kind?: string
  text?: unknown
  name?: unknown
  argsRaw?: unknown
  callId?: unknown
}

/** No narration before this many ms after the user's message. */
export const NARRATE_FLOOR_MS = 13_000
/** Minimum quiet time between the end of one narration and the next. */
export const NARRATE_GAP_MS = 3_000
/**
 * There is NO length gate on a thinking phase.
 *
 * A phase used to have to be 200+ characters to earn a line, which silenced
 * whole turns for an agent that thinks in short bursts (`Now implement. Plan:`
 * -> a tool call -> two more lines -> another call) — and, worse, it made the
 * rule depend on how wordy the model happened to be that minute. Length says
 * nothing about whether the ear wants to hear it. The rhythm is governed by
 * TIME only: NARRATE_FLOOR_MS before the first line, NARRATE_GAP_MS after each
 * clip, and the room must be quiet. Any finished thinking phase gets a line.
 */
/**
 * How quiet the room must be before a narration starts.
 *
 * A sentence has pauses inside it: starting on the first gap means talking
 * over the owner mid-thought (and being cut off again a moment later). The
 * line waits for a real silence instead.
 */
export const NARRATE_QUIET_MS = 1_500
/**
 * How long a held-back line may wait before it is dropped as stale.
 *
 * Narration is commentary on work in progress; a line that has been waiting
 * this long is describing a moment the conversation has moved past.
 */
export const NARRATE_PENDING_STALE_MS = 45_000

/** The reasoning tail handed to the model as context. */
const REASONING_TAIL = 700
/** How much of one tool call's arguments is kept. */
const ARG_CHARS = 90
/** A spoken line longer than this is cut to its first sentence. */
const LINE_MAX_CHARS = 80

/**
 * Where the narration server lives (the plugin's node half).
 *
 * It has its own port: the bridge (:8765) speaks STT/TTS and knows nothing
 * about the host's model.
 */
function narrateBase(): string {
  try {
    return localStorage.getItem('s2s.voice.narrate')?.trim() || 'http://127.0.0.1:8767'
  } catch {
    return 'http://127.0.0.1:8767'
  }
}

/** Chinese label for a tool name — the phases the ear can tell apart. */
function phaseOf(name: string): string {
  const lower = name.toLowerCase()
  if (/bash|pwsh|powershell|shell|terminal|command|exec/.test(lower)) return '运行命令'
  if (/write|edit|patch|create|mkdir|save|fs_/.test(lower)) return '写入'
  if (/image|vision|screenshot|photo/.test(lower)) return '查看图片'
  return '调用工具'
}

/** Whether this tool call is the agent asking the user something. */
function isQuestion(name: string): boolean {
  return /ask_user|question|ask_user_question/i.test(name)
}

/**
 * The question text out of a question tool call.
 *
 * The payload has two real shapes: a single `question` field, and the
 * `questions` array the DSH tool uses. Both are read here — guessing one and
 * falling back to nothing is how the question stayed silent.
 */
function questionTexts(argsRaw: string): string[] {
  if (argsRaw.trim() === '') return []
  let args: unknown
  try {
    args = JSON.parse(argsRaw)
  } catch {
    return []
  }
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  const bag = args as { question?: unknown; text?: unknown; prompt?: unknown; questions?: unknown }
  const single = text(bag.question) || text(bag.text) || text(bag.prompt)
  if (single !== '') return [single]
  // A question card may carry SEVERAL questions. They used to be joined into
  // one string and then cut to the first sentence, so only the first one was
  // ever heard. Each question is its own line now: every one is read.
  const list = Array.isArray(bag.questions) ? bag.questions : []
  return list
    .map(entry => text((entry as { question?: unknown } | undefined)?.question))
    .filter(part => part !== '')
}

/**
 * One tool call, however the chat view happened to render it.
 *
 * The same call shows up TWICE — as a `tool-call` block inside an assistant
 * step and as its own chat node — with different keys. `id` is the call's own
 * identity (its callId), so the two renderings cannot be spoken twice.
 */
interface CallRecord {
  id: string
  name: string
  args: string
  anchor: number
}

/**
 * Read argument text out of whatever the chat view handed us.
 *
 * The rendered shapes do not agree: sometimes a raw JSON string, sometimes
 * the `PartialArguments` view (`{ text, object }`) the DSH chat uses for
 * streaming tool calls. Reading only the string form is why the question
 * looked like it had no arguments at all.
 */
function argsText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  const view = value as { text?: unknown; object?: unknown; value?: unknown }
  if (typeof view.text === 'string') return view.text
  if (view.object !== undefined && view.object !== null) {
    try {
      return JSON.stringify(view.object)
    } catch {
      return ''
    }
  }
  if (typeof view.value === 'string') return view.value
  return ''
}

/** The arguments of a standalone tool-call node. */
function nodeArgs(root: { argsRaw?: unknown; args?: unknown }): string {
  return argsText(root.argsRaw) || argsText(root.args)
}

/** The arguments of a `tool-call` block inside an assistant step. */
function blockArgs(block: RawBlock): string {
  const loose = block as { argsRaw?: unknown; arguments?: unknown; args?: unknown }
  return argsText(loose.argsRaw) || argsText(loose.arguments) || argsText(loose.args)
}

/**
 * Collect the tool calls of one turn.
 *
 * A call shows up in two different places depending on the view: as a
 * `tool-call` block inside an assistant step, or as its own chat node of kind
 * `tool-call` whose payload lives on `data.root`. Both are read, because the
 * question tool uses the second one.
 */
function collectCalls(
  nodes: readonly RawNode[],
  minAnchor: number,
  turnAnchor: number,
): CallRecord[] {
  const calls: CallRecord[] = []
  for (const node of nodes) {
    if (node.anchorSeq <= minAnchor) continue
    if (turnAnchor > 0 && node.anchorSeq < turnAnchor) continue
    if (node.kind === 'tool-call') {
      const root = (node.data as {
        root?: { name?: unknown; callId?: unknown; argsRaw?: unknown; args?: unknown }
      } | undefined)?.root
      if (root === undefined) continue
      const name = typeof root.name === 'string' ? root.name : ''
      const callId = typeof root.callId === 'string' ? root.callId : ''
      calls.push({
        id: callId !== '' ? `call:${callId}` : `node:${node.key}`,
        name,
        args: nodeArgs(root),
        anchor: node.anchorSeq,
      })
      continue
    }
    if (node.kind !== 'assistant-step') continue
    const blocks = blocksOf(node)
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (block === undefined || block.kind !== 'tool-call') continue
      const name = typeof block.name === 'string' ? block.name : ''
      const callId = typeof block.callId === 'string' ? block.callId : ''
      calls.push({
        id: callId !== '' ? `call:${callId}` : `block:${node.key}#${index}`,
        name,
        args: blockArgs(block),
        anchor: node.anchorSeq,
      })
    }
  }
  return calls
}

/** Compress one tool call to `name(args…)`. */
function callLabel(name: string, argsRaw: string): string {
  const raw = argsRaw.replace(/\s+/g, ' ').trim()
  if (raw === '') return `${name}()`
  return `${name}(${raw.slice(0, ARG_CHARS)})`
}

/**
 * Where speech may start, for a conversation as it is right now.
 *
 * Two different cutoffs, because they answer different questions:
 *
 *   - `finished` — everything that is no longer being written. Nothing at or
 *     below it may ever be READ again, or a reply the user already heard plays
 *     a second time (the "came back to an old conversation and it replayed its
 *     last reply" report).
 *   - `narrated` — what may not be NARRATED. While a turn is live, its own
 *     finished steps are the work happening now, not history; counting them
 *     silenced that turn's thinking phases whenever the view remounted.
 *
 * Only `running` counts as live. `interrupted` means that turn ended early
 * (aborted, or the process went down), so its text is history like any other.
 *
 * @param nodes - the rendered chat nodes.
 * @returns the two cutoffs (0 = nothing), and whether anything was found.
 */
export function speechCutoffs(nodes: readonly RawNode[]): {
  finished: number
  narrated: number
  live: boolean
  hasAny: boolean
} {
  let turnAnchor = 0
  for (const node of nodes) {
    if (node.kind !== 'user') continue
    if (node.anchorSeq > turnAnchor) turnAnchor = node.anchorSeq
  }
  let live = false
  let hasAny = false
  for (const node of nodes) {
    if (node.kind !== 'assistant-step') continue
    const data = node.data as { status?: unknown } | undefined
    if (data === undefined || data === null) continue
    hasAny = true
    if (data.status === 'running') live = true
  }
  let finished = 0
  let narrated = 0
  for (const node of nodes) {
    if (node.kind !== 'assistant-step') continue
    const data = node.data as { status?: unknown } | undefined
    if (data === undefined || data === null) continue
    if (data.status === 'running') continue
    if (node.anchorSeq > finished) finished = node.anchorSeq
    if (live && node.anchorSeq >= turnAnchor) continue
    if (node.anchorSeq > narrated) narrated = node.anchorSeq
  }
  return { finished, narrated, live, hasAny }
}

/**
 * Whether this step is still being written.
 *
 * The chat view marks every assistant node `running | settled | interrupted`.
 * It is what tells a phase worth narrating (work in progress) from a remark
 * that arrives after the answer, when there is nothing left to report.
 */
function stepRunning(node: RawNode): boolean {
  const data = node.data as { status?: unknown } | undefined
  if (data === undefined || data === null) return false
  // Only `running` is live. `interrupted` means that turn ended early, so its
  // steps are finished work like any settled one.
  return data.status === 'running'
}

/** Read the blocks of an assistant step. */
function blocksOf(node: RawNode): RawBlock[] {
  const data = node.data as { blocks?: unknown } | undefined
  if (data === undefined || data === null) return []
  const blocks = (data as { blocks?: unknown }).blocks
  return Array.isArray(blocks) ? (blocks as RawBlock[]) : []
}

/**
 * The formal text this turn produced (what the user reads on screen).
 *
 * @returns the joined text of the turn's steps ('' when there is none).
 */
function formalText(
  steps: readonly RawNode[],
  minAnchor: number,
  turnAnchor: number,
): string {
  const parts: string[] = []
  for (const node of steps) {
    if (node.anchorSeq <= minAnchor) continue
    if (turnAnchor > 0 && node.anchorSeq < turnAnchor) continue
    const text = visibleText(blocksOf(node))
    if (text !== '') parts.push(text)
  }
  return parts.join(' ')
}

/** Join the text blocks of a step (what the user actually reads). */
function visibleText(blocks: RawBlock[]): string {
  return blocks
    .filter(block => block?.kind === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join(' ')
}

/**
 * Cut a spoken line to its first sentence.
 *
 * Same policy as the reply path: the text is truncated, the audio is never cut
 * mid-word. A line that ends without punctuation is simply capped.
 *
 * @param text - what the model (or the question tool) produced.
 * @returns the part that should be spoken.
 */
function firstSentence(text: string): string {
  // The synthesizer is fed GBK-ish text: a stray Hangul or private-use
  // character makes GPT-SoVITS answer 400 and the line is lost. Strip what
  // cannot be spoken before it ever reaches the bridge.
  const clean = stripUnspoken(text.replace(/\s+/g, ' ').trim()).replace(/^["“「]|["”」]$/g, '')
  if (clean.length <= LINE_MAX_CHARS) return clean
  const { sentences } = splitSentences(clean)
  const first = sentences[0] ?? clean
  return first.slice(0, LINE_MAX_CHARS)
}

/** Read a PCM WAV's duration from its header (0 when unreadable). */
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

/** What the watcher decided to say. */
interface Candidate {
  key: string
  /** The material for the narration model call. */
  material: string
}

/**
 * The narration watcher. One instance per plugin fiber.
 */
export class ProgressNarrator {
  /**
   * The conversation this narrator speaks for.
   *
   * One narrator lives per session view, but the turn bookkeeping it shares
   * with the rest of the plugin is global, so this key is what keeps two
   * conversations from talking over each other.
   */
  private sessionKey = ''
  /** Tool calls already looked at (spoken, or deliberately skipped). */
  private seen = new Set<string>()
  /** The last question spoken (the same sentence is never repeated). */
  private lastQuestion = ''
  /** No narration before this instant (the clip's own length + the gap). */
  private quietUntil = 0
  /** When the last narration actually started (0 = none yet this session). */
  private lastLineAt = 0
  private inFlight = false
  /** Pending retry timer for a narration a gate turned away (see `retryLater`). */
  private retryTimer: number | null = null
  /**
   * A line that is ready to be spoken but had to wait for a gate.
   *
   * The scan marks its tool call seen as soon as it builds the material, so a
   * later retry would find nothing left to narrate and the phase would vanish.
   * The material is kept here instead and spoken on the retry.
   */
  private pending: { material: string; tries: number; at: number } | null = null
  /** The turn `pending` belongs to: a new user message makes it stale. */
  private pendingTurn = 0
  /** The arguments of the last observe(), so a retry can look at the same view. */
  private lastNodes: readonly RawNode[] = []
  private lastSpeaker: ReplySpeaker | null = null
  private lastClaim: (() => void) | null = null
  private lastMinAnchor = 0
  private lastTurnStart = 0

  /**
   * Look at the current snapshot and narrate a finished thinking phase.
   *
   * @param nodes - the rendered chat nodes.
   * @param speaker - the shared player.
   * @param claimSpeaker - takes the speaker over before speaking.
   * @param minAnchor - history cut-off: nothing at or below it is spoken.
   * @param turnStart - when the user's message went out (0 = unknown): the
   *        first narration waits NARRATE_FLOOR_MS after it.
   * @param sessionKey - the conversation this view belongs to.
   */
  observe(
    nodes: readonly RawNode[],
    speaker: ReplySpeaker,
    claimSpeaker: () => void,
    minAnchor = 0,
    turnStart = 0,
    sessionKey = '',
  ): void {
    // Which conversation this is: the turn bookkeeping is shared, so two
    // views must not be mistaken for one.
    if (sessionKey !== '') this.sessionKey = sessionKey
    // Remember the view: a narration held back by "the answer is speaking" or
    // by the quiet gap has to be woken up again when that clears. Chat
    // snapshots only arrive while text streams — a five-minute tool call sends
    // none, so nothing would ever call this again.
    this.lastNodes = nodes
    this.lastSpeaker = speaker
    this.lastClaim = claimSpeaker
    this.lastMinAnchor = minAnchor
    this.lastTurnStart = turnStart
    // The speaker switch owns every spoken word of this plugin.
    if (!readVoiceEnabled()) return
    // The owner is talking (or paused inside a sentence): hold everything.
    // Nothing is marked as handled, so the line is spoken once they stop —
    // but "once they stop" needs a wake-up of its own: the talking listener
    // does that, and this timer covers the case where they never talk again.
    if (isUserTalking() || quietForMs() < NARRATE_QUIET_MS) {
      if (!isUserTalking()) {
        this.retryLater(
          NARRATE_QUIET_MS - quietForMs() + 100,
          nodes,
          speaker,
          claimSpeaker,
          minAnchor,
          turnStart,
        )
      }
      return
    }

    const steps = nodes
      .filter(node => node.kind === 'assistant-step')
      .sort((a, b) => a.anchorSeq - b.anchorSeq)
    if (steps.length === 0) return

    // The turn this narration belongs to starts at the last user message:
    // nothing older is described, and the floor is measured from it.
    let turnAnchor = 0
    for (const node of nodes) {
      if (node.kind !== 'user') continue
      if (node.anchorSeq > turnAnchor) turnAnchor = node.anchorSeq
    }

    // A pending line belongs to the turn that produced it. Once the user has
    // spoken again, describing the previous turn's step would be a report on
    // something the conversation has already moved past.
    if (turnAnchor !== this.pendingTurn) {
      this.pending = null
      this.pendingTurn = turnAnchor
    }

    // A question comes FIRST and ignores every narration gate below. It is not
    // a progress remark — it is the agent stopping to wait for an answer, so it
    // must be heard even while the reply is still being read, and the reply
    // gives way to it.
    const questions = this.findQuestions(nodes, minAnchor, turnAnchor)
    if (questions.length > 0) {
      // The question follows the reply, it does not replace it: wait until at
      // least one sentence of this turn's own text has been spoken. A turn
      // that carries no text (the agent just asks) speaks right away.
      const formal = formalText(steps, minAnchor, turnAnchor)
      if (formal !== '' && !repliedInTurn(turnAnchor, this.sessionKey)) return
      void this.speakQuestions(questions, speaker, claimSpeaker, turnAnchor)
      return
    }

    // A line held back while the answer was speaking describes work that has
    // already been reported and is now in the past. Once this turn's answer
    // has been read out and nothing is running any more, it must not surface:
    // that is the "the reply finished, then a skipped thinking line played"
    // report. The age bound is a backstop for a pending line whose turn nobody
    // closed (a route that stopped answering).
    if (this.pending !== null) {
      const answered = repliedInTurn(turnAnchor, this.sessionKey)
      const working = steps.some(stepRunning)
      if ((answered && !working) || Date.now() - this.pending.at > NARRATE_PENDING_STALE_MS) {
        this.pending = null
      }
    }

    const floorFrom = turnStart > 0 ? turnStart : 0
    const beforeFloor = floorFrom === 0 ? false : Date.now() < floorFrom + NARRATE_FLOOR_MS

    const calls: string[] = []
    let reasoning = ''
    let candidate: Candidate | null = null
    for (const node of steps) {
      if (node.anchorSeq <= minAnchor) continue
      if (turnAnchor > 0 && node.anchorSeq < turnAnchor) continue
      const blocks = blocksOf(node)
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block === undefined) continue
        if (block.kind === 'reasoning') {
          if (typeof block.text === 'string' && block.text !== '') {
            reasoning = reasoning === '' ? block.text : `${reasoning} ${block.text}`
          }
          continue
        }
        if (block.kind !== 'tool-call') continue
        const name = typeof block.name === 'string' ? block.name : ''
        const argsRaw = typeof block.argsRaw === 'string' ? block.argsRaw : ''
        // A question belongs to the question path above, which owns its
        // bookkeeping: it must not be marked seen here, or an unreadable
        // payload on one snapshot would silence it forever.
        if (isQuestion(name)) {
          reasoning = ''
          calls.length = 0
          continue
        }

        // The call's own id is the stable identity. A block index shifts when
        // the view compacts (a reasoning block folded away, a text block
        // inserted), and a shifted index both re-announces an old call and
        // silences a new one.
        const callId = typeof (block as { callId?: unknown }).callId === 'string'
          ? (block as { callId: string }).callId
          : ''
        const key = callId !== '' ? `call:${callId}` : `${node.key}#${index}`
        if (this.seen.has(key)) {
          // Still the same call: it must not be narrated twice.
          if (reasoning !== '') reasoning = ''
          continue
        }

        // Any finished thinking phase is worth a line. What keeps the voice
        // from chattering is time (floor, gap, quiet), never the phase's size.
        const phase = reasoning.replace(/\s+/g, ' ').trim()
        if (candidate === null) {
          if (beforeFloor) {
            // Too early: the 3 s / 10 s lines still own the turn. Leave the
            // call UNSEEN and keep the reasoning, so this very phase is picked
            // up on a later snapshot, once the floor has passed. Marking it
            // seen here is why a thinking phase that finished inside the first
            // 13 s was never narrated at all — the thresholds had long passed
            // by the time anyone looked, and there was nothing left to narrate.
            this.retryLater(
              floorFrom + NARRATE_FLOOR_MS - Date.now() + 50,
              nodes,
              speaker,
              claimSpeaker,
              minAnchor,
              turnStart,
            )
            continue
          }
          const done = [...calls]
          const lines = [
            done.length > 0 ? `上一段思考之后做的事：${done.join('；')}` : '还没有做完任何一步',
            `现在开始做：${phaseOf(name)} —— ${callLabel(name, argsRaw)}`,
          ]
          if (phase !== '') {
            lines.push(
              `这段思考的内容（英文原样，只供理解，不要照抄，也不要提到它）：${phase.slice(-REASONING_TAIL)}`,
            )
          }
          candidate = { key, material: lines.join('\n') }
          this.seen.add(key)
          calls.length = 0
          reasoning = ''
          continue
        }
        // Another phase already owns this pass. This one is NOT narrated now,
        // but it must not be burnt either: marking it seen here is why a turn
        // with eight thinking phases produced one line — every phase after the
        // first was swallowed by the very pass that spoke about the first.
        // It stays unseen, its call is remembered as "what happened", and the
        // next pass narrates it.
        reasoning = ''
        calls.push(callLabel(name, argsRaw))
      }
    }
    // A previous attempt built a line and could not speak it yet: that line is
    // still owed to the ear. The fresh scan may also have produced one — the
    // newer one wins, the older one is dropped.
    if (candidate !== null) {
      this.pending = { material: candidate.material, tries: 0, at: Date.now() }
    }
    const owed = this.pending
    if (owed === null) return

    // The line is worth saying; the only question is WHEN. Each of these is a
    // "not yet", not a "no": dropping it here loses the phase for good (that
    // is the silent turn the owner kept hearing). Come back when the gate is
    // gone.
    if (this.inFlight) {
      this.retryLater(1_500, nodes, speaker, claimSpeaker, minAnchor, turnStart)
      return
    }
    // The answer is talking: a narration on top of it is noise.
    if (speaker.speaking) {
      this.retryLater(1_500, nodes, speaker, claimSpeaker, minAnchor, turnStart)
      return
    }
    if (Date.now() < this.quietUntil) {
      this.retryLater(this.quietUntil - Date.now() + 50, nodes, speaker, claimSpeaker, minAnchor, turnStart)
      return
    }

    this.pending = null
    this.inFlight = true
    void (async () => {
      try {
        const line = await this.generate(owed.material)
        if (line === null || line === '') {
          // The node half did not answer. Put the phase back and come back for
          // it: an empty answer is what kept whole turns silent (a reasoning
          // model can spend the whole token budget before it emits a single
          // visible word), so one failure must not cost the landmark. Bounded,
          // so a route that never answers cannot loop here for ever.
          const tries = owed.tries + 1
          if (tries <= 2) {
            this.pending = { material: owed.material, tries, at: owed.at }
            this.retryLater(4_000, nodes, speaker, claimSpeaker, minAnchor, turnStart)
          }
          return
        }
        const wav = await tts(line)
        if (wav.byteLength === 0) return
        // The gates were checked BEFORE the model call and the synthesis, and
        // that is several seconds of silence: the answer can start speaking in
        // the meantime. Claiming the speaker then used to STOP it mid-sentence
        // (the trace shows stop(index#claimSpeaker) with speaking:true). The
        // reply always wins; the narration goes back in the queue and returns.
        if (speaker.speaking) {
          this.pending = { material: owed.material, tries: owed.tries, at: owed.at }
          this.retryLater(1_500, nodes, speaker, claimSpeaker, minAnchor, turnStart)
          return
        }
        // A spoken line is the model talking: the fallback filler ladder has
        // nothing left to cover, and a playing filler is never cut mid-word.
        cancelFillerTimeline(false, this.sessionKey)
        claimSpeaker()
        noteRealSpeech()
        speaker.speak(wav)
        this.lastLineAt = Date.now()
        // Quiet from the END of this clip: two narrations never overlap.
        this.quietUntil = Date.now() + wavDurationMs(wav) + NARRATE_GAP_MS
      } catch (err) {
        console.warn('[ui-voice] narration failed:', err)
      } finally {
        this.inFlight = false
      }
    })()
  }

  /**
   * Run `observe` again after `delayMs`, unless something already did.
   *
   * One timer only: the newest attempt wins, so a burst of snapshots cannot
   * pile up timers.
   */
  private retryLater(
    delayMs: number,
    nodes: readonly RawNode[],
    speaker: ReplySpeaker,
    claimSpeaker: () => void,
    minAnchor: number,
    turnStart: number,
  ): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    const wait = Math.max(250, Math.min(delayMs + 60, 15_000))
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.observe(nodes, speaker, claimSpeaker, minAnchor, turnStart)
    }, wait)
  }

  /** Drop the pending retry (the view this watcher belonged to is gone). */
  dispose(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.pending = null
  }

  /**
   * Find a question the agent asked and has not been read out yet.
   *
   * @param steps - the assistant steps, oldest first.
   * @param minAnchor - history cut-off.
   * @param turnAnchor - the current turn's first anchor.
   * @returns the question to speak, or null.
   */
  private findQuestions(
    nodes: readonly RawNode[],
    minAnchor: number,
    turnAnchor: number,
  ): Array<{ id: string; text: string; anchor: number }> {
    const found: Array<{ id: string; text: string; anchor: number }> = []
    for (const call of collectCalls(nodes, minAnchor, turnAnchor)) {
      if (!isQuestion(call.name)) continue
      if (this.seen.has(call.id)) continue
      const raw = questionTexts(call.args)
      if (raw.length === 0) {
        // Not an argument payload we can read: leave it unseen rather than
        // burning the call — a later snapshot may carry the full text.
        continue
      }
      for (const one of raw) {
        const spoken = firstSentence(one)
        if (spoken === '') continue
        // Belt and braces: the two renderings may carry different callIds (one
        // synthesized), so the same sentence is never said twice in a row.
        if (spoken === this.lastQuestion) continue
        found.push({ id: call.id, text: spoken, anchor: call.anchor })
      }
    }
    return found
  }

  /**
   * Speak a question, cutting the formal content short.
   *
   * The truncation follows the house rule: the sentences still queued are
   * dropped, the one being heard plays out, and the question follows it.
   */
  private async speakQuestions(
    questions: Array<{ id: string; text: string; anchor: number }>,
    speaker: ReplySpeaker,
    claimSpeaker: () => void,
    turnAnchor: number,
  ): Promise<void> {
    // Claim them NOW, synchronously: the wait for the reply's first sentence
    // happened before this call, and a re-entry from another snapshot must not
    // speak the same question twice.
    for (const question of questions) {
      this.seen.add(question.id)
      this.lastQuestion = question.text
    }
    cancelFillerTimeline(false, this.sessionKey)
    speaker.finishCurrent()
    claimSpeaker()
    noteRealSpeech()
    // Everything of this turn that sits BEFORE the question stays unread; the
    // answer the user gets after replying is at a higher anchor and is read
    // normally.
    let questionAnchor = 0
    for (const question of questions) {
      if (question.anchor > questionAnchor) questionAnchor = question.anchor
    }
    noteQuestionSpoken(turnAnchor, this.sessionKey, questionAnchor)
    let totalMs = 0
    for (const question of questions) {
      try {
        console.log('[ui-voice] question to read:', question.text)
        const wav = await tts(question.text)
        if (wav.byteLength === 0) continue
        speaker.speak(wav)
        totalMs += wavDurationMs(wav)
      } catch (err) {
        console.warn('[ui-voice] question playback failed:', err)
      }
    }
    if (totalMs > 0) this.quietUntil = Date.now() + totalMs + NARRATE_GAP_MS
  }

  /**
   * Ask the node half for one sentence.
   *
   * @param material - what has been done / is being done / the reasoning tail.
   * @returns the sentence, or null when the node half is not answering.
   */
  private async generate(material: string): Promise<string | null> {
    try {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 20_000)
      const resp = await fetch(`${narrateBase()}/api/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material }),
        signal: controller.signal,
      })
      window.clearTimeout(timer)
      if (!resp.ok) return null
      const body = (await resp.json()) as { line?: unknown }
      const line = typeof body.line === 'string' ? firstSentence(body.line) : ''
      return line === '' ? null : line
    } catch {
      return null
    }
  }
}
