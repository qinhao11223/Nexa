import React, { useEffect, useState } from 'react'
import { SlidersHorizontal, RotateCcw } from 'lucide-react'
import { kvGetJsonMigrate, kvSetJson } from '../../../core/persist/kvClient'

// 优化偏好编辑器：用户输入“优化偏好提示词”
// 工作流：用户输入 Prompt + 优化偏好 -> 点击“优化” -> 调用优化模型生成“优化后的 Prompt” -> 点击“开始”用优化后的 Prompt 生图
// 注意：该配置会按 providerId 持久化到 localStorage，方便多 API 网站分别维护

type PersistedState = {
  customText: string
}

function storageKey(providerId: string) {
  return `nexa-optimize-system:v1:${providerId}`
}

function lastKey(scopeKey: string) {
  return `nexa-optimize-last:v1:${scopeKey}`
}

export default function OptimizeSystemPromptEditor(props: {
  providerId: string | null
  // 用于区分 t2i / i2i：让“上次使用的优化偏好”各自记忆
  scopeKey: string
  // 将“优化偏好”回传给父组件（用于请求时拼入 user message）
  onPreferenceChange: (preference: string) => void
  // 外部一次性注入：用于从创意库写入“优化偏好”
  injectCustomText?: string
  onInjectedCustomTextConsumed?: () => void
}) {
  const { providerId, scopeKey, onPreferenceChange, injectCustomText, onInjectedCustomTextConsumed } = props

  const [customText, setCustomText] = useState('')

  // 接收外部注入的“优化偏好”文本（一次性）
  useEffect(() => {
    const injected = (injectCustomText || '').trim()
    if (!injected) return
    setCustomText(injected)
    onInjectedCustomTextConsumed && onInjectedCustomTextConsumed()
  }, [injectCustomText, onInjectedCustomTextConsumed])

  // provider 切换时读取持久化配置
  useEffect(() => {
    let alive = true
    ;(async () => {
      // 先尝试按 providerId 读取；若没有，则回退到“上次使用”
      try {
        if (!providerId) {
          const lastParsed = await kvGetJsonMigrate<PersistedState | null>(lastKey(scopeKey), null)
          if (!alive) return
          if (lastParsed && typeof lastParsed.customText === 'string') setCustomText(lastParsed.customText)
          return
        }

        const parsed = await kvGetJsonMigrate<PersistedState | null>(storageKey(providerId), null)
        if (!alive) return
        if (parsed && typeof parsed.customText === 'string') {
          setCustomText(parsed.customText)
          return
        }

        const lastParsed = await kvGetJsonMigrate<PersistedState | null>(lastKey(scopeKey), null)
        if (!alive) return
        if (lastParsed && typeof lastParsed.customText === 'string') setCustomText(lastParsed.customText)
      } catch {
        // ignore
      }
    })()
    return () => {
      alive = false
    }
  }, [providerId, scopeKey])

  // 推送到父组件（用于实际请求）
  useEffect(() => {
    onPreferenceChange(customText)
  }, [customText, onPreferenceChange])

  // 持久化
  useEffect(() => {
    const state: PersistedState = { customText }
    const t = window.setTimeout(() => {
      void kvSetJson(lastKey(scopeKey), state)
      if (providerId) {
        void kvSetJson(storageKey(providerId), state)
      }
    }, 320)
    return () => window.clearTimeout(t)
  }, [providerId, customText, scopeKey])

  const handleReset = () => {
    // “默认/恢复”：恢复上次使用的优化偏好（更符合桌面心智：不意外清空）
    void (async () => {
      const parsed = await kvGetJsonMigrate<PersistedState | null>(lastKey(scopeKey), null)
      if (parsed && typeof parsed.customText === 'string') {
        setCustomText(parsed.customText)
        return
      }
      setCustomText('')
    })()
  }

  const disabled = !providerId

  return (
    <div className="ig-panel-block">
      <div className="ig-block-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SlidersHorizontal size={16} color="#00e5ff" />
          <span>优化偏好</span>
        </div>
        <button
          type="button"
          className="ig-ghost-btn"
          onClick={handleReset}
          disabled={disabled}
          title="恢复上次使用"
        >
          <RotateCcw size={14} />
          上次
        </button>
      </div>

      {/* 去除预设按钮组：避免与右侧“创意库模板”功能重复；保留自定义偏好输入框 */}

      <textarea
        className="ig-system-input"
        placeholder={disabled ? '请先在设置中选择 API 网站' : '补充你想要的优化偏好（例如：更梦幻、更强对比、偏电影感、强调细节、避免文字水印...）'}
        value={customText}
        onChange={(e) => setCustomText(e.target.value)}
        disabled={disabled}
      />
    </div>
  )
}
