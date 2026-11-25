/**
 * Register the owner's voice with the local bridge.
 *
 *   node tools/enroll-speaker.mjs [path-to-wav]
 *
 * With no file it records nothing and just prints the current state; with a
 * WAV/raw 16 kHz mono file it posts the audio and stores the voiceprint. The
 * recording should be 10–20 seconds of normal speech, at normal distance,
 * with the same microphone used for conversation.
 */
import { readFileSync } from 'node:fs'

const BRIDGE = process.env.VOICE_BRIDGE ?? 'http://127.0.0.1:8765'
const file = process.argv[2]

const status = await fetch(`${BRIDGE}/api/speaker/status`).then((r) => r.json())
console.log('speaker status:', JSON.stringify(status))
if (file === undefined) {
  console.log('usage: node tools/enroll-speaker.mjs <10-20s wav, 16 kHz mono>')
  process.exit(0)
}

const audio = readFileSync(file)
const resp = await fetch(`${BRIDGE}/api/speaker/enroll`, {
  method: 'POST',
  headers: { 'Content-Type': 'audio/wav' },
  body: audio,
})
const body = await resp.text()
console.log(resp.ok ? `enrolled: ${body}` : `enroll failed: ${resp.status} ${body}`)
if (!resp.ok) process.exit(1)
console.log('now every /api/stt call carrying X-Speaker-Check: 1 drops other voices')
