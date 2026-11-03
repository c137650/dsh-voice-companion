import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
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
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
function apply() {
  if (process.platform !== "win32") return;
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
