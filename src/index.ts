/**
 * Voice chat plugin, node half.
 *
 * The browser half owns mic capture, bridge calls, conversation injection and
 * the companion window. This node half has two jobs:
 *
 *   1. when DSH boots, make sure the local Python voice bridge (:8765) is
 *      running, so the browser half never faces a dead bridge after an app
 *      restart;
 *   2. keep it running — a watchdog pings /api/health, and when the bridge
 *      stops answering it spawns a new one and waits for it to come back.
 *
 * Behaviour on boot:
 *   - if /api/health already answers, do nothing (a bridge started by hand, or
 *     by a previous DSH boot, is left alone);
 *   - otherwise spawn uvicorn detached (no console window, survives DSH exit)
 *     from the repo's bridge/ directory.
 *
 * Behaviour while running (the watchdog):
 *   - every VOICE_BRIDGE_WATCHDOG_INTERVAL ms (default 15 s) ping the bridge;
 *   - after VOICE_BRIDGE_WATCHDOG_FAILS consecutive misses (default 3, so
 *     ~45 s of silence) consider it gone, spawn a new one and wait up to
 *     120 s for it to answer again;
 *   - if that attempt fails too, back off (30 s -> 60 s -> 120 s) and retry.
 *
 * Overrides via environment: VOICE_BRIDGE_PYTHON, VOICE_BRIDGE_DIR,
 * VOICE_BRIDGE_PORT, VOICE_BRIDGE_WATCHDOG (set to 0 to disable the
 * watchdog), VOICE_BRIDGE_WATCHDOG_INTERVAL, VOICE_BRIDGE_WATCHDOG_FAILS.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PYTHON = process.env.VOICE_BRIDGE_PYTHON || 'E:\\anaconda\\envs\\tts0\\python.exe'
const PORT = process.env.VOICE_BRIDGE_PORT || '8765'
const HEALTH = `http://127.0.0.1:${PORT}/api/health`

/** Watchdog on/off (off: the bridge is never restarted behind the user's back). */
const WATCHDOG_ON = process.env.VOICE_BRIDGE_WATCHDOG !== '0'
/** How often the watchdog pings the bridge. */
const WATCHDOG_INTERVAL = readNumber(process.env.VOICE_BRIDGE_WATCHDOG_INTERVAL, 15_000)
/** Consecutive misses before the bridge counts as gone. */
const WATCHDOG_FAILS = Math.max(1, readNumber(process.env.VOICE_BRIDGE_WATCHDOG_FAILS, 3))
/** How long a fresh bridge may take to answer before we give up on it. */
const RESTART_WAIT_MS = 120_000
/** Backoff between failed restart attempts. */
const RESTART_BACKOFF_MS = [30_000, 60_000, 120_000]

/** Read an env var as a number, falling back to the default. */
function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Where the bridge may live, in order of preference.
 *
 * The plugin and the bridge are two halves of one thing: the browser half
 * talks to a local Python service, the node half starts it. When the plugin
 * is installed from this repository the bridge sits right next to it
 * (`<package>/bridge`); on a machine that keeps the bridge somewhere else
 * (the original layout) the old absolute path is still honoured.
 *
 * - `VOICE_BRIDGE_DIR` always wins.
 * - `<package>/bridge` — the bundled backend.
 * - `E:\dsh-voice-ai-girlfriend-main\bridge` — the historical location.
 */
function bridgeDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  // lib/index.js -> the package root is one level up.
  const packageRoot = resolve(here, '..')
  const candidates = [
    process.env.VOICE_BRIDGE_DIR,
    join(packageRoot, 'bridge'),
    'E:\\dsh-voice-ai-girlfriend-main\\bridge',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates
}

/** The first candidate that actually holds voice_bridge.py. */
function resolveBridgeDir(): string | undefined {
  for (const dir of bridgeDirCandidates()) {
    if (existsSync(join(dir, 'voice_bridge.py'))) return dir
  }
  return undefined
}

/**
 * Probe the bridge once. Resolves false on connection error or timeout.
 * @returns whether the bridge answers /api/health with 2xx.
 */
async function bridgeAnswers(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const resp = await fetch(HEALTH, { signal: controller.signal })
    return resp.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Open the bridge's log file for appending.
 *
 * The bridge is spawned detached, so its output cannot go to DSH's console
 * (the pipe would die with DSH). A file next to the bridge keeps the reason
 * of a crash around — the one thing a silent bridge cannot tell you.
 *
 * @param dir - the bridge directory.
 * @returns the file descriptor, or null when it cannot be opened.
 */
function openBridgeLog(dir: string): number | null {
  const logPath = join(dir, 'bridge.log')
  try {
    // Keep the file bounded: start a new one when the old one grew fat.
    if (existsSync(logPath) && statSync(logPath).size > 4 * 1024 * 1024) {
      closeSync(openSync(logPath, 'w'))
    }
    return openSync(logPath, 'a')
  } catch (err) {
    console.error('[voice-bridge] cannot open the log file:', err)
    return null
  }
}

/**
 * Start uvicorn detached so it keeps running after DSH closes.
 * @param dir - the bridge directory (working directory of the child).
 * @returns the spawned pid, or null when spawning threw.
 */
function startBridge(dir: string): number | null {
  const logFd = openBridgeLog(dir)
  try {
    const child = spawn(
      PYTHON,
      ['-m', 'uvicorn', 'voice_bridge:app', '--host', '127.0.0.1', '--port', PORT],
      {
        cwd: dir,
        detached: true,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
        windowsHide: true,
      },
    )
    child.on('error', (err) => {
      console.error('[voice-bridge] spawn failed:', err)
    })
    child.unref()
    return child.pid ?? null
  } catch (err) {
    console.error('[voice-bridge] auto start threw:', err)
    return null
  } finally {
    if (logFd !== null) {
      try { closeSync(logFd) } catch { /* already closed */ }
    }
  }
}

/**
 * Ask the bridge to warm its models up now (STT + TTS), so the first utterance
 * of a session does not pay the cold-start cost. Best effort: a slow or failed
 * warmup must never block anything, so this is fired and forgotten.
 * DSH starts the bridge and then polls it for a while; the warmup request is
 * sent once the health endpoint answers.
 */
async function warmUp(deadlineMs = 180_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (await bridgeAnswers()) {
      try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/api/warmup`, { method: 'POST' })
        if (resp.ok) {
          const body = (await resp.json()) as { stt?: string; tts?: string }
          console.log('[voice-bridge] warmup requested:', JSON.stringify(body))
        }
      } catch (err) {
        console.error('[voice-bridge] warmup request failed:', err)
      }
      return
    }
    await sleep(2000)
  }
  console.warn('[voice-bridge] warmup skipped: bridge never answered')
}

/**
 * Make sure a bridge is up: probe, and spawn one when it does not answer.
 * @returns true when the bridge answers when we are done.
 */
async function ensureBridge(): Promise<boolean> {
  if (await bridgeAnswers()) return true
  const dir = resolveBridgeDir()
  if (dir === undefined) {
    console.warn(
      '[voice-bridge] bridge directory not found (looked at: %s) — start it by hand',
      bridgeDirCandidates().join(', '),
    )
    return false
  }
  const pid = startBridge(dir)
  console.log(
    pid === null
      ? '[voice-bridge] auto start failed'
      : `[voice-bridge] spawned pid ${pid} in ${dir}`,
  )
  return false
}

/**
 * The watchdog: watch the bridge, and bring it back when it dies.
 *
 * It never fights the user: a bridge that answers is left alone, and a
 * restart only happens after several consecutive misses (a single slow
 * answer must not restart a healthy bridge).
 */
async function watchBridge(): Promise<void> {
  let misses = 0
  let attempt = 0
  let backoffUntil = 0
  while (true) {
    await sleep(WATCHDOG_INTERVAL)
    if (await bridgeAnswers()) {
      if (misses > 0) {
        console.log('[voice-bridge] bridge is answering again')
        void warmUp()
      }
      misses = 0
      attempt = 0
      backoffUntil = 0
      continue
    }
    misses += 1
    if (misses < WATCHDOG_FAILS) continue
    misses = 0
    if (Date.now() < backoffUntil) continue
    console.warn(
      `[voice-bridge] no answer for ${WATCHDOG_FAILS} probes — restarting the bridge`,
    )
    const dir = resolveBridgeDir()
    if (dir === undefined) {
      console.warn('[voice-bridge] bridge directory not found — cannot restart')
      attempt = 0
      continue
    }
    const pid = startBridge(dir)
    console.log(pid === null ? '[voice-bridge] restart failed' : `[voice-bridge] restarted as pid ${pid}`)
    // Wait for the new bridge to come up; give up (and back off) if it does not.
    const deadline = Date.now() + RESTART_WAIT_MS
    let back = false
    while (Date.now() < deadline) {
      await sleep(2000)
      if (await bridgeAnswers()) {
        console.log('[voice-bridge] bridge is back')
        void warmUp()
        back = true
        break
      }
    }
    if (!back) {
      attempt += 1
      const wait = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)]
      backoffUntil = Date.now() + wait
      console.warn(`[voice-bridge] bridge did not come back — retrying in ${wait / 1000}s`)
    }
  }
}

/** Host plugin body: ensure the bridge is up, warm it, watch it, get out of the way. */
export function apply(): void {
  if (process.platform !== 'win32') return
  void (async () => {
    const up = await ensureBridge()
    if (up) {
      console.log('[voice-bridge] already running, skipping auto start')
    }
    void warmUp()
    if (WATCHDOG_ON) {
      console.log(
        `[voice-bridge] watchdog on (every ${WATCHDOG_INTERVAL / 1000}s, ${WATCHDOG_FAILS} misses -> restart)`,
      )
      void watchBridge()
    } else {
      console.log('[voice-bridge] watchdog off (VOICE_BRIDGE_WATCHDOG=0)')
    }
  })()
}
