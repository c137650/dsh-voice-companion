/**
 * ReplySpeakerMount: hidden per-session component (renders null) that streams
 * assistant text to TTS sentence-by-sentence — mirroring the original
 * backend's LMOutputProcessor (per-sentence chunks) so long replies start
 * speaking while the rest are still being synthesized.
 *
 * Each assistant chat node's text is split into complete sentences; as new
 * complete sentences appear (the node streams via `assistant/chunk`
 * publications), they are fetched from the bridge /api/tts through a serial
 * chain and played back in order through the shared ReplySpeaker's FIFO
 * queue. The trailing partial sentence is not spoken until it completes.
 *
 * History replay protection: nodes are seeded on first sight (their current
 * complete sentences are marked spoken), so existing/old content never
 * replays. Barge-in (mic start) swallows the rest of the current reply.
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap merge for PropsRuntime resolution.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-chat's `useChat` into SessionStandardProps (0.1.3).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AssistantChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import { tts, dhSpeak, dhStatus, dhDiscard, DH_CHANGE_EVENT } from '../bridge.ts'
import { readDigitalHuman } from '../DigitalHumanToggle.tsx'
import type { VoiceInjected } from '../contract.ts'
import { cleanReplyText } from './clean.ts'
import { splitSentences } from './sentences.ts'
import { chatNodes } from './chat-nodes.ts'

const VOICE_ENABLED_KEY = 's2s.voice.enabled'

function voiceEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

/** Companion window visibility (digital-human video only matters when it shows). */
function companionVisible(): boolean {
  try {
    return localStorage.getItem('s2s.voice.companion') !== '0'
  } catch {
    return true
  }
}

/** Read the assistant row payload off a chat view node (kind `assistant-step`). */
function assistantData(node: { kind: string; data: unknown }): AssistantChatData | undefined {
  if (node.kind !== 'assistant-step') return undefined
  return node.data as AssistantChatData
}

/** Join the node's text blocks (reasoning/tool-call/image excluded). */
function nodeText(data: AssistantChatData): string {
  return data.blocks
    .filter(block => block.kind === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Full props: framework runtime share + `voice` locale seat + injected face. */
export type ReplySpeakerMountProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'> & VoiceInjected

/**
 * @param props - framework runtime + locale + injected speaker/abort face.
 */
export const ReplySpeakerMount = memo(function ReplySpeakerMount({
  useSession,
  useChat,
  speaker,
  claimSpeaker,
  _registerTtsAbort,
  _registerInterruptHandler,
}: ReplySpeakerMountProps) {
  // 0.1.3: chat nodes live on the `useChat` view snapshot (subscribing to it
  // activates the chat target and materializes the nodes). Read them via the
  // chatNodes helper; the rc.8 `snapshot.chat.nodes` map is gone.
  const chat = useChat((s: never) => s)
  const snapshot = useSession(s => s)

  // Per-node complete sentences already spoken (node.key -> count).
  const spokenRef = useRef(new Map<string, number>())
  // History replay protection: baseline anchor. On mount the conversation
  // snapshot can be EMPTY (session history loads asynchronously after a
  // restart), so a one-shot seed there would miss the history and every old
  // reply would replay. Instead we wait until the first SETTLED assistant
  // node arrives, then set the baseline to the current max anchor — nothing
  // at or below it ever speaks. Live (running) nodes are never used for the
  // baseline, so a fresh reply in a brand-new session still speaks.
  const baselineRef = useRef<number | null>(null)
  // Serial TTS fetch chain: sentence N+1's fetch starts after N's resolves
  // (playback drains independently through the speaker queue — pipelined).
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  // 已排队的最新"对话轮次"（用该轮用户消息的 anchor 表示）：抢占只按轮次
  // 判断，同一轮内的多段输出不会互相打断。
  const lastQueuedTurnRef = useRef<number | null>(null)
  // 已经见过的最大用户消息 anchor：一有新消息就立刻止住旧播报。
  const lastSeenUserAnchorRef = useRef(0)
  const lastUserCountRef = useRef(0)
  // 代际计数：打断/抢占时自增，在途合成回来一律丢弃，避免旧句子被塞回队列。
  const genRef = useRef(0)
  // 中间步骤节点的文本缓存：节点被折叠/移除后仍能把它没念完的句子念完。
  const nodeCacheRef = useRef(new Map<string, { anchor: number; text: string }>())
  // Barge-in: swallow the CURRENT reply only. We record the exact anchor of
  // the reply being interrupted (never a "<= max" line): if the interrupt
  // flag is consumed after a NEW reply already appeared in the snapshot, a
  // range-based skip would swallow that fresh reply too — the "new reply
  // never speaks" bug. Exact-anchor skip lets later replies play normally.
  const interruptRef = useRef(false)
  const skipAnchorRef = useRef(0)
  const skipUntilRef = useRef(0)
  // Digital-human: nodes whose finished reply was already handed to the bridge.
  const dhSentRef = useRef(new Set<string>())
  // Last-segment debounce per user turn: while a turn is still streaming, new
  // settled texts keep replacing the "last" candidate; only once no new text
  // arrives for LAST_DEBOUNCE_MS is the candidate confirmed and submitted.
  // key = user anchor, value = { timer, anchor } (the candidate's anchor).
  const dhLastDebounceRef = useRef(new Map<number, { timer: ReturnType<typeof setTimeout>; anchor: number }>())
  const LAST_DEBOUNCE_MS = 4000
  // 桥接侧数字人开关（null = 尚未确认）。它现在**可以热切**：本地开关一翻，
  // 插件会 POST /api/dh/enable，桥接状态变化后广播 DH_CHANGE_EVENT，这里重新
  // 拉取——所以不能再像以前那样只在挂载时解析一次（关掉就再也回不来）。
  // 确认前既不朗读也不提交视频，避免「同一回复先逐句 TTS、又被生成视频」双重播放。
  const [bridgeDh, setBridgeDh] = useState<boolean | null>(null)
  // Code of the most recently submitted digital-human task (for discard).
  const lastDhCodeRef = useRef<string | null>(null)
  // Anchor of the last DH-submitted reply node; a later user node means the
  // pending video is stale and should be discarded.
  const lastDhReplyAnchorRef = useRef(0)
  // Highest user-node anchor seen (new-turn detection).
  const lastUserAnchorRef = useRef(0)

  // Register the barge-in handler once (the mic calls interruptReply).
  useEffect(() => {
    _registerInterruptHandler(() => {
      interruptRef.current = true
    })
    return () => _registerInterruptHandler(null)
  }, [_registerInterruptHandler])

  // Unmount: stop playback, release any in-flight TTS, clear DH debounce timers.
  useEffect(() => () => {
    speaker.stop()
    _registerTtsAbort(null)
    for (const { timer } of dhLastDebounceRef.current.values()) clearTimeout(timer)
    dhLastDebounceRef.current.clear()
  }, [speaker, _registerTtsAbort])

  // Track the BRIDGE-side digital-human switch (it can change at runtime): poll
  // it on mount, and re-read it whenever the local toggle announces a change
  // (the plugin POSTs /api/dh/enable first, so the bridge is already updated by
  // the time we look). Bridge unreachable -> false, i.e. replies still speak
  // through sentence TTS.
  useEffect(() => {
    let cancelled = false
    const check = (): void => {
      void dhStatus()
        .then((s) => { if (!cancelled) setBridgeDh(s?.enabled === true) })
        .catch(() => { if (!cancelled) setBridgeDh(false) })
    }
    check()
    const onChange = (): void => { window.setTimeout(check, 200) }
    window.addEventListener(DH_CHANGE_EVENT, onChange)
    return () => {
      cancelled = true
      window.removeEventListener(DH_CHANGE_EVENT, onChange)
    }
  }, [])

  // Stream new complete sentences to TTS on every snapshot change. In digital
  // human mode the reply is NOT spoken immediately — its full text goes to the
  // bridge, which renders a lip-synced video (with the TTS audio embedded);
  // the companion window plays video + sound together once it is ready.
  useEffect(() => {
    if (!voiceEnabled()) return

    // 桥接开关尚未确认：先不朗读也不提交视频，等 dhStatus 返回（桥接不可达时
    // 按非 DH 处理，回复仍会 TTS 朗读）。确认后 setBridgeDh 触发重渲染，等待
    // 窗口期到达的回复会按正确的 dhMode 处理。
    if (bridgeDh === null) return
    const dhMode = bridgeDh && companionVisible() && readDigitalHuman()

    // Barge-in swallowed the CURRENT reply: remember its exact anchor so only
    // that reply's remaining sentences are skipped; replies that appear
    // later (or that already appeared) still speak. In DH mode, discard the
    // pending video task (the reply is being talked over).
    if (interruptRef.current) {
      if (dhMode) dhDiscard(lastDhCodeRef.current)
      let maxAnchor = 0
      for (const node of chatNodes(chat)) {
        if (node.kind === 'assistant-step' && node.anchorSeq > maxAnchor) maxAnchor = node.anchorSeq
      }
      if (maxAnchor > 0) skipAnchorRef.current = maxAnchor
      interruptRef.current = false
      return
    }

    // First settled assistant node arrives: freeze the history baseline so
    // pre-existing replies never replay (page load, session revisit, history
    // pagination). Running nodes are live replies — they are NOT used here,
    // so a fresh reply in a new session still speaks.
    if (baselineRef.current === null) {
      let maxAnchor = 0
      let hasSettled = false
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'assistant-step') continue
        const data = assistantData(node)
        if (data === undefined) continue
        if (data.status === 'settled') hasSettled = true
        if (node.anchorSeq > maxAnchor) maxAnchor = node.anchorSeq
      }
      if (hasSettled && maxAnchor > 0) {
        baselineRef.current = maxAnchor
        skipUntilRef.current = maxAnchor
      }
      return
    }

    // 新用户消息一到，立刻停掉正在播的旧回复——不等新回复开始合成。
    // 原来的抢占要等新回复产出第一句才触发，中间那段模型思考时间里旧播报
    // 还在响，听感上就是"我发话了它还在说"。
    const seenUserAnchor = lastSeenUserAnchorRef.current
    let maxUserAnchor = seenUserAnchor
    let userCount = 0
    for (const node of chatNodes(chat)) {
      if (node.kind !== 'user') continue
      userCount += 1
      if (node.anchorSeq > maxUserAnchor) maxUserAnchor = node.anchorSeq
    }
    // 诊断：每次快照变化都留一行，能看出"新用户消息到底有没有被看见"。
    if (maxUserAnchor !== seenUserAnchor || userCount !== lastUserCountRef.current) {
      lastUserCountRef.current = userCount
      console.log('[ui-voice] snapshot:', { users: userCount, maxUserAnchor, seen: seenUserAnchor, speaking: speaker.speaking })
    }
    if (maxUserAnchor > seenUserAnchor) {
      lastSeenUserAnchorRef.current = maxUserAnchor
      if (seenUserAnchor > 0) {
        console.log('[ui-voice] new user message: stopping the old reply, speaking =', speaker.speaking)
        speaker.stop()
        genRef.current += 1
        chainRef.current = Promise.resolve()
      }
    }

    if (dhMode) {
      // New user turn after a DH-submitted reply: the pending video is stale.
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'user') continue
        if (node.anchorSeq <= lastUserAnchorRef.current) continue
        lastUserAnchorRef.current = node.anchorSeq
        if (lastDhReplyAnchorRef.current > 0 && node.anchorSeq > lastDhReplyAnchorRef.current) {
          dhDiscard(lastDhCodeRef.current)
        }
      }
      // Submit settled, fully-streamed replies' full text to the bridge.
      // No sentence TTS here — the video carries the audio; the companion
      // window plays it (TTS + talking-head together) when generation ends.
      // Per USER turn, deliver only the FIRST and the LAST settled assistant
      // texts. A user turn spans one user node to the next; an agent reply
      // (first answer A -> tool call -> final answer B) is ONE user turn, so
      // both A and B are spoken, while every intermediate text — tool-call
      // output, transitional chatter, mid-work updates — never spawns a video.
      // (Pure chat turns have first === last and deliver once.)
      const userAnchors: number[] = []
      for (const node of chatNodes(chat)) {
        if (node.kind === 'user') userAnchors.push(node.anchorSeq)
      }
      userAnchors.sort((a, b) => a - b)
      type TurnPick = { node: { key: string; anchorSeq: number }; data: AssistantChatData; anchor: number }
      const perUserTurn = new Map<number, { first: TurnPick; last: TurnPick }>()
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'assistant-step') continue
        const data = assistantData(node)
        if (data === undefined || data.status !== 'settled') continue
        const text = cleanReplyText(nodeText(data), 100000)
        if (text.trim().length < 2) continue
        // The user turn this reply belongs to = nearest preceding user anchor.
        let ua = -1
        for (const u of userAnchors) {
          if (u < node.anchorSeq) ua = u
          else break
        }
        const pick: TurnPick = { node, data, anchor: node.anchorSeq }
        const slot = perUserTurn.get(ua)
        if (slot === undefined) {
          perUserTurn.set(ua, { first: pick, last: pick })
        } else {
          if (node.anchorSeq < slot.first.anchor) slot.first = pick
          if (node.anchorSeq > slot.last.anchor) slot.last = pick
        }
      }
      const submitDh = (pick: TurnPick): void => {
        const base = baselineRef.current
        if (base !== null && pick.anchor <= base) return
        if (pick.anchor === skipAnchorRef.current) return
        if (dhSentRef.current.has(pick.node.key)) return
        const text = cleanReplyText(nodeText(pick.data), 100000)
        if (text.trim().length < 2) return
        dhSentRef.current.add(pick.node.key)
        lastDhReplyAnchorRef.current = pick.anchor
        void dhSpeak(text).then((code) => {
          if (code !== null) lastDhCodeRef.current = code
        })
      }
      for (const [ua, { first, last }] of perUserTurn) {
        // FIRST segment: submit immediately (it is settled and will not change).
        submitDh(first)
        if (first.node.key === last.node.key) {
          // Pure chat turn (no tool-call churn): first === last, nothing else.
          const existing = dhLastDebounceRef.current.get(ua)
          if (existing !== undefined) {
            clearTimeout(existing.timer)
            dhLastDebounceRef.current.delete(ua)
          }
          continue
        }
        // LAST segment: debounce — replace the candidate (reset the timer) on
        // every new settled text so an intermediate text never gets submitted;
        // only a 4s-quiet turn submits its final segment.
        const existing = dhLastDebounceRef.current.get(ua)
        if (existing !== undefined) clearTimeout(existing.timer)
        const timer = setTimeout(() => {
          dhLastDebounceRef.current.delete(ua)
          submitDh(last)
        }, LAST_DEBOUNCE_MS)
        dhLastDebounceRef.current.set(ua, { timer, anchor: last.anchor })
      }
      return
    }

    // Non-DH mode: collect the complete sentences that are new (beyond each
    // node's spoken count), in (anchor, index) order. A SETTLED node also
    // flushes its trailing partial (the reply ended without a terminal
    // punctuation, like a credit line); running nodes wait for the partial.
    const jobs: { anchor: number; turn: number; key: string; index: number; sentence: string }[] = []
    const nodes = chatNodes(chat)
    // 每一句所属的"对话轮次"= 它之前最近的用户消息 anchor。抢占只认轮次：
    // 同一轮里若有多个 assistant 节点（工具调用、分段输出），它们各自的
    // anchor 不同，按 anchor 抢占会把上一条念到一半掐掉。
    const userAnchors = nodes.filter(n => n.kind === 'user').map(n => n.anchorSeq).sort((a, b) => a - b)
    const turnOf = (anchor: number): number => {
      let turn = 0
      for (const ua of userAnchors) {
        if (ua < anchor) turn = ua
        else break
      }
      return turn
    }
    for (const node of nodes) {
      if (node.kind !== 'assistant-step') continue
      // 先把当前可见节点的文本记进缓存：DSH 在最终结果到达时会折叠/移除这些
      // 中间节点，节点一消失，它剩下的句子就再没机会合成，听起来就是"念到
      // 一半没了"。
      const snapshot = assistantData(node)
      if (snapshot !== undefined) {
        nodeCacheRef.current.set(node.key, { anchor: node.anchorSeq, text: nodeText(snapshot) })
      }
      if (node.anchorSeq <= skipUntilRef.current) continue
      if (node.anchorSeq === skipAnchorRef.current) continue
      const data = assistantData(node)
      if (data === undefined || data.status === 'interrupted') continue
      const { sentences, partial } = splitSentences(cleanReplyText(nodeText(data), 100000))
      const speakable = data.status === 'settled' && partial !== null
        ? [...sentences, partial]
        : sentences
      const spoken = spokenRef.current.get(node.key) ?? 0
      if (speakable.length > spoken) {
        for (let i = spoken; i < speakable.length; i++) {
          jobs.push({
            anchor: node.anchorSeq,
            turn: turnOf(node.anchorSeq),
            key: node.key,
            index: i,
            sentence: speakable[i]!,
          })
        }
        spokenRef.current.set(node.key, speakable.length)
      }
    }

    // 已从快照里消失的节点：从缓存补念它剩下的句子（当成已定型，尾句也念）。
    const visibleKeys = new Set(nodes.filter(n => n.kind === 'assistant-step').map(n => n.key))
    for (const [key, cached] of [...nodeCacheRef.current]) {
      if (visibleKeys.has(key)) continue
      if (cached.anchor <= skipUntilRef.current || cached.anchor === skipAnchorRef.current) {
        nodeCacheRef.current.delete(key)
        continue
      }
      const { sentences, partial } = splitSentences(cleanReplyText(cached.text, 100000))
      const speakable = partial !== null ? [...sentences, partial] : sentences
      const spoken = spokenRef.current.get(key) ?? 0
      if (speakable.length > spoken) {
        for (let i = spoken; i < speakable.length; i++) {
          jobs.push({
            anchor: cached.anchor,
            turn: turnOf(cached.anchor),
            key,
            index: i,
            sentence: speakable[i]!,
          })
        }
        spokenRef.current.set(key, speakable.length)
        console.log('[ui-voice] collapsed node: finishing its remaining sentences')
      }
      nodeCacheRef.current.delete(key)
    }
    if (jobs.length === 0) return
    jobs.sort((a, b) => (a.anchor - b.anchor) || (a.index - b.index))

    // 新消息抢占：只有"更新的对话轮次"到来才打断当前播放并清空队列，从新
    // 回复的第一句开始。同一轮内的后续句子一律排队，不打断。
    const newestTurn = jobs[jobs.length - 1]!.turn
    if (lastQueuedTurnRef.current !== null && newestTurn > lastQueuedTurnRef.current) {
      console.log('[ui-voice] preempt: newer turn, restarting from its first sentence')
      speaker.stop()
      chainRef.current = Promise.resolve()
    }
    if (newestTurn > (lastQueuedTurnRef.current ?? -1)) lastQueuedTurnRef.current = newestTurn

    // Chain the fetches serially (order preserved; playback pipelines via the
    // speaker queue). Each step re-checks voice/interrupt so an abort stops
    // the rest of the chain.
    chainRef.current = jobs.reduce(
      (chain, job) => chain.then(() => {
        if (interruptRef.current || !voiceEnabled()) return
        const generation = genRef.current
        const controller = new AbortController()
        _registerTtsAbort(controller)
        return tts(job.sentence, controller.signal)
          .then((wav) => {
            if (interruptRef.current || !voiceEnabled()) return
            // 期间发生过打断/抢占：这句虽然合成完了，但已经过时，丢弃。
            if (generation !== genRef.current) return
            // 本会话要出声了：喇叭若还归别的会话，先把它停掉再播。
            claimSpeaker()
            speaker.speak(wav)
          })
          .catch((err) => {
            if ((err as Error | undefined)?.name !== 'AbortError') {
              console.error('[ui-voice] reply TTS failed:', err)
            }
          })
          .finally(() => _registerTtsAbort(null))
      }),
      chainRef.current,
    )
  }, [chat, speaker, _registerTtsAbort, bridgeDh])

  return null
})
