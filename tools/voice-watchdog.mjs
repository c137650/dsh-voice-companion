/**
 * Standalone guardian for the local voice bridge.
 *
 * Runs the plugin's node half (ensure the bridge is up + the watchdog that
 * restarts it when it dies) outside of DSH. The plugin does the same thing
 * inside the app after the next DSH restart; this copy keeps the voice path
 * alive in the meantime, or on a machine where the app is not running.
 *
 *   node tools/voice-watchdog.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Where the plugin's node half may live: this repo's own build first, then
 *  the installed plugin. */
const candidates = [
  join(here, '..', 'lib', 'index.js'),
  'C:\\Users\\34230\\.dsh\\plugins\\voice-ai-girlfriend\\lib\\index.js',
]
const target = candidates.find((path) => existsSync(path))
if (target === undefined) {
  console.error('[voice-watchdog] plugin node half not found — looked at: %s', candidates.join(', '))
  process.exit(1)
}

const { apply } = await import(pathToFileURL(target).href)
apply()
