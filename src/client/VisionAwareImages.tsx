/**
 * VisionAwareImages: 用户消息里的图片槽位。
 *
 * 这个组件**接管**宿主的 `conversation.chat.user.images` 槽位：它拿到的是
 * 附件引用（带 `attachmentId`），因此能分辨出哪些图是本插件发的摄像头画面
 * （附件 id = 字节的 sha256，见 vision-ids.ts）。
 *
 * 画面默认收起来 —— 只留一个「📷 画面 · 点击查看」的小按钮，点一下就地展开；
 * 工具栏上的「画面」芯片可以全显。其它图片（用户自己上传的截图、附件）
 * 一律照常渲染，不受这个开关影响。
 */
import { memo, useEffect, useState } from 'react'
import { isVisionImage } from './voice/vision-ids.ts'
import { markVisionSlotActive, subscribeVisionVisibility, visionHidden } from './vision-visibility.ts'
import type { VoiceKey } from './locales.ts'

/** 槽位组件拿到的松散形状（宿主只给这几个字段，其余是渲染套件）。 */
interface SlotProps {
  images?: Array<{
    attachment?: { attachmentId?: string; name?: string; mediaType?: string }
  }>
  loadImage?: unknown
  align?: string
  compact?: boolean
  t?: (key: VoiceKey) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderFactorySlot?: (name: string, props: unknown) => unknown
}

/**
 * @param props - 槽位传入的图片与渲染套件。
 */
export const VisionAwareImages = memo(function VisionAwareImages(props: SlotProps) {
  // 一旦这个组件真的被渲染，就说明接管成功，不再需要 CSS 兜底。
  markVisionSlotActive()

  const { images, loadImage, align, compact, t, renderFactorySlot } = props
  const [hidden, setHidden] = useState(visionHidden())
  const [expanded, setExpanded] = useState(false)

  useEffect(() => subscribeVisionVisibility(setHidden), [])

  const list = Array.isArray(images) ? images : []
  const allOurs =
    list.length > 0 &&
    list.every((image) => {
      const attachment = image?.attachment
      if (attachment === undefined) return false
      // 首选指纹（附件 id = 字节的 sha256）。
      if (isVisionImage(attachment.attachmentId)) return true
      // 兜底：提示里塞进来的图片没有文件名，用户自己上传的有。
      return attachment.name === undefined && attachment.mediaType === 'image/jpeg'
    })

  // 不是我们的图，或者用户已经展开 / 全显：照常交给官方画廊渲染。
  if (!allOurs || !hidden || expanded) {
    if (typeof renderFactorySlot !== 'function') return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return renderFactorySlot('conversation.images.content', {
      images,
      loadImage,
      align,
      compact,
    }) as any
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      title={t?.('vision.chipHint') ?? '点击查看这一轮带上的画面'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        margin: '2px 0',
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--dsw-alias-label-dimmed, #888)',
        background: 'rgba(127,127,127,0.12)',
        border: '1px solid rgba(127,127,127,0.22)',
        borderRadius: '8px',
        cursor: 'pointer',
      }}
    >
      <span aria-hidden="true">📷</span>
      <span>{t?.('vision.chip') ?? '画面 · 点击查看'}</span>
    </button>
  )
})
