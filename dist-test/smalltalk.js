// src/client/voice/smalltalk.ts
var SMALL_TALK_LINES = ["\u5728\u5417\uFF1F", "\u6211\u6765\u4E86\u3002", "\u8FD8\u5728\u5417\uFF1F"];
var CALLBACK_MAX_CHARS = 10;
var CLAUSE_MAX_CHARS = 16;
var CLAUSE_MIN_COVERAGE = 0.6;
var SPEAKABLE = /[^一-鿿A-Za-z0-9 \u00b0.\u0000]/g;
var DOT_BETWEEN_DIGITS = /(\d)\.(\d)/g;
function stripUnspoken(text) {
  const protectedText = text.replace(DOT_BETWEEN_DIGITS, "$1\0$2");
  return protectedText.replace(SPEAKABLE, "").replace(/\s+/g, " ").replace(/\u0000/g, ".").trim();
}
function splitClauses(text) {
  const clauses = [];
  let buf = "";
  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed !== "") clauses.push(trimmed);
    buf = "";
  };
  for (const ch of text) {
    if (ch === "\uFF0C" || ch === "," || ch === "\u3002" || ch === "\uFF01" || ch === "\uFF1F" || ch === "!" || ch === "?") {
      flush();
      continue;
    }
    buf += ch;
  }
  const partial = buf.trim();
  return { clauses, partial: partial === "" ? null : partial };
}
var CUT_BOUNDARY = /[—\- 、·]/u;
var TAIL_PARTICLE = /[的了吗呢吧啊哦嘛着]$/u;
function clauseToSpeak(clause, force = false) {
  const clean = stripUnspoken(clause);
  if (clean === "") return null;
  if (clean.length <= CLAUSE_MAX_CHARS) return clean;
  const head = clean.slice(0, CLAUSE_MAX_CHARS);
  const coverage = CLAUSE_MAX_CHARS / clean.length;
  if (coverage < CLAUSE_MIN_COVERAGE && !force) return null;
  const boundary = Math.max(
    ...[...head].map((_, index) => index).filter((index) => CUT_BOUNDARY.test(head[index] ?? ""))
  );
  if (boundary >= Math.floor(CLAUSE_MAX_CHARS / 2)) return head.slice(0, boundary + 1).trim();
  if (TAIL_PARTICLE.test(head)) return head.trim();
  return head;
}
function pickOpeningPhrase(phrases, force = false, limit = CLAUSE_MAX_CHARS) {
  const cleaned = [];
  for (const phrase of phrases) {
    const clean = stripUnspoken(phrase);
    if (clean !== "") cleaned.push(clean);
  }
  if (cleaned.length === 0) return null;
  let opening = "";
  for (const phrase of cleaned) {
    const candidate = opening === "" ? phrase : `${opening}\uFF0C${phrase}`;
    if (candidate.length <= limit) {
      opening = candidate;
      continue;
    }
    if (opening === "" && phrase.length <= limit * 2) return phrase;
    const room = limit - (opening === "" ? 0 : opening.length + 1);
    if (room <= 0) break;
    if (room / phrase.length >= CLAUSE_MIN_COVERAGE) {
      opening = opening === "" ? phrase.slice(0, room) : `${opening}\uFF0C${phrase.slice(0, room)}`;
    }
    break;
  }
  if (opening === "") {
    if (!force) return null;
    return cleaned[0].slice(0, limit);
  }
  return opening;
}
function pickClauses(reply) {
  const { clauses, partial } = splitClauses(reply);
  const all = partial === null ? clauses : [...clauses, partial];
  const picked = [];
  for (const clause of all) {
    const speak = clauseToSpeak(clause);
    if (speak !== null) picked.push(speak);
  }
  if (picked.length === 0 && all.length > 0) {
    const first = clauseToSpeak(all[0], true);
    if (first !== null) picked.push(first);
  }
  return picked;
}
function compressToLine(text, max = CALLBACK_MAX_CHARS) {
  const clean = stripUnspoken(text);
  if (clean === "") return "";
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const boundary = head.lastIndexOf(" ");
  if (boundary >= Math.floor(max / 2)) return head.slice(0, boundary).trim();
  return head;
}
function pickSmallTalkLine() {
  const index = Math.floor(Math.random() * SMALL_TALK_LINES.length);
  return SMALL_TALK_LINES[index] ?? SMALL_TALK_LINES[0];
}
var CALLBACK_INSTRUCTION = "\uFF08\u628A\u4E0A\u9762\u8FD9\u6BB5\u5185\u5BB9\u539F\u5C01\u4E0D\u52A8\u5730\u4F5C\u4E3A\u7D20\u6750\uFF0C\u7528\u53E3\u8BED\u8BF4\u4E00\u53E5\u5341\u516D\u4E2A\u5B57\u4EE5\u5185\u7684\u8BDD\uFF0C\u50CF\u5728\u8DDF\u4EBA\u5F53\u9762\u8BF4\u8BDD\uFF0C\u4E0D\u8981\u50CF\u6807\u9898\u3001\u4E0D\u8981\u50CF\u6458\u8981\u3001\u4E0D\u8981\u7528\u4E66\u9762\u8BED\uFF0C\u53EA\u8F93\u51FA\u8FD9\u4E00\u53E5\u8BDD\uFF0C\u4E0D\u8981\u89E3\u91CA\uFF0C\u4E0D\u8981\u52A0\u5F15\u53F7\u3002\uFF09";
function buildSmallTalkLine(previousAnswer) {
  const material = (previousAnswer ?? "").trim();
  if (material === "") return pickSmallTalkLine();
  return `${material}

${CALLBACK_INSTRUCTION}`;
}
var armed = false;
var armedAt = 0;
var ARMED_TTL_MS = 45e3;
function armSmallTalk() {
  armed = true;
  armedAt = Date.now();
}
function isSmallTalkArmed() {
  if (!armed) return false;
  if (Date.now() - armedAt > ARMED_TTL_MS) {
    armed = false;
    return false;
  }
  return true;
}
function disarmSmallTalk() {
  armed = false;
}
var pendingClips = null;
var pendingAt = 0;
function setPendingSmallTalkAudio(clips) {
  pendingClips = clips;
  pendingAt = Date.now();
}
function takePendingSmallTalkAudio(maxAgeMs = 12e4) {
  if (pendingClips === null) return null;
  const clips = pendingClips;
  pendingClips = null;
  if (Date.now() - pendingAt > maxAgeMs) return null;
  return clips;
}
function clearPendingSmallTalkAudio() {
  pendingClips = null;
}
var audioUntil = 0;
function noteSmallTalkAudioQueued(clips) {
  let ms = 0;
  for (const clip of clips) ms += wavDurationMs(clip);
  if (ms <= 0) ms = 1500;
  audioUntil = Date.now() + Math.min(6e4, ms) + 400;
}
function wavDurationMs(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44) return 0;
    const byteRate = view.getUint32(28, true);
    const dataBytes = view.getUint32(40, true);
    if (byteRate <= 0) return 0;
    return Math.round(dataBytes / byteRate * 1e3);
  } catch {
    return 0;
  }
}
function smallTalkAudioPlaying() {
  return Date.now() < audioUntil;
}
var sentLines = /* @__PURE__ */ new Set();
var sentPrefixes = /* @__PURE__ */ new Set();
var OPENER_PREFIX = 24;
function squash(text) {
  return text.replace(/\s+/g, "").trim();
}
function rememberSmallTalkLine(line) {
  const key = line.trim();
  if (key === "") return;
  sentLines.add(key);
  const prefix = squash(key).slice(0, OPENER_PREFIX);
  if (prefix.length >= 4) sentPrefixes.add(prefix);
}
function isSmallTalkLine(text) {
  const key = text.trim();
  if (sentLines.has(key)) return true;
  if (sentPrefixes.size === 0) return false;
  const squashed = squash(key);
  if (squashed === "") return false;
  for (const prefix of sentPrefixes) {
    if (squashed.startsWith(prefix)) return true;
  }
  return false;
}
var replyTexts = /* @__PURE__ */ new Set();
function rememberSmallTalkReplyText(text) {
  const key = text.trim();
  if (key !== "") replyTexts.add(key);
}
function isSmallTalkReplyText(text) {
  return replyTexts.has(text.trim());
}
export {
  CALLBACK_MAX_CHARS,
  CLAUSE_MAX_CHARS,
  CLAUSE_MIN_COVERAGE,
  SMALL_TALK_LINES,
  armSmallTalk,
  buildSmallTalkLine,
  clauseToSpeak,
  clearPendingSmallTalkAudio,
  compressToLine,
  disarmSmallTalk,
  isSmallTalkArmed,
  isSmallTalkLine,
  isSmallTalkReplyText,
  noteSmallTalkAudioQueued,
  pickClauses,
  pickOpeningPhrase,
  pickSmallTalkLine,
  rememberSmallTalkLine,
  rememberSmallTalkReplyText,
  setPendingSmallTalkAudio,
  smallTalkAudioPlaying,
  splitClauses,
  stripUnspoken,
  takePendingSmallTalkAudio
};
