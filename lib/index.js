import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PYTHON = process.env.VOICE_BRIDGE_PYTHON || "E:\\anaconda\\envs\\tts0\\python.exe";
const PORT = process.env.VOICE_BRIDGE_PORT || "8765";
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;
const WATCHDOG_ON = process.env.VOICE_BRIDGE_WATCHDOG !== "0";
const WATCHDOG_INTERVAL = readNumber(process.env.VOICE_BRIDGE_WATCHDOG_INTERVAL, 15e3);
const WATCHDOG_FAILS = Math.max(1, readNumber(process.env.VOICE_BRIDGE_WATCHDOG_FAILS, 3));
const RESTART_WAIT_MS = 12e4;
const RESTART_BACKOFF_MS = [3e4, 6e4, 12e4];
function readNumber(raw, fallback) {
  if (raw === void 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function bridgeDirCandidates() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, "..");
  const candidates = [
    process.env.VOICE_BRIDGE_DIR,
    join(packageRoot, "bridge"),
    "E:\\dsh-voice-ai-girlfriend-main\\bridge"
  ].filter((value) => typeof value === "string" && value.length > 0);
  return candidates;
}
function resolveBridgeDir() {
  for (const dir of bridgeDirCandidates()) {
    if (existsSync(join(dir, "voice_bridge.py"))) return dir;
  }
  return void 0;
}
async function bridgeAnswers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(HEALTH, { signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
function openBridgeLog(dir) {
  const logPath = join(dir, "bridge.log");
  try {
    if (existsSync(logPath) && statSync(logPath).size > 4 * 1024 * 1024) {
      closeSync(openSync(logPath, "w"));
    }
    return openSync(logPath, "a");
  } catch (err) {
    console.error("[voice-bridge] cannot open the log file:", err);
    return null;
  }
}
function startBridge(dir) {
  const logFd = openBridgeLog(dir);
  try {
    const child = spawn(
      PYTHON,
      ["-m", "uvicorn", "voice_bridge:app", "--host", "127.0.0.1", "--port", PORT],
      {
        cwd: dir,
        detached: true,
        stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
        windowsHide: true
      }
    );
    child.on("error", (err) => {
      console.error("[voice-bridge] spawn failed:", err);
    });
    child.unref();
    return child.pid ?? null;
  } catch (err) {
    console.error("[voice-bridge] auto start threw:", err);
    return null;
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
      }
    }
  }
}
async function warmUp(deadlineMs = 18e4) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await bridgeAnswers()) {
      try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/api/warmup`, { method: "POST" });
        if (resp.ok) {
          const body = await resp.json();
          console.log("[voice-bridge] warmup requested:", JSON.stringify(body));
        }
      } catch (err) {
        console.error("[voice-bridge] warmup request failed:", err);
      }
      return;
    }
    await sleep(2e3);
  }
  console.warn("[voice-bridge] warmup skipped: bridge never answered");
}
async function ensureBridge() {
  if (await bridgeAnswers()) return true;
  const dir = resolveBridgeDir();
  if (dir === void 0) {
    console.warn(
      "[voice-bridge] bridge directory not found (looked at: %s) \u2014 start it by hand",
      bridgeDirCandidates().join(", ")
    );
    return false;
  }
  const pid = startBridge(dir);
  console.log(
    pid === null ? "[voice-bridge] auto start failed" : `[voice-bridge] spawned pid ${pid} in ${dir}`
  );
  return false;
}
async function watchBridge() {
  let misses = 0;
  let attempt = 0;
  let backoffUntil = 0;
  while (true) {
    await sleep(WATCHDOG_INTERVAL);
    if (await bridgeAnswers()) {
      if (misses > 0) {
        console.log("[voice-bridge] bridge is answering again");
        void warmUp();
      }
      misses = 0;
      attempt = 0;
      backoffUntil = 0;
      continue;
    }
    misses += 1;
    if (misses < WATCHDOG_FAILS) continue;
    misses = 0;
    if (Date.now() < backoffUntil) continue;
    console.warn(
      `[voice-bridge] no answer for ${WATCHDOG_FAILS} probes \u2014 restarting the bridge`
    );
    const dir = resolveBridgeDir();
    if (dir === void 0) {
      console.warn("[voice-bridge] bridge directory not found \u2014 cannot restart");
      attempt = 0;
      continue;
    }
    const pid = startBridge(dir);
    console.log(pid === null ? "[voice-bridge] restart failed" : `[voice-bridge] restarted as pid ${pid}`);
    const deadline = Date.now() + RESTART_WAIT_MS;
    let back = false;
    while (Date.now() < deadline) {
      await sleep(2e3);
      if (await bridgeAnswers()) {
        console.log("[voice-bridge] bridge is back");
        void warmUp();
        back = true;
        break;
      }
    }
    if (!back) {
      attempt += 1;
      const wait = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
      backoffUntil = Date.now() + wait;
      console.warn(`[voice-bridge] bridge did not come back \u2014 retrying in ${wait / 1e3}s`);
    }
  }
}
const NARRATE_PORT = readNumber(process.env.VOICE_NARRATE_PORT, 8767);
const NARRATE_TIMEOUT_MS = 18e3;
const NARRATE_TASK = '\uFF08\u4E0B\u9762\u662F\u5E03\u6D1B\u59AE\u5A05\u624B\u4E0A\u6B63\u5728\u505A\u7684\u4E8B\uFF1A\u4E0A\u4E00\u6BB5\u601D\u8003\u4E4B\u540E\u505A\u8FC7\u7684\u6B65\u9AA4\uFF0C\u548C\u521A\u5F00\u59CB\u7684\u8FD9\u4E00\u9879\u3002\u7528\u5E03\u6D1B\u59AE\u5A05\u81EA\u5DF1\u7684\u53E3\u543B\uFF0C\u5BF9\u8EAB\u8FB9\u7684\u8230\u957F\u968F\u53E3\u8BF4\u4E00\u53E5\u4E2D\u6587\uFF0C\u8BA9\u8230\u957F\u77E5\u9053\u4E8B\u60C5\u5230\u54EA\u4E00\u6B65\u4E86\u3001\u773C\u4E0B\u5728\u5FD9\u4EC0\u4E48\u3001\u63A5\u4E0B\u6765\u5F80\u54EA\u8D70\u3002\u4E00\u53E5\u8BDD\uFF0C\u53E3\u8BED\uFF0C\u5341\u516D\u5230\u4E09\u5341\u4E8C\u4E2A\u5B57\uFF0C\u4E0D\u8981\u5206\u6761\uFF0C\u4E0D\u8981\u5FF5\u6587\u4EF6\u540D\u548C\u53C2\u6570\uFF0C\u4E0D\u8981\u8BF4"\u601D\u8003""\u5DE5\u5177\u8C03\u7528"\u8FD9\u7C7B\u5B57\u773C\uFF0C\u4E0D\u8981\u89E3\u91CA\uFF0C\u4E0D\u8981\u52A0\u5F15\u53F7\uFF0C\u53EA\u8F93\u51FA\u8FD9\u4E00\u53E5\u8BDD\u3002\uFF09';
function narrateLog(message) {
  try {
    const dir = resolveBridgeDir() ?? ".";
    appendFileSync(join(dir, "narrate.log"), (/* @__PURE__ */ new Date()).toISOString() + " " + message + "\n");
  } catch {
  }
}
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
function personaText() {
  try {
    const raw = readFileSync(join(dshHome(), "dsh-plugin-masterprompt", "state.json"), "utf8");
    const state = JSON.parse(raw);
    const id = state.defaultPersonaId;
    const templates = Array.isArray(state.templates) ? state.templates : [];
    const chosen = templates.find((t) => t.id === id) ?? templates[0];
    return typeof chosen?.text === "string" ? chosen.text.trim() : "";
  } catch {
    return "";
  }
}
function currentRoute(ctx) {
  try {
    const selection = ctx?.get?.("agentDefaultModel")?.currentSelection?.();
    if (typeof selection?.provider !== "string" || typeof selection?.model !== "string") return void 0;
    return { provider: selection.provider, model: selection.model };
  } catch {
    return void 0;
  }
}
async function generateProgress(ctx, material) {
  try {
    const llm = ctx?.get?.("llm");
    if (llm === void 0 || typeof llm.stream !== "function") {
      narrateLog("host llm service unavailable");
      return null;
    }
    const route = currentRoute(ctx);
    if (route === void 0) {
      narrateLog("no model route");
      return null;
    }
    const persona = personaText();
    const messages = [];
    if (persona !== "") messages.push({ role: "system", content: [{ type: "text", text: persona }] });
    messages.push({
      role: "user",
      content: [{ type: "text", text: `${material}

${NARRATE_TASK}` }]
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NARRATE_TIMEOUT_MS);
    let text = "";
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens: 200,
        signal: controller.signal
      })) {
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
        if (text.length > 200) break;
      }
    } finally {
      clearTimeout(timer);
    }
    const line = text.replace(/\s+/g, " ").trim().replace(/^["“「]|["”」]$/g, "");
    narrateLog(`route=${route.provider}/${route.model} persona=${persona.length} line=${line}`);
    return line === "" ? null : line.slice(0, 80);
  } catch (err) {
    narrateLog("generation failed: " + String(err?.message ?? err));
    return null;
  }
}
function startNarrateServer(ctx) {
  if (NARRATE_PORT === 0) return;
  void import("node:http").then(({ createServer }) => {
    const server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/api/progress")) {
        res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
        return;
      }
      const chunks = [];
      req.on("data", (piece) => {
        chunks.push(piece);
      });
      req.on("end", () => {
        void (async () => {
          let material = "";
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (typeof parsed.material === "string") material = parsed.material.slice(0, 6e3);
          } catch {
          }
          const line = await generateProgress(ctx, material);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ line }));
        })();
      });
    });
    server.on("error", (err) => {
      console.error("[voice-narrate] server error:", err);
      narrateLog("server error: " + String(err?.message ?? err));
    });
    server.listen(NARRATE_PORT, "127.0.0.1", () => {
      console.log(`[voice-narrate] listening on 127.0.0.1:${NARRATE_PORT}`);
    });
  }).catch((err) => {
    console.error("[voice-narrate] cannot start:", err);
  });
}
const FILLER_SLOTS = {
  thinking: ["a2", "a3", "a4", "a5", "a6", "b2", "b3"],
  working: ["w1", "w2", "w3", "w4", "w5"]
};
const FILLER_MIN_SECONDS = { thinking: 1.2, working: 2.5 };
const FILLER_THINKING_TASK = "\uFF08\u4EFB\u52A1\uFF1A\u5199 9 \u53E5\u300C\u601D\u8003\u65F6\u7684\u8BED\u6C14\u8BCD\u300D\u2014\u2014\u8FD9\u662F\u5E03\u6D1B\u59AE\u5A05\u521A\u5F00\u59CB\u60F3\u4E8B\u60C5\u65F6\u968F\u53E3\u8BF4\u7684\u4E00\u53E5\uFF0C\u8BA9\u542C\u7684\u4EBA\u77E5\u9053\u5979\u5728\u60F3\u3001\u5148\u522B\u6253\u65AD\u3002\u786C\u6027\u8981\u6C42\uFF1A\u6BCF\u53E5 8 \u5230 16 \u4E2A\u5B57\uFF1B\u6BCF\u53E5\u5FC5\u987B\u662F\u4E00\u53E5\u5B8C\u6574\u7684\u8BDD\uFF0C\u4E0D\u80FD\u662F\u534A\u53E5\uFF0C\u4E0D\u80FD\u4EE5\u9017\u53F7\u3001\u7701\u7565\u53F7\u6216\u8BED\u6C14\u8BCD\u7ED3\u5C3E\uFF1B\u53E3\u8BED\uFF0C\u50CF\u5F53\u9762\u8BF4\u8BDD\uFF1B9 \u53E5\u4E4B\u95F4\u8BF4\u6CD5\u8981\u4E0D\u4E00\u6837\uFF0C\u4E0D\u8981\u6BCF\u53E5\u90FD\u4EE5\u300C\u55EF\u300D\u5F00\u5934\uFF1B\u4E0D\u8981\u63D0\u5230\u5177\u4F53\u4EFB\u52A1\u5185\u5BB9\uFF0C\u4E0D\u8981\u5199\u6807\u9898\uFF0C\u4E0D\u8981\u50CF\u6458\u8981\u6216\u8BF4\u660E\uFF1B\u4E0D\u8981\u52A0\u5F15\u53F7\u3001\u62EC\u53F7\u6216\u7F16\u53F7\uFF1B9 \u53E5\uFF0C\u6BCF\u53E5\u4E00\u884C\uFF0C\u53EA\u8F93\u51FA\u8FD9 9 \u884C\u3002\uFF09";
const FILLER_WORKING_TASK = "\uFF08\u4EFB\u52A1\uFF1A\u5199 8 \u53E5\u300C\u6B63\u5728\u5904\u7406\u548C\u601D\u8003\u3001\u8BF7\u5BF9\u65B9\u7B49\u4E00\u4E0B\u300D\u7684\u8BDD\u2014\u2014\u8FD9\u662F\u4EFB\u52A1\u5DF2\u7ECF\u5F00\u59CB\u3001\u7ED3\u679C\u8FD8\u6CA1\u51FA\u6765\u65F6\u5BF9\u5BF9\u65B9\u8BF4\u7684\u8BDD\u3002\u786C\u6027\u8981\u6C42\uFF1A\u6BCF\u53E5 16 \u5230 32 \u4E2A\u5B57\uFF1B\u6BCF\u53E5\u90FD\u8981\u8BA9\u4EBA\u542C\u51FA\u4E24\u5C42\u610F\u601D\u2014\u2014\u6B63\u5728\u5904\u7406\u6216\u6B63\u5728\u601D\u8003\uFF0C\u4EE5\u53CA\u8BF7\u5BF9\u65B9\u7B49\u4E00\u4E0B\uFF1B8 \u53E5\u4E4B\u95F4\u8BF4\u6CD5\u8981\u4E0D\u4E00\u6837\uFF0C\u4E0D\u8981\u6BCF\u53E5\u90FD\u5199\u6210\u540C\u4E00\u4E2A\u6837\u5B50\uFF0C\u4E5F\u4E0D\u8981\u6BCF\u53E5\u90FD\u4EE5\u300C\u522B\u6025\u300D\u5F00\u5934\uFF1B\u6BCF\u53E5\u5FC5\u987B\u5B8C\u6574\uFF0C\u53E3\u8BED\uFF0C\u50CF\u5F53\u9762\u8BF4\u8BDD\uFF1B\u4E0D\u8981\u63D0\u5230\u5177\u4F53\u4EFB\u52A1\u5185\u5BB9\uFF0C\u4E0D\u8981\u5199\u6807\u9898\uFF0C\u4E0D\u8981\u50CF\u6458\u8981\u6216\u901A\u77E5\uFF1B\u4E0D\u8981\u52A0\u5F15\u53F7\u3001\u62EC\u53F7\u6216\u7F16\u53F7\uFF1B8 \u53E5\uFF0C\u6BCF\u53E5\u4E00\u884C\uFF0C\u53EA\u8F93\u51FA\u8FD9 8 \u884C\u3002\uFF09";
const SPEAKABLE = /[^\u4e00-\u9fffA-Za-z0-9\u3001\u3002\uff01\uff1f\uff0c\u2026\u2014\- ]/g;
const UNWANTED = /[""''「」『』（）()【】\[\]<>《》]|^-+\s*|\d+\s*[.、)]\s*/g;
function cleanFillerLine(raw) {
  const text = raw.replace(UNWANTED, "").replace(SPEAKABLE, "").trim();
  return text;
}
function lineLength(text) {
  return [...text].length;
}
function parseFillerLines(answer) {
  const lines = [];
  for (const raw of answer.split(/\r?\n/)) {
    const text = cleanFillerLine(raw);
    if (text === "") continue;
    lines.push(text);
  }
  return lines;
}
async function generateFillerLines(ctx, task) {
  try {
    const llm = ctx?.get?.("llm");
    if (llm === void 0 || typeof llm.stream !== "function") return [];
    const route = currentRoute(ctx);
    if (route === void 0) return [];
    const persona = personaText();
    const messages = [];
    const system = persona === "" ? "\u4F60\u5728\u626E\u6F14\u5E03\u6D1B\u59AE\u5A05\xB7\u624E\u4F0A\u5207\u514B\u3002" : persona;
    messages.push({ role: "system", content: [{ type: "text", text: system }] });
    messages.push({ role: "user", content: [{ type: "text", text: task }] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NARRATE_TIMEOUT_MS);
    let text = "";
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens: 700,
        signal: controller.signal
      })) {
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
        if (text.length > 2e3) break;
      }
    } finally {
      clearTimeout(timer);
    }
    return parseFillerLines(text);
  } catch (err) {
    narrateLog("filler generation failed: " + String(err?.message ?? err));
    return [];
  }
}
async function synthesizeFiller(text) {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!resp.ok) return null;
    const buffer = await resp.arrayBuffer();
    return buffer.byteLength > 0 ? buffer : null;
  } catch {
    return null;
  }
}
function wavSeconds(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44) return 0;
    const byteRate = view.getUint32(28, true);
    const dataBytes = view.getUint32(40, true);
    if (byteRate <= 0) return 0;
    return dataBytes / byteRate;
  } catch {
    return 0;
  }
}
function today() {
  const now = /* @__PURE__ */ new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
async function refreshFillerGroup(dir, group, ctx) {
  const slots = FILLER_SLOTS[group];
  const task = group === "thinking" ? FILLER_THINKING_TASK : FILLER_WORKING_TASK;
  const lines = await generateFillerLines(ctx, task);
  if (lines.length === 0) return {};
  const minSeconds = FILLER_MIN_SECONDS[group];
  const used = /* @__PURE__ */ new Set();
  const written = {};
  const fillerDir = join(dir, "fillers");
  for (const slot of slots) {
    const line = lines.find((candidate) => {
      if (used.has(candidate)) return false;
      const length = lineLength(candidate);
      if (group === "thinking") return length >= 8 && length <= 16;
      return length >= 16 && length <= 32;
    });
    if (line === void 0) continue;
    const wav = await synthesizeFiller(line);
    if (wav === null) continue;
    const seconds = wavSeconds(wav);
    if (seconds < minSeconds) {
      narrateLog(`filler ${group}/${slot} rejected: ${seconds.toFixed(2)}s for "${line}"`);
      continue;
    }
    const path = join(fillerDir, `${slot}.wav`);
    writeFileSync(path, Buffer.from(new Uint8Array(wav)));
    used.add(line);
    written[slot] = line;
    narrateLog(`filler ${group}/${slot} (${seconds.toFixed(2)}s): ${line}`);
  }
  return written;
}
async function refreshDailyFillers(ctx) {
  const dir = resolveBridgeDir();
  if (dir === void 0) return;
  const fillerDir = join(dir, "fillers");
  if (!existsSync(fillerDir)) return;
  const markerPath = join(fillerDir, "daily.json");
  const stamp = today();
  try {
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (marker.date === stamp) return;
    }
  } catch {
  }
  const deadline = Date.now() + 12e4;
  while (Date.now() < deadline && !await bridgeAnswers()) await sleep(3e3);
  if (!await bridgeAnswers()) {
    narrateLog("daily fillers skipped: the bridge never answered");
    return;
  }
  narrateLog(`daily fillers: refreshing for ${stamp}`);
  const thinking = await refreshFillerGroup(dir, "thinking", ctx);
  const working = await refreshFillerGroup(dir, "working", ctx);
  if (Object.keys(thinking).length === 0 && Object.keys(working).length === 0) {
    narrateLog("daily fillers: nothing was generated; keeping the old clips");
    return;
  }
  try {
    const manifestPath = join(fillerDir, "texts.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    manifest.thinking = { ...manifest.thinking, ...thinking };
    manifest.working = { ...manifest.working, ...working };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } catch (err) {
    narrateLog("daily fillers: manifest not updated: " + String(err?.message ?? err));
  }
  writeFileSync(
    markerPath,
    JSON.stringify({ date: stamp, at: (/* @__PURE__ */ new Date()).toISOString(), thinking, working }, null, 2) + "\n",
    "utf8"
  );
  narrateLog("daily fillers: done");
}
function apply(ctx) {
  if (process.platform !== "win32") return;
  startNarrateServer(ctx);
  void refreshDailyFillers(ctx);
  void (async () => {
    const up = await ensureBridge();
    if (up) {
      console.log("[voice-bridge] already running, skipping auto start");
    }
    void warmUp();
    if (WATCHDOG_ON) {
      console.log(
        `[voice-bridge] watchdog on (every ${WATCHDOG_INTERVAL / 1e3}s, ${WATCHDOG_FAILS} misses -> restart)`
      );
      void watchBridge();
    } else {
      console.log("[voice-bridge] watchdog off (VOICE_BRIDGE_WATCHDOG=0)");
    }
  })();
}
export {
  apply
};
