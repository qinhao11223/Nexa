import type { CreativeLibraryMode } from './types'

// 创意库 -> 生图页 的“链接提示词”桥接
// 说明：由于生图/创意库在不同模式页面之间切换，这里用 localStorage 做一次性消息传递

export type PendingPromptLink = {
  // 目标页面（文字生图 / 图像改图）
  mode: CreativeLibraryMode
  // 写入到哪个输入框
  target: 'prompt' | 'optimize_custom'
  // 需要写入的文本
  text: string
}

const KEY = 'nexa-prompt-link-pending:v1'

export function setPendingPromptLink(payload: PendingPromptLink) {
  localStorage.setItem(KEY, JSON.stringify(payload))
}

export function takePendingPromptLink(mode: CreativeLibraryMode): PendingPromptLink | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingPromptLink
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.mode !== mode) return null
    if (parsed.target !== 'prompt' && parsed.target !== 'optimize_custom') return null
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null
    localStorage.removeItem(KEY)
    return parsed
  } catch {
    return null
  }
}
