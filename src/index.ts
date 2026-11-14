/**
 * Voice chat plugin, node half.
 *
 * The browser half owns mic capture, bridge calls, conversation injection and
 * the companion window. This node half has three jobs:
 *
 *   1. when DSH boots, make sure the local Python voice bridge (:8765) is
 *      running, so the browser half never faces a dead bridge after an app
 *      restart;
 *   2. keep it running — a watchdog pings /api/health, and when the bridge
 *      stops answering it spawns a new one and waits for it to come back;
 *   3. serve progress narration: one spoken sentence per finished thinking
 *      phase, generated out of band with the conversation's own persona
 *      (see the "Progress narration" section at the bottom).
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
 * watchdog), VOICE_BRIDGE_WATCHDOG_INTERVAL, VOICE_BRIDGE_WATCHDOG_FAILS,
 * VOICE_NARRATE_PORT (set to 0 to serve no narration).
 */
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
  return Number.isFinite(value) && value >= 0 ? value : fallback
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

/* ------------------------------------------------------------------ *
 * Progress narration
 *
 * After each thinking phase the browser asks for one sentence to say out
 * loud: "已经干了什么，正在干什么，将要干什么". The line has to sound like
 * the same 布洛妮娅 who is doing the work, so the persona template that the
 * conversation itself mounts is loaded here (read-only, from
 * dsh-plugin-masterprompt's state) and used as the system message. The call
 * is out of band — it never enters the conversation.
 * ------------------------------------------------------------------ */

/** The slice of the host context this file needs. */
interface HostContext {
  get?: (name: string) => unknown
}

/** Where the browser asks for a line (0 disables the server). */
const NARRATE_PORT = readNumber(process.env.VOICE_NARRATE_PORT, 8767)

/** How long one generation may take. */
const NARRATE_TIMEOUT_MS = 18_000

/**
 * What the model is told to produce.
 *
 * The three things (已经干了什么 / 正在干什么 / 将要干什么) are what the ear
 * wants to hear, but they are NOT written out as a template: a model handed a
 * fill-in-the-blanks outline answers in that outline's voice. The instruction
 * describes the effect and leaves the shape to the model.
 */
const NARRATE_TASK =
  '（下面是布洛妮娅手上正在做的事：上一段思考之后做过的步骤，和刚开始的这一项。' +
  '用布洛妮娅自己的口吻，对身边的舰长随口说一句中文，让舰长知道事情到哪一步了、眼下在忙什么、' +
  '接下来往哪走。一句话，口语，十六到三十二个字，不要分条，不要念文件名和参数，' +
  '不要说"思考""工具调用"这类字眼，不要解释，不要加引号，只输出这一句话。）'

/** Append a line to bridge/narrate.log so failures can be read. */
function narrateLog(message: string): void {
  try {
    const dir = resolveBridgeDir() ?? '.'
    appendFileSync(join(dir, 'narrate.log'), new Date().toISOString() + ' ' + message + '\n')
  } catch {
    // logging must never break anything
  }
}

/** The DSH home directory. */
function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * The persona text the conversation is using.
 *
 * Read fresh on every call: the user may switch templates at any time, and
 * the file is small. Missing or unreadable state simply means no persona —
 * the narration then runs on the task instruction alone.
 *
 * @returns the persona prompt, or '' when none is configured.
 */
function personaText(): string {
  try {
    const raw = readFileSync(join(dshHome(), 'dsh-plugin-masterprompt', 'state.json'), 'utf8')
    const state = JSON.parse(raw) as {
      templates?: Array<{ id?: string; text?: string }>
      defaultPersonaId?: string | null
    }
    const id = state.defaultPersonaId
    const templates = Array.isArray(state.templates) ? state.templates : []
    const chosen = templates.find(t => t.id === id) ?? templates[0]
    return typeof chosen?.text === 'string' ? chosen.text.trim() : ''
  } catch {
    return ''
  }
}

/**
 * The model route the conversation is using right now.
 *
 * `agentDefaultModel` is a host service: it is reached through ctx.get (a
 * bare property read on an un-injected service throws and takes the host
 * down with it).
 *
 * @param ctx - host context.
 * @returns the route, or undefined when the host does not offer one.
 */
function currentRoute(ctx: HostContext | undefined): { provider: string; model: string } | undefined {
  try {
    const selection = (ctx?.get?.('agentDefaultModel') as
      | { currentSelection?: () => { provider?: string; model?: string } | null }
      | undefined)?.currentSelection?.()
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return undefined
    return { provider: selection.provider, model: selection.model }
  } catch {
    return undefined
  }
}

/**
 * Generate one narration sentence.
 *
 * The messages carry their content as BLOCKS ( [{ type: 'text', text }] ).
 * A plain string looks tempting but the DeepSeek request builder maps the
 * content block by block, so a string surfaces as a bogus
 * "DeepSeek Messages transport failed" — that was the real reason the earlier
 * background opener never produced a line.
 *
 * @param ctx - host context.
 * @param material - what has been done / is being done / the reasoning tail.
 * @returns the sentence, or null when anything fails.
 */
async function generateProgress(
  ctx: HostContext | undefined,
  material: string,
): Promise<string | null> {
  try {
    const llm = ctx?.get?.('llm') as
      | {
          stream?: (options: Record<string, unknown>) => AsyncIterable<{ type?: string; text?: string }>
        }
      | undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      narrateLog('host llm service unavailable')
      return null
    }
    const route = currentRoute(ctx)
    if (route === undefined) {
      narrateLog('no model route')
      return null
    }
    const persona = personaText()
    const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = []
    if (persona !== '') messages.push({ role: 'system', content: [{ type: 'text', text: persona }] })
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `${material}\n\n${NARRATE_TASK}` }],
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NARRATE_TIMEOUT_MS)
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens: 200,
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (text.length > 200) break
      }
    } finally {
      clearTimeout(timer)
    }
    const line = text.replace(/\s+/g, ' ').trim().replace(/^["“「]|["”」]$/g, '')
    narrateLog(`route=${route.provider}/${route.model} persona=${persona.length} line=${line}`)
    return line === '' ? null : line.slice(0, 80)
  } catch (err) {
    // This runs inside the host process: an escaping exception would take the
    // whole application down, so every failure ends here.
    narrateLog('generation failed: ' + String((err as Error)?.message ?? err))
    return null
  }
}

/**
 * Serve the narration line to the browser on 127.0.0.1.
 *
 * @param ctx - host context, used for the LLM service and the model route.
 */
function startNarrateServer(ctx: HostContext | undefined): void {
  if (NARRATE_PORT === 0) return
  void import('node:http')
    .then(({ createServer }) => {
      const server = createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', 'content-type')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end()
          return
        }
        if (req.method !== 'POST' || !req.url?.startsWith('/api/progress')) {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}')
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (piece: Buffer) => { chunks.push(piece) })
        req.on('end', () => {
          void (async () => {
            let material = ''
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { material?: unknown }
              if (typeof parsed.material === 'string') material = parsed.material.slice(0, 6000)
            } catch {
              // an unreadable body is simply an empty material
            }
            const line = await generateProgress(ctx, material)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ line }))
          })()
        })
      })
      server.on('error', (err) => {
        console.error('[voice-narrate] server error:', err)
        narrateLog('server error: ' + String((err as Error)?.message ?? err))
      })
      server.listen(NARRATE_PORT, '127.0.0.1', () => {
        console.log(`[voice-narrate] listening on 127.0.0.1:${NARRATE_PORT}`)
      })
    })
    .catch((err) => {
      console.error('[voice-narrate] cannot start:', err)
    })
}

/* ------------------------------------------------------------------ *
 * Daily fillers
 *
 * The filler clips are pre-synthesized, but their TEXT was frozen with them —
 * that is why the same line comes back every day and starts to sound like a
 * record instead of a person. So the text is regenerated once a day (the
 * first time DSH boots), and only the synthesis stays pre-made: the model
 * writes the lines, the local voice renders them.
 *
 * Two calls, not one: the two groups have different jobs and different
 * shapes, and a model asked for both at once averages them into the same
 * sentence twice.
 * ------------------------------------------------------------------ */

/** The clip names of each group. They must match bridge/fillers in the
 *  Python side — the bridge serves exactly these files. */
const FILLER_SLOTS = {
  thinking: ['a2', 'a3', 'a4', 'a5', 'a6', 'b2', 'b3'],
  working: ['w1', 'w2', 'w3', 'w4', 'w5'],
} as const

/** The smallest clip we accept, per group (seconds). A shorter one sounds cut
 *  off: "嗯，嗯。" came out at 0.8 s and played like a truncated word. */
const FILLER_MIN_SECONDS = { thinking: 1.2, working: 2.5 } as const

/** What the model is told for the thinking group. */
const FILLER_THINKING_TASK =
  '（任务：写 9 句「思考时的语气词」——这是布洛妮娅刚开始想事情时随口说的一句，让听的人知道她在想、' +
  '先别打断。硬性要求：每句 8 到 16 个字；每句必须是一句完整的话，不能是半句，不能以逗号、省略号或语气词结尾；' +
  '口语，像当面说话；9 句之间说法要不一样，不要每句都以「嗯」开头；' +
  '不要提到具体任务内容，不要写标题，不要像摘要或说明；不要加引号、括号或编号；' +
  '9 句，每句一行，只输出这 9 行。）'

/** What the model is told for the working group. */
const FILLER_WORKING_TASK =
  '（任务：写 8 句「正在处理和思考、请对方等一下」的话——这是任务已经开始、结果还没出来时对对方说的话。' +
  '硬性要求：每句 16 到 32 个字；每句都要让人听出两层意思——正在处理或正在思考，以及请对方等一下；' +
  '8 句之间说法要不一样，不要每句都写成同一个样子，也不要每句都以「别急」开头；' +
  '每句必须完整，口语，像当面说话；不要提到具体任务内容，不要写标题，不要像摘要或通知；' +
  '不要加引号、括号或编号；8 句，每句一行，只输出这 8 行。）'

/** Characters the local synthesizer can say. Anything else (Hangul, private
 *  use) once made the TTS answer 400 with a GBK error. */
const SPEAKABLE = /[^\u4e00-\u9fffA-Za-z0-9\u3001\u3002\uff01\uff1f\uff0c\u2026\u2014\- ]/g

/** The characters a line may not contain (quotes, brackets, list markers).
 *  The Chinese enumeration comma stays: it is speakable and the model uses it. */
const UNWANTED = /[""''「」『』（）()【】\[\]<>《》]|^-+\s*|\d+\s*[.、)]\s*/g

/**
 * Clean one generated line.
 *
 * @param raw - the line as the model wrote it.
 * @returns the speakable text, or '' when nothing usable is left.
 */
function cleanFillerLine(raw: string): string {
  const text = raw
    .replace(UNWANTED, '')
    .replace(SPEAKABLE, '')
    .trim()
  return text
}

/** How many characters a line has (Chinese counts as one). */
function lineLength(text: string): number {
  return [...text].length
}

/**
 * Split a model's answer into candidate lines.
 *
 * @param answer - the raw text.
 * @returns the cleaned lines, in order.
 */
function parseFillerLines(answer: string): string[] {
  const lines: string[] = []
  for (const raw of answer.split(/\r?\n/)) {
    const text = cleanFillerLine(raw)
    if (text === '') continue
    lines.push(text)
  }
  return lines
}

/**
 * Ask the model for one group's lines.
 *
 * The persona template is mounted as the system message, so the lines come
 * from the same voice the conversation uses — and the model is told exactly
 * what the line is FOR, how long it may be, and what it must not be.
 *
 * @param ctx - host context.
 * @param task - the instruction for this group.
 * @returns the candidate lines.
 */
async function generateFillerLines(
  ctx: HostContext | undefined,
  task: string,
): Promise<string[]> {
  try {
    const llm = ctx?.get?.('llm') as
      | { stream?: (options: Record<string, unknown>) => AsyncIterable<{ type?: string; text?: string }> }
      | undefined
    if (llm === undefined || typeof llm.stream !== 'function') return []
    const route = currentRoute(ctx)
    if (route === undefined) return []
    const persona = personaText()
    const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = []
    const system = persona === ''
      ? '你在扮演布洛妮娅·扎伊切克。'
      : persona
    messages.push({ role: 'system', content: [{ type: 'text', text: system }] })
    messages.push({ role: 'user', content: [{ type: 'text', text: task }] })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NARRATE_TIMEOUT_MS)
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens: 700,
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (text.length > 2000) break
      }
    } finally {
      clearTimeout(timer)
    }
    return parseFillerLines(text)
  } catch (err) {
    narrateLog('filler generation failed: ' + String((err as Error)?.message ?? err))
    return []
  }
}

/**
 * Synthesize one line with the local voice.
 *
 * @param text - the line.
 * @returns the WAV bytes, or null when the bridge refused.
 */
async function synthesizeFiller(text: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!resp.ok) return null
    const buffer = await resp.arrayBuffer()
    return buffer.byteLength > 0 ? buffer : null
  } catch {
    return null
  }
}

/**
 * Read a PCM WAV's duration.
 *
 * @param buffer - the WAV bytes.
 * @returns the duration in seconds (0 when the header is unreadable).
 */
function wavSeconds(buffer: ArrayBuffer): number {
  try {
    const view = new DataView(buffer)
    if (view.byteLength < 44) return 0
    const byteRate = view.getUint32(28, true)
    const dataBytes = view.getUint32(40, true)
    if (byteRate <= 0) return 0
    return dataBytes / byteRate
  } catch {
    return 0
  }
}

/** Today's date in the local time zone (YYYY-MM-DD). */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Rewrite one group's clips with freshly generated lines.
 *
 * The old clips stay on disk until a new one has been rendered AND proven to
 * be long enough — a failed synthesis must never leave a slot empty.
 *
 * @param dir - the bridge directory (the fillers live in it).
 * @param group - which group.
 * @param ctx - host context.
 * @returns the lines that made it into the clips.
 */
async function refreshFillerGroup(
  dir: string,
  group: 'thinking' | 'working',
  ctx: HostContext | undefined,
): Promise<Record<string, string>> {
  const slots = FILLER_SLOTS[group]
  const task = group === 'thinking' ? FILLER_THINKING_TASK : FILLER_WORKING_TASK
  const lines = await generateFillerLines(ctx, task)
  if (lines.length === 0) return {}
  const minSeconds = FILLER_MIN_SECONDS[group]
  const used = new Set<string>()
  const written: Record<string, string> = {}
  const fillerDir = join(dir, 'fillers')
  for (const slot of slots) {
    const line = lines.find(candidate => {
      if (used.has(candidate)) return false
      const length = lineLength(candidate)
      if (group === 'thinking') return length >= 8 && length <= 16
      return length >= 16 && length <= 32
    })
    if (line === undefined) continue
    const wav = await synthesizeFiller(line)
    if (wav === null) continue
    const seconds = wavSeconds(wav)
    if (seconds < minSeconds) {
      // Too short: it would play like a cut-off word. Keep the old clip.
      narrateLog(`filler ${group}/${slot} rejected: ${seconds.toFixed(2)}s for "${line}"`)
      continue
    }
    const path = join(fillerDir, `${slot}.wav`)
    writeFileSync(path, Buffer.from(new Uint8Array(wav)))
    used.add(line)
    written[slot] = line
    narrateLog(`filler ${group}/${slot} (${seconds.toFixed(2)}s): ${line}`)
  }
  return written
}

/**
 * Refresh the fillers once a day.
 *
 * The marker holds the date of the last run: the first boot of a new day
 * regenerates, every later boot that day does not.
 */
async function refreshDailyFillers(ctx: HostContext | undefined): Promise<void> {
  const dir = resolveBridgeDir()
  if (dir === undefined) return
  const fillerDir = join(dir, 'fillers')
  if (!existsSync(fillerDir)) return
  const markerPath = join(fillerDir, 'daily.json')
  const stamp = today()
  try {
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { date?: string }
      if (marker.date === stamp) return
    }
  } catch {
    // an unreadable marker simply means "refresh"
  }
  // Wait for the bridge: the clips are synthesized through it.
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !(await bridgeAnswers())) await sleep(3000)
  if (!(await bridgeAnswers())) {
    narrateLog('daily fillers skipped: the bridge never answered')
    return
  }
  narrateLog(`daily fillers: refreshing for ${stamp}`)
  const thinking = await refreshFillerGroup(dir, 'thinking', ctx)
  const working = await refreshFillerGroup(dir, 'working', ctx)
  if (Object.keys(thinking).length === 0 && Object.keys(working).length === 0) {
    narrateLog('daily fillers: nothing was generated; keeping the old clips')
    return
  }
  // The manifest keeps the manual path working: `node tools/make-fillers.mjs`
  // renders whatever is written here.
  try {
    const manifestPath = join(fillerDir, 'texts.json')
    const manifest = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
      : {}
    manifest.thinking = { ...(manifest.thinking as object), ...thinking }
    manifest.working = { ...(manifest.working as object), ...working }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  } catch (err) {
    narrateLog('daily fillers: manifest not updated: ' + String((err as Error)?.message ?? err))
  }
  writeFileSync(
    markerPath,
    JSON.stringify({ date: stamp, at: new Date().toISOString(), thinking, working }, null, 2) + '\n',
    'utf8',
  )
  narrateLog('daily fillers: done')
}

/** Host plugin body: ensure the bridge is up, warm it, watch it, serve narration. */
export function apply(ctx?: HostContext): void {
  if (process.platform !== 'win32') return
  startNarrateServer(ctx)
  // Once a day: new words for the pre-synthesized clips.
  void refreshDailyFillers(ctx)
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
