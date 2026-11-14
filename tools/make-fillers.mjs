/**
 * Render the filler clips with the local GPT-SoVITS voice.
 *
 *   node tools/make-fillers.mjs
 *
 * Reads bridge/fillers/texts.json and writes bridge/fillers/<key>.wav for
 * every entry. The wav files are not committed (they are the owner's voice);
 * run this once on a machine that has the bridge running.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const BRIDGE = process.env.VOICE_BRIDGE ?? 'http://127.0.0.1:8765'
const manifest = JSON.parse(readFileSync(join(root, 'bridge', 'fillers', 'texts.json'), 'utf8'))

let ok = 0
for (const group of ['thinking', 'working', 'notice', 'close']) {
  const entries = manifest[group] ?? {}
  for (const [key, text] of Object.entries(entries)) {
    const resp = await fetch(`${BRIDGE}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!resp.ok) {
      console.log(`FAIL ${group}/${key}: ${resp.status}`)
      continue
    }
    const wav = Buffer.from(await resp.arrayBuffer())
    writeFileSync(join(root, 'bridge', 'fillers', `${key}.wav`), wav)
    ok += 1
    console.log(`ok   ${group}/${key}  ${Math.round(wav.length / 1024)} kB`)
  }
}
console.log(`\n${ok} clips written to bridge/fillers/`)
