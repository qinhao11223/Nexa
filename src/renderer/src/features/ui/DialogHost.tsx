import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useDialogStore } from './dialogStore'
import { uiToast } from './toastStore'

export default function DialogHost() {
  const dialog = useDialogStore(s => s.dialog)
  const closeWith = useDialogStore(s => s.closeWith)

  const [promptValue, setPromptValue] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!dialog) return
    if (dialog.kind === 'prompt') {
      setPromptValue(String(dialog.initialValue || ''))
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } else {
      setPromptValue('')
    }
  }, [dialog?.id])

  const canCopyText = useMemo(() => {
    return Boolean(dialog && dialog.kind === 'text' && String(dialog.text || '').trim())
  }, [dialog])

  if (!dialog) return null

  const onBackdrop = () => {
    if (dialog.kind === 'confirm') closeWith(false)
    else if (dialog.kind === 'prompt') closeWith(null)
    else closeWith(undefined)
  }

  const onOk = async () => {
    if (dialog.kind === 'confirm') {
      closeWith(true)
      return
    }
    if (dialog.kind === 'prompt') {
      closeWith(promptValue)
      return
    }
    closeWith(undefined)
  }

  const onCancel = () => {
    if (dialog.kind === 'confirm') closeWith(false)
    else if (dialog.kind === 'prompt') closeWith(null)
    else closeWith(undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key === 'Enter') {
      // prompt 支持 Enter 提交（不做多行），其他 dialog Enter=OK
      if (dialog.kind !== 'prompt') {
        e.preventDefault()
        e.stopPropagation()
        onOk()
      }
    }
  }

  const title = dialog.title || 'Nexa'
  const okText = dialog.okText || (dialog.kind === 'text' ? '关闭' : '确定')
  const cancelText = dialog.cancelText || '取消'

  return (
    <div className="nx-dialog-wrap" role="presentation">
      <div className="nx-dialog-backdrop" onMouseDown={onBackdrop} />
      <div className="nx-dialog" role="dialog" aria-modal="true" onKeyDown={handleKeyDown}>
        <div className="nx-dialog-head">
          <div className="nx-dialog-title">{title}</div>
          <button type="button" className="nx-dialog-x" onClick={onCancel} aria-label="关闭">×</button>
        </div>

        <div className="nx-dialog-body">
          {dialog.message ? (
            <div className="nx-dialog-message">{dialog.message}</div>
          ) : null}

          {dialog.kind === 'prompt' && (
            <input
              ref={inputRef as any}
              className="nx-dialog-input"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={dialog.placeholder || ''}
            />
          )}

          {dialog.kind === 'text' && (
            <textarea
              ref={inputRef as any}
              className="nx-dialog-text"
              readOnly
              value={String(dialog.text || '')}
              onFocus={(e) => {
                // 方便用户 Ctrl+A
                try { e.currentTarget.select() } catch { /* ignore */ }
              }}
            />
          )}
        </div>

        <div className="nx-dialog-actions">
          {dialog.kind === 'confirm' || dialog.kind === 'prompt' ? (
            <button type="button" className="nx-btn ghost" onClick={onCancel}>{cancelText}</button>
          ) : null}

          {canCopyText ? (
            <button
              type="button"
              className="nx-btn ghost"
              onClick={async () => {
                const t = String(dialog.text || '')
                try {
                  if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                  await navigator.clipboard.writeText(t)
                  uiToast('success', '已复制到剪贴板')
                } catch {
                  uiToast('error', '复制失败（请手动复制）')
                }
              }}
            >
              复制
            </button>
          ) : null}

          <button type="button" className="nx-btn" onClick={onOk}>{okText}</button>
        </div>
      </div>
    </div>
  )
}
