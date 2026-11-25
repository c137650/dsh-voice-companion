/**
 * Hiding the automatic opener from the DSH transcript.
 *
 * The small talk (see `smalltalk.ts`) sends a normal user message the moment
 * the microphone opens. DSH offers no "hidden but model-visible" prompt, so the
 * only place that message can be hidden is where it is rendered — the chat row
 * that carries it.
 *
 * What is known before the message exists is its exact text (we build it) and
 * how DSH renders it: a durable message is the flow item carrying
 * `data-chat-flow-kind` ("user" for a queued prompt, "steering" for one that
 * lands inside a running turn) together with `data-chat-node-key`; the bubble
 * that is on its way is marked `data-pending-steering` or
 * `data-submission-echo`.
 *
 * So the hide is text-based. An opener is registered right before it is sent,
 * and the rows that appear afterwards are compared with it. A durable row that
 * matches gives up its node key: from then on that row is hidden by key, so a
 * re-render cannot bring the words back. This is display only — the model still
 * receives the opener and the session log still records it. A page reload
 * starts an empty registrar, so rows already persisted are left alone.
 */

/** Text this long is matched by prefix: the callback opener is a whole answer. */
const PREFIX_MATCH_MIN = 32
/** How many leading characters of a long opener identify it. */
const PREFIX_LENGTH = 48
/** Allowed length difference for a short opener (a time stamp may join the row). */
const EXACT_SLACK = 6
/** Allowed length difference for a long opener. */
const PREFIX_SLACK = 24
/** An unmatched opener older than this is forgotten. */
const OPENER_TTL_MS = 120_000

/** Message kinds that carry something the user (or the plugin) sent. */
const INPUT_KINDS = new Set(['user', 'steering'])

/** Any element that may be, or contain, an input row. */
const CANDIDATES = '[data-chat-flow-kind], [data-pending-steering], [data-submission-echo]'

/** One opener still waiting for the row it was sent as. */
interface PendingOpener {
  /** The opener with every kind of whitespace removed. */
  text: string
  /** Leading characters of a long opener, null for a short one. */
  prefix: string | null
  /** When it was registered (epoch ms). */
  at: number
  /** A durable row already took it; only its node key still matters. */
  done: boolean
}

const openers: PendingOpener[] = []
/** Node keys of rows that turned out to be an opener (hidden on every render). */
const hiddenKeys = new Set<string>()
let observer: MutationObserver | null = null

/**
 * Read the text of a row, skipping the parts already hidden.
 *
 * A row can briefly hold both the in-flight bubble (already hidden) and the
 * durable message that replaces it; counting the hidden copy would make the
 * text twice as long as the opener and the match would fail.
 *
 * @param root - the row element.
 * @returns the squashed visible text.
 */
function visibleText(root: Element): string {
  let text = ''
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      text += node.nodeValue ?? ''
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    if (element.hasAttribute('hidden')) return
    if (element instanceof HTMLElement && element.style.display === 'none') return
    for (const child of Array.from(element.childNodes)) walk(child)
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  return squash(text)
}

/** Collapse every kind of whitespace: the same text may render differently. */
function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * Whether the hiding is switched off (`localStorage s2s.voice.opener.hide` = 0),
 * the same escape hatch the other optional behaviours of the plugin carry.
 */
function hidingDisabled(): boolean {
  try {
    return localStorage.getItem('s2s.voice.opener.hide') === '0'
  } catch {
    return false
  }
}

/**
 * The element that has to be hidden for a matched row.
 *
 * An in-flight bubble is hidden as it is: hiding the flow item around it could
 * take a sibling with it. A durable message is the flow item itself, so the
 * whole row (bubble, actions, spacing) goes.
 *
 * @param element - an element inside (or being) a chat row.
 * @returns the element to hide, or null when this is not an input row.
 */
function rowOf(element: Element): Element | null {
  const pending = element.closest('[data-pending-steering], [data-submission-echo]')
  if (pending !== null && !pending.hasAttribute('hidden')) return pending
  const kindRow = element.closest('[data-chat-flow-kind]')
  if (kindRow !== null) return kindRow
  return null
}

/** Hide one element for good: a class may override either marker alone. */
function hide(element: Element): void {
  if (element.hasAttribute('hidden')) return
  element.setAttribute('hidden', '')
  if (element instanceof HTMLElement) element.style.display = 'none'
}

/**
 * Take the opener this text belongs to.
 *
 * @param text - squashed text of a row.
 * @returns the opener, or null when the text is not one of them.
 */
function takeOpener(text: string): PendingOpener | null {
  for (const opener of openers) {
    if (opener.done) continue
    if (opener.prefix === null) {
      // A short opener is compared without the row's own trailing clock:
      // 「我来了。」 renders as 「我来了。21:42」, and an exact match would
      // never hold. What is left may only be a few characters long.
      const bare = text.replace(/\d{1,2}[:：]\d{2}$/u, '')
      if (Math.abs(bare.length - opener.text.length) > EXACT_SLACK) continue
      if (bare === opener.text || bare.startsWith(opener.text)) return opener
      continue
    }
    if (!text.startsWith(opener.prefix)) continue
    if (Math.abs(text.length - opener.text.length) > PREFIX_SLACK) continue
    return opener
  }
  return null
}

/**
 * Hide one candidate row when it carries an opener (or a known opener key).
 *
 * @param element - an element that may be, or contain, an input row.
 * @returns whether the element was hidden.
 */
function check(element: Element): boolean {
  const row = rowOf(element)
  if (row === null || row.hasAttribute('hidden')) return false

  const key = row.getAttribute('data-chat-node-key')
  if (key !== null && hiddenKeys.has(key)) {
    hide(row)
    return true
  }

  const kind = row.getAttribute('data-chat-flow-kind')
  if (kind !== null && !INPUT_KINDS.has(kind)) return false
  if (openers.length === 0) return false

  const opener = takeOpener(visibleText(row))
  if (opener === null) return false
  // The durable row hands over its key; the in-flight bubble has none, and the
  // durable row for the same message is still to come.
  if (key !== null) {
    hiddenKeys.add(key)
    opener.done = true
  }
  hide(row)
  // A hidden in-flight bubble may have masked the durable text around it: the
  // row that holds it may match now that the bubble is out of the way.
  const outer = row.closest('[data-chat-flow-kind]')
  if (outer !== null && outer !== row) check(outer)
  return true
}

/** Inspect a freshly added subtree: the row itself and every row inside it. */
function checkTree(element: Element): void {
  if (check(element)) return
  for (const inner of Array.from(element.querySelectorAll(CANDIDATES))) check(inner)
}

/** Drop openers that are old and no longer needed. */
function prune(now: number): void {
  for (let index = openers.length - 1; index >= 0; index -= 1) {
    const opener = openers[index]
    if (opener === undefined) continue
    if (opener.done || now - opener.at > OPENER_TTL_MS) openers.splice(index, 1)
  }
}

/** Start watching the document (once). */
function ensureObserver(): void {
  if (observer !== null) return
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        const parent = record.target.parentElement
        if (parent !== null) check(parent)
        continue
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue
        checkTree(node as Element)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}

/**
 * Register the line that is about to be sent, so it is hidden on the frame it
 * first appears in (no flash of the speaker's own words).
 *
 * Call this BEFORE the prompt goes out.
 *
 * @param text - the exact opener text handed to `session.prompt`.
 */
export function hideOpenerText(text: string): void {
  if (hidingDisabled()) return
  const squashed = squash(text)
  if (squashed.length < 3) return
  if (openers.some((opener) => !opener.done && opener.text === squashed)) return
  prune(Date.now())
  openers.push({
    text: squashed,
    prefix: squashed.length >= PREFIX_MATCH_MIN ? squashed.slice(0, PREFIX_LENGTH) : null,
    at: Date.now(),
    done: false,
  })
  ensureObserver()
  // A slow session may render the row before this call: check once right away.
  for (const element of Array.from(document.querySelectorAll(CANDIDATES))) {
    if (check(element)) break
  }
}

/**
 * Install the watcher for the lifetime of the plugin.
 *
 * @returns the disposer that stops watching.
 */
export function startOpenerHiding(): () => void {
  if (hidingDisabled()) return () => {}
  ensureObserver()
  return () => {
    observer?.disconnect()
    observer = null
  }
}
