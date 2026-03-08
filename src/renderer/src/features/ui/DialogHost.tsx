import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useDialogStore } from './dialogStore'
import { uiToast } from './toastStore'

export default function DialogHost() {
  const dialog = useDialogStore(s => s.dialog)
  const closeWith = useDialogStore(s => s.closeWith)

  const [promptValue, setPromptValue] = useState('')
  const [textEditValue, setTextEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!dialog) return
    if (dialog.kind === 'prompt') {
      setPromptValue(String(dialog.initialValue || ''))
      window.setTimeout(() => inputRef.current?.focus(), 0)
      setTextEditValue('')
      return
    }
    if (dialog.kind === 'textEdit') {
      setTextEditValue(String(dialog.text || ''))
      window.setTimeout(() => inputRef.current?.focus(), 0)
      setPromptValue('')
      return
    } else {
      setPromptValue('')
      setTextEditValue('')
    }
  }, [dialog?.id])

  const canCopyText = useMemo(() => {
    if (!dialog) return false
    if (dialog.kind === 'text') return Boolean(String(dialog.text || '').trim())
    if (dialog.kind === 'textEdit') return Boolean(String(textEditValue || '').trim())
    return false
  }, [dialog, textEditValue])

  if (!dialog) return null

  const onBackdrop = () => {
    if (dialog.kind === 'confirm') closeWith(false)
    else if (dialog.kind === 'prompt') closeWith(null)
    else if (dialog.kind === 'textEdit') closeWith(null)
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
    if (dialog.kind === 'textEdit') {
      closeWith(String(textEditValue || ''))
      return
    }
    closeWith(undefined)
  }

  const onCancel = () => {
    if (dialog.kind === 'confirm') closeWith(false)
    else if (dialog.kind === 'prompt') closeWith(null)
    else if (dialog.kind === 'textEdit') closeWith(null)
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
      // 仅对单步确认类对话框做 Enter=OK；多行编辑/查看不要拦截 Enter
      if (dialog.kind === 'confirm' || dialog.kind === 'alert') {
        e.preventDefault()
        e.stopPropagation()
        onOk()
        return
      }
      if (dialog.kind === 'prompt') {
        e.preventDefault()
        e.stopPropagation()
        onOk()
        return
      }
    }
  }

  const title = dialog.title || 'Nexa'
  const okText = dialog.okText || (dialog.kind === 'text' ? '关闭' : dialog.kind === 'textEdit' ? '应用' : '确定')
  const cancelText = dialog.cancelText || '取消'

  return (
    <div className="nx-dialog-wrap" role="presentation">
      <div className="nx-dialog-backdrop" onMouseDown={onBackdrop} />
      <div className={`nx-dialog ${dialog.size === 'lg' ? 'lg' : ''}`} role="dialog" aria-modal="true" onKeyDown={handleKeyDown}>
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

          {dialog.kind === 'textEdit' && (
            <textarea
              ref={inputRef as any}
              className="nx-dialog-text"
              value={textEditValue}
              onChange={(e) => setTextEditValue(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        <div className="nx-dialog-actions">
          {dialog.kind === 'confirm' || dialog.kind === 'prompt' || dialog.kind === 'textEdit' ? (
            <button type="button" className="nx-btn ghost" onClick={onCancel}>{cancelText}</button>
          ) : null}

          {canCopyText ? (
            <button
              type="button"
              className="nx-btn ghost"
              onClick={async () => {
                const t = dialog.kind === 'textEdit' ? String(textEditValue || '') : String(dialog.text || '')
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
