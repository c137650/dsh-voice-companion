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

/** The turn whose reply sentence was spoken last (0 = none yet). */
let repliedTurn = 0
/** The turn whose question was spoken last (0 = none yet). */
let askedTurn = 0

/** Note that a reply sentence of this turn went into the speaker. */
export function noteReplySpoken(turn: number): void {
  if (turn > 0) repliedTurn = turn
}

/** Whether this turn has already said something out loud. */
export function repliedInTurn(turn: number): boolean {
  return turn > 0 && repliedTurn === turn
}

/** Note that this turn's question was read out. */
export function noteQuestionSpoken(turn: number): void {
  if (turn > 0) askedTurn = turn
}

/** Whether this turn's question was already read (its reply must stay quiet). */
export function questionAskedInTurn(turn: number): boolean {
  return turn > 0 && askedTurn === turn
}
