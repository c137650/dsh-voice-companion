/**
 * Offline check of the small-talk rules (no browser, no bridge):
 *   - the fixed openers for a fresh conversation;
 *   - mid-conversation: the previous answer is handed back verbatim with a
 *     request to compress it to ten characters;
 *   - the opening: phrases joined in order up to a 16-character budget, the
 *     phrase that overflows is cut and only kept when at least 60% of it fits.
 *
 * Run: node test-smalltalk.mjs
 */
import {
  SMALL_TALK_LINES,
  buildSmallTalkLine,
  clauseToSpeak,
  pickOpeningPhrase,
  splitClauses,
  stripUnspoken,
} from './dist-test/smalltalk.js'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`FAIL ${name}\n  actual   ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`)
  } else {
    console.log(`ok   ${name} -> ${JSON.stringify(actual)}`)
  }
}

const char = (n) => '一'.repeat(n)

// --- the fixed openers ---
check('openers', SMALL_TALK_LINES.length, 3)
check('fresh conversation uses an opener', SMALL_TALK_LINES.includes(buildSmallTalkLine(null)), true)
check('the stiff opener is gone', SMALL_TALK_LINES.includes('听到了吗？'), false)

// --- mid-conversation: the previous answer goes back verbatim ---
const previous = '已经按舰长选的方向处理好了，那一层彻底拆掉了。'
const callback = buildSmallTalkLine(previous)
check('callback keeps the answer verbatim', callback.startsWith(previous), true)
check('callback asks for a sixteen-character summary', callback.includes('十六个字以内'), true)
check('callback asks for a colloquial line', callback.includes('口语'), true)
check('callback is not a truncation', callback.includes('摘要'), true)

// --- the symbol filter ---
check('symbols are stripped', stripUnspoken('在的，好。'), '在的好')
check('digits and latin stay', stripUnspoken('RoboMaster 3.5 版'), 'RoboMaster 3.5 版')
check('emoji are stripped', stripUnspoken('听到了。(ᗜ ˰ ᗜ)'), '听到了')

// --- splitting ---
check('split by comma', splitClauses('在的，随时待命').clauses, ['在的'])
check('split keeps the partial', splitClauses('在的，随时待命').partial, '随时待命')
check('split by full stop', splitClauses('听到了。重装小兔一直开着').clauses, ['听到了'])

// --- the phrase rule used by the opening ---
check('short phrase as it is', clauseToSpeak('在的'), '在的')
check('long phrase is cut to 16', clauseToSpeak(char(25)), char(16))
check('over-long phrase is skipped', clauseToSpeak(char(41)), null)

// --- the opening: phrases joined up to 16 characters ---
check('opening: single short phrase', pickOpeningPhrase(['在的']), '在的')
check('opening: a lonely "在" gets the next phrase too', pickOpeningPhrase(['在', '布洛妮娅一直在']), '在，布洛妮娅一直在')
check(
  'opening: stops before an overflowing phrase',
  pickOpeningPhrase(['听到了', '重装小兔的拾音器一直开着', '舰长的声音没有漏掉']),
  '听到了，重装小兔的拾音器一直开着',
)
check('opening: the 60% test decides a cut', pickOpeningPhrase([char(10), char(6)]), `${char(10)}，${char(5)}`)
check('opening: an under-60% overflow is dropped', pickOpeningPhrase([char(10), char(10)]), char(10))
check('opening: nothing yet', pickOpeningPhrase([]), null)
check('opening: forced at the end', pickOpeningPhrase([char(41)], true), char(16))

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
