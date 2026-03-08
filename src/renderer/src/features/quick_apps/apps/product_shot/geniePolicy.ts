import { useEffect, useMemo, useState } from 'react'
import { kvGetJsonMigrate, kvSetJson } from '../../../../core/persist/kvClient'

export type GenieSmallTextPolicy = 'keep_unreadable' | 'try_readable' | 'ignore'
export type GenieBackgroundPolicy = 'solid_lock' | 'allow_ref'

export type GeniePolicy = {
  smallText: GenieSmallTextPolicy
  background: GenieBackgroundPolicy
  solidColor: string
  allowLogoTranscribe: boolean
}

const STORAGE_KEY = 'nexa-qa-product-shot-genie-policy:v1'

export const DEFAULT_GENIE_POLICY: GeniePolicy = {
  smallText: 'keep_unreadable',
  background: 'solid_lock',
  solidColor: '#ededed',
  allowLogoTranscribe: false
}

function sanitizeHexColor(s: any) {
  const raw = String(s || '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw
  return DEFAULT_GENIE_POLICY.solidColor
}

export function sanitizeGeniePolicy(p: any): GeniePolicy {
  const smallText = (String(p?.smallText || '') as GenieSmallTextPolicy)
  const background = (String(p?.background || '') as GenieBackgroundPolicy)

  return {
    smallText: (smallText === 'try_readable' || smallText === 'ignore' || smallText === 'keep_unreadable') ? smallText : DEFAULT_GENIE_POLICY.smallText,
    background: (background === 'allow_ref' || background === 'solid_lock') ? background : DEFAULT_GENIE_POLICY.background,
    solidColor: sanitizeHexColor(p?.solidColor),
    allowLogoTranscribe: Boolean(p?.allowLogoTranscribe)
  }
}

export function buildGeniePolicyPreviewText(policy: GeniePolicy) {
  const p = sanitizeGeniePolicy(policy)
  const bg = p.background === 'solid_lock'
    ? `背景策略：当用户要求“纯色背景锁定”时，场景/背景参考图仅用于光影/构图氛围，禁止继承背景元素；默认纯色建议 ${p.solidColor}。`
    : `背景策略：允许参考图决定背景，但仍需避免出现与产品无关的复杂道具/文字干扰；默认纯色建议 ${p.solidColor}。`

  const small = p.smallText === 'keep_unreadable'
    ? '小吊牌/极小字：保留存在但不可读；禁止猜测字母；禁止生成清晰可读的标准英文单词。'
    : p.smallText === 'try_readable'
      ? '小吊牌/极小字：尽量贴近参考图复刻；若无法精确复刻，宁可不可读也不要编造新字母/单词。'
      : '小吊牌/极小字：允许弱化/忽略；禁止生成清晰可读的标准英文单词或编造字母内容。'

  const logo = p.allowLogoTranscribe
    ? '主Logo/大字：在“字母非常清晰且用户明确要求可读”时允许转写，但必须与参考图一致；否则不要逐字转写。'
    : '主Logo/大字：强调复刻形态/位置/工艺，默认不逐字转写。'

  return [bg, small, logo].join('\n')
}

export function useGeniePolicy() {
  const [hydrated, setHydrated] = useState(false)
  const [policy, setPolicy] = useState<GeniePolicy>(DEFAULT_GENIE_POLICY)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const parsed = await kvGetJsonMigrate<any>(STORAGE_KEY, null)
        if (!alive) return
        if (parsed && typeof parsed === 'object') {
          setPolicy(sanitizeGeniePolicy(parsed))
        }
      } catch {
        // ignore
      } finally {
        if (alive) setHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const t = window.setTimeout(() => {
      void kvSetJson(STORAGE_KEY, sanitizeGeniePolicy(policy))
    }, 320)
    return () => window.clearTimeout(t)
  }, [hydrated, policy])

  const previewText = useMemo(() => buildGeniePolicyPreviewText(policy), [policy])

  return {
    hydrated,
    policy,
    setPolicy,
    resetPolicy: () => setPolicy(DEFAULT_GENIE_POLICY),
    previewText
  }
}
