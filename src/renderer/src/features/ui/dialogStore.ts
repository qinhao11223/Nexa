import { create } from 'zustand'

export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'text' | 'textEdit'

export type DialogModel = {
  id: string
  kind: DialogKind
  title: string
  message?: string
  okText?: string
  cancelText?: string

  // layout
  size?: 'md' | 'lg'

  // prompt
  placeholder?: string
  initialValue?: string

  // text viewer
  text?: string

  // internal
  _resolve: (value: any) => void
}

type DialogState = {
  dialog: DialogModel | null
  openAlert: (opts: { title?: string, message: string, okText?: string }) => Promise<void>
  openConfirm: (opts: { title?: string, message: string, okText?: string, cancelText?: string }) => Promise<boolean>
  openPrompt: (opts: { title?: string, message: string, placeholder?: string, initialValue?: string, okText?: string, cancelText?: string }) => Promise<string | null>
  openText: (opts: { title?: string, message?: string, text: string, okText?: string, size?: 'md' | 'lg' }) => Promise<void>
  openTextEdit: (opts: { title?: string, message?: string, text: string, okText?: string, cancelText?: string, size?: 'md' | 'lg' }) => Promise<string | null>
  closeWith: (value: any) => void
}

function resolveExistingDialog(cur: DialogModel) {
  try {
    if (cur.kind === 'confirm') cur._resolve(false)
    else if (cur.kind === 'prompt') cur._resolve(null)
    else if (cur.kind === 'textEdit') cur._resolve(null)
    else cur._resolve(undefined)
  } catch {
    // ignore
  }
}

function makeId() {
  return `dlg_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export const useDialogStore = create<DialogState>((set, get) => ({
  dialog: null,

  openAlert: (opts) => {
    const title = (opts.title || 'Nexa').trim() || 'Nexa'
    const message = String(opts.message || '')
    const okText = String(opts.okText || '确定')
    return new Promise<void>((resolve) => {
      // 若已有 dialog，先关闭它（按 cancel/默认值）
      const cur = get().dialog
      if (cur) {
        resolveExistingDialog(cur)
      }
      set({
        dialog: {
          id: makeId(),
          kind: 'alert',
          title,
          message,
          okText,
          _resolve: resolve
        }
      })
    })
  },

  openConfirm: (opts) => {
    const title = (opts.title || 'Nexa').trim() || 'Nexa'
    const message = String(opts.message || '')
    const okText = String(opts.okText || '确定')
    const cancelText = String(opts.cancelText || '取消')
    return new Promise<boolean>((resolve) => {
      const cur = get().dialog
      if (cur) {
        resolveExistingDialog(cur)
      }
      set({
        dialog: {
          id: makeId(),
          kind: 'confirm',
          title,
          message,
          okText,
          cancelText,
          _resolve: resolve
        }
      })
    })
  },

  openPrompt: (opts) => {
    const title = (opts.title || 'Nexa').trim() || 'Nexa'
    const message = String(opts.message || '')
    const okText = String(opts.okText || '确定')
    const cancelText = String(opts.cancelText || '取消')
    const placeholder = String(opts.placeholder || '')
    const initialValue = String(opts.initialValue || '')
    return new Promise<string | null>((resolve) => {
      const cur = get().dialog
      if (cur) {
        resolveExistingDialog(cur)
      }
      set({
        dialog: {
          id: makeId(),
          kind: 'prompt',
          title,
          message,
          okText,
          cancelText,
          placeholder,
          initialValue,
          _resolve: resolve
        }
      })
    })
  },

  openText: (opts) => {
    const title = (opts.title || 'Nexa').trim() || 'Nexa'
    const message = opts.message ? String(opts.message) : ''
    const okText = String(opts.okText || '关闭')
    const text = String(opts.text || '')
    const size = opts.size === 'lg' ? 'lg' : 'md'
    return new Promise<void>((resolve) => {
      const cur = get().dialog
      if (cur) {
        resolveExistingDialog(cur)
      }
      set({
        dialog: {
          id: makeId(),
          kind: 'text',
          title,
          message,
          okText,
          text,
          size,
          _resolve: resolve
        }
      })
    })
  },

  openTextEdit: (opts) => {
    const title = (opts.title || 'Nexa').trim() || 'Nexa'
    const message = opts.message ? String(opts.message) : ''
    const okText = String(opts.okText || '应用')
    const cancelText = String(opts.cancelText || '取消')
    const text = String(opts.text || '')
    const size = opts.size === 'lg' ? 'lg' : 'md'
    return new Promise<string | null>((resolve) => {
      const cur = get().dialog
      if (cur) resolveExistingDialog(cur)
      set({
        dialog: {
          id: makeId(),
          kind: 'textEdit',
          title,
          message,
          okText,
          cancelText,
          text,
          size,
          _resolve: resolve
        }
      })
    })
  },

  closeWith: (value) => {
    const d = get().dialog
    if (!d) return
    try {
      d._resolve(value)
    } finally {
      set({ dialog: null })
    }
  }
}))

// Non-hook helpers (usable anywhere)
export function uiAlert(message: string, title?: string) {
  return useDialogStore.getState().openAlert({ title, message })
}

export function uiConfirm(message: string, title?: string) {
  return useDialogStore.getState().openConfirm({ title, message })
}

export function uiPrompt(message: string, opts?: { title?: string, placeholder?: string, initialValue?: string }) {
  return useDialogStore.getState().openPrompt({
    title: opts?.title,
    message,
    placeholder: opts?.placeholder,
    initialValue: opts?.initialValue
  })
}

export function uiTextViewer(text: string, opts?: { title?: string, message?: string, size?: 'md' | 'lg' }) {
  return useDialogStore.getState().openText({ title: opts?.title, message: opts?.message, text, size: opts?.size })
}

export function uiTextEditor(text: string, opts?: { title?: string, message?: string, okText?: string, cancelText?: string, size?: 'md' | 'lg' }) {
  return useDialogStore.getState().openTextEdit({
    title: opts?.title,
    message: opts?.message,
    okText: opts?.okText,
    cancelText: opts?.cancelText,
    text,
    size: opts?.size
  })
}
