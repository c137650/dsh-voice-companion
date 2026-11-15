/**
 * dsh 0.1.3 chat-view accessor.
 *
 * rc.8 exposed the chat nodes as a top-level `snapshot.chat.nodes` Map on the
 * session snapshot. dsh 0.1.3 moves the chat view into a `useChat` selector
 * (ui-chat): subscribing to it ACTIVATES the chat target, and the returned
 * ChatSnapshot's `nodes` is a `ChatNodeStore` whose `.values()` returns
 * `readonly ChatConversationViewNode[]` (kind `assistant-step` etc.). This
 * helper reads that shape defensively.
 */
export interface VoiceChatNode {
  kind: string
  key: string
  anchorSeq: number
  data: unknown
}

/** Read the settled chat nodes off a `chat` view snapshot (from `useChat`). */
export function chatNodes(chat: { nodes?: { values?: () => readonly VoiceChatNode[] } } | undefined): readonly VoiceChatNode[] {
  return chat?.nodes?.values?.() ?? []
}

/**
 * Read the text of an assistant node (the visible answer, without reasoning
 * or tool-call blocks).
 *
 * @param node - a chat node of kind `assistant-step`.
 * @returns the text ('' when there is none).
 */
export function assistantNodeText(node: VoiceChatNode): string {
  const data = node.data as
    | { blocks?: Array<{ kind?: string; text?: unknown }> }
    | undefined
  if (data === undefined || data === null) return ''
  if (!Array.isArray(data.blocks)) return ''
  return data.blocks
    .filter((block) => block?.kind === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * Read the text of a user node.
 *
 * The shape moved between dsh versions (a plain `text`, a `content` array, or
 * text blocks), so it is read defensively — callers only need a rough idea of
 * what was said.
 *
 * @param node - a chat node of kind `user`.
 * @returns the text ('' when there is none).
 */
export function userNodeText(node: VoiceChatNode): string {
  const data = node.data as
    | {
        text?: unknown
        content?: unknown
        blocks?: Array<{ kind?: string; text?: unknown }>
      }
    | undefined
  if (data === undefined || data === null) return ''
  if (typeof data.text === 'string') return data.text
  if (typeof data.content === 'string') return data.content
  if (Array.isArray(data.content)) {
    return (data.content as Array<{ type?: string; text?: unknown }>)
      .filter((part) => part !== null && typeof part?.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
  }
  if (Array.isArray(data.blocks)) {
    return data.blocks
      .filter((block) => block !== undefined && block !== null && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
  }
  return ''
}
