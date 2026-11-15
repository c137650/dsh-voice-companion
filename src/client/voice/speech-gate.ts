/**
 * Who may speak in the current turn: the reply, or the question it ends with.
 *
 * A turn can end with the agent stopping to ask something. The rule the owner
 * asked for:
 *
 *   - the question is NOT read over the reply, it waits until at least one
 *     sentence of the reply has been spoken — the question is a follow-up to
 *     what was just said, not a replacement for it;
 *   - once the question IS read, the rest of that turn's reply is dropped:
 *     nothing is read after it, because the question already means "stop here
 *     and answer me".
 *
 * Turn identity is the anchor of the user message the turn belongs to, which
 * both halves of this module already track.
 */

/** Whether the microphone is currently hearing the owner talk. */
let userTalking = false

/**
 * Note that the owner is (or stopped) talking.
 *
 * While they are, nothing of the plugin's own voice may start: filler lines
 * and progress narration both wait. Their voice is the conversation; ours is
 * the commentary, and a commentary that talks over the speaker is just noise.
 */
export function noteUserTalking(talking: boolean): void {
  if (talking) lastTalkingAt = Date.now()
  if (userTalking === talking) return
  userTalking = talking
  for (const listener of talkingListeners) listener(talking)
}

/** Listeners told whenever the owner starts or stops talking. */
const talkingListeners = new Set<(talking: boolean) => void>()

/**
 * Subscribe to the "owner is talking" transitions.
 *
 * @param listener - called with the new state.
 * @returns the unsubscribe function.
 */
export function onUserTalkingChange(listener: (talking: boolean) => void): () => void {
  talkingListeners.add(listener)
  return () => {
    talkingListeners.delete(listener)
  }
}

/** Whether the owner is talking right now. */
export function isUserTalking(): boolean {
  return userTalking
}

/** When the owner was last heard talking. */
let lastTalkingAt = 0

/** How long the room has been quiet (ms). */
export function quietForMs(): number {
  if (userTalking) return 0
  if (lastTalkingAt === 0) return Number.POSITIVE_INFINITY
  return Date.now() - lastTalkingAt
}

/**
 * What was spoken, per conversation.
 *
 * Turn numbers are per-chat: two conversations both number their turns from
 * one, so a bare number is not an identity. They are remembered per session
 * key — otherwise session A's question (turn 3) silenced session B's reply
 * (also turn 3) and the answer was never read at all.
 */
const replied = new Map<string, number>()
const asked = new Map<string, { turn: number; anchor: number }>()

/** Note that a reply sentence of this turn went into the speaker. */
export function noteReplySpoken(turn: number, session = ''): void {
  if (turn > 0) replied.set(session, turn)
}

/** Whether this turn has already said something out loud. */
export function repliedInTurn(turn: number, session = ''): boolean {
  return turn > 0 && replied.get(session) === turn
}

/**
 * Note that this turn's question was read out.
 *
 * @param turn - the user turn it belongs to.
 * @param session - the conversation.
 * @param anchor - where the question sits in that conversation.
 */
export function noteQuestionSpoken(turn: number, session = '', anchor = 0): void {
  if (turn > 0) asked.set(session, { turn, anchor })
}

/** Whether this turn's question was already read. */
export function questionAskedInTurn(turn: number, session = ''): boolean {
  const entry = asked.get(session)
  return turn > 0 && entry !== undefined && entry.turn === turn
}

/**
 * Whether a question was read at or AFTER this point in the conversation.
 *
 * Read this as "this text came before the agent stopped to ask". Text that
 * arrives after the question — the answer the user asked for — sits at a
 * higher anchor and must still be spoken; dropping a whole turn because it
 * once asked something is what silenced the reply that followed a question
 * card.
 */
export function questionAheadOf(anchor: number, session = ''): boolean {
  const entry = asked.get(session)
  return anchor > 0 && entry !== undefined && entry.anchor >= anchor
}
