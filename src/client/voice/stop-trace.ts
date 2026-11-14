/**
 * Stop trace: a read-only side channel that records when playback is stopped
 * and by whom.
 *
 * A normal answer was once cut mid-sentence and the next line continued, which
 * happens whenever `speaker.stop()` is called while something is playing. The
 * call sites are few but the cause is not obvious from the symptom, so each of
 * them reports here — without changing any signature, and without ever letting
 * a failure reach playback.
 *
 * The line lands in bridge/dom-dump.txt (the bridge appends it).
 */
import { bridgeBase } from '../bridge.ts'

/** Where the trace goes. */
const TRACE_URL = '/api/debug/dom'

/**
 * Record one stop call.
 *
 * @param tag - the call site, e.g. `reply-listener#2`.
 * @param detail - optional extra facts (turn, speaking state, …).
 */
export function noteStop(tag: string, detail?: Record<string, unknown>): void {
  try {
    const line = `${new Date().toISOString()} stop(${tag})${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`
    void fetch(`${bridgeBase()}${TRACE_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: line }),
    }).catch(() => undefined)
  } catch {
    // tracing must never break playback
  }
}
