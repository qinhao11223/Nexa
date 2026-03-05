import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DndContext, DragEndEvent, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, Folder, Pencil, Sparkles, X } from 'lucide-react'
import { shortText } from '../utils/stacking'
import ContextMenu from './ContextMenu'
import { formatRequestDebugForCopy } from '../utils/requestDebug'
import type { RequestDebug } from '../../../core/api/image'
import { uiAlert, uiConfirm, uiTextViewer } from '../../ui/dialogStore'
import { uiToast } from '../../ui/toastStore'

const CLEAR_SELECTION_EVENT = 'nexa-image-clear-selection-v1'
const PENDING_OPEN_FOLDER_KEY = 'nexa-image-manual-open-folder-v1'

// 手动文件夹：拖拽排序 + 文件夹管理（UI 虚拟分组，本地持久化）
// 说明：
// - 根视图显示“图片卡片 + 文件夹卡片”混排，支持拖拽换位
// - 拖到“文件夹投放区”可把图片放入该文件夹
// - 该逻辑与“自动叠放（按优化偏好聚合）”互不影响：在自动叠放关闭时才使用

export type ManualGridTask = {
  id: string
  status: 'loading' | 'success' | 'error'
  url?: string
  errorMsg?: string
  prompt: string
  ratio?: string
  createdAt?: number
  optimizePreference?: string
  targetSize?: string
  actualSize?: string

  // 调试：用于复制“请求代码”（内部已脱敏 apiKey）
  request?: RequestDebug
}

type RootNodeId = string // 'task:<id>' | 'folder:<id>'
type FolderId = string

type ManualFolder = {
  id: FolderId
  // 用户自定义名称；为空时显示默认名称（优先优化偏好）
  name?: string
  taskIds: string[]
  createdAt: number
}

type ManualLayout = {
  root: RootNodeId[]
  folders: Record<FolderId, ManualFolder>
}

const DEFAULT_STORAGE_KEY = 'nexa-image-manual-layout-v1'

function nodeTaskId(taskId: string): RootNodeId {
  return `task:${taskId}`
}

function nodeFolderId(folderId: string): RootNodeId {
  return `folder:${folderId}`
}

function parseNodeId(id: RootNodeId): { type: 'task' | 'folder', id: string } | null {
  const m = /^(task|folder):(.+)$/.exec(String(id))
  if (!m) return null
  const type = m[1] as 'task' | 'folder'
  return { type, id: m[2] }
}

function loadLayout(storageKey: string): ManualLayout {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return { root: [], folders: {} }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { root: [], folders: {} }
    return {
      root: Array.isArray(parsed.root) ? parsed.root : [],
      folders: parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : {}
    }
  } catch {
    return { root: [], folders: {} }
  }
}

function saveLayout(storageKey: string, layout: ManualLayout) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(layout))
  } catch {
    // 忽略
  }
}

function reconcileLayout(layout: ManualLayout, tasks: ManualGridTask[]): ManualLayout {
  // 目标：
  // 1) 删除不存在的 taskId
  // 2) 删除空文件夹；文件夹剩 1 张时自动解散
  // 3) 未被收录的任务（新生成）自动加入 root 顶部

  const taskIdSet = new Set(tasks.map(t => t.id))

  // 先清理文件夹（允许空文件夹/单图文件夹：用户可先“新建文件夹”再拖入）
  const folders: Record<string, ManualFolder> = {}
  const tasksInFolders = new Set<string>()
  for (const [fid, f] of Object.entries(layout.folders || {})) {
    if (!f || typeof f !== 'object') continue
    const filtered = Array.isArray(f.taskIds) ? f.taskIds.filter(id => taskIdSet.has(id)) : []
    const keep: ManualFolder = {
      // 统一使用 map key 作为 folderId，避免历史数据里 f.id 与 key 不一致导致“打不开/无法操作”
      id: fid,
      name: (typeof (f as any).name === 'string') ? String((f as any).name) : '',
      taskIds: filtered,
      createdAt: typeof f.createdAt === 'number' ? f.createdAt : Date.now()
    }
    folders[fid] = keep
    filtered.forEach(id => tasksInFolders.add(id))
  }

  // 清理 root：去掉已进文件夹的 task、去掉不存在的 node、去掉不存在的 folder
  const root: RootNodeId[] = []
  for (const n of (layout.root || [])) {
    const p = parseNodeId(n)
    if (!p) continue
    if (p.type === 'task') {
      if (!taskIdSet.has(p.id)) continue
      if (tasksInFolders.has(p.id)) continue
      root.push(nodeTaskId(p.id))
      continue
    }
    if (p.type === 'folder') {
      if (!folders[p.id]) continue
      root.push(nodeFolderId(p.id))
    }
  }

  // 把没出现过的新任务加入 root 顶部（保持 tasks 当前顺序：通常新任务在数组前面）
  const tasksInRoot = new Set(
    root
      .map(n => parseNodeId(n))
      .filter(p => !!p && (p as any).type === 'task')
      .map(p => (p as any).id)
  )
  const missing: RootNodeId[] = []
  for (const t of tasks) {
    if (tasksInFolders.has(t.id)) continue
    if (tasksInRoot.has(t.id)) continue
    missing.push(nodeTaskId(t.id))
  }

  const combined = [...missing, ...root]
  // 体验：固定“文件夹区”在最前，避免生成/移动图片导致文件夹左右抖动
  const folderNodes = combined.filter(n => {
    const p = parseNodeId(n)
    return !!p && p.type === 'folder'
  })
  const taskNodes = combined.filter(n => {
    const p = parseNodeId(n)
    return !!p && p.type === 'task'
  })

  return { root: [...folderNodes, ...taskNodes], folders }
}

function isSuccessTask(t: ManualGridTask | undefined | null): boolean {
  return !!(t && t.status === 'success' && t.url)
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
}

function shouldIgnoreKeydown(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = (el.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if ((el as any).isContentEditable) return true
  return false
}

function makeFolderId(): string {
  return `mf_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function FolderDropZone(props: { id: string, active: boolean }) {
  const { id, active } = props
  const { isOver, setNodeRef } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className={`ig-folder-drop ${active ? 'show' : ''} ${isOver ? 'over' : ''}`}
      aria-hidden={!active}
    >
      放入文件夹
    </div>
  )
}

function SortableNode(props: {
  nodeId: RootNodeId
  disabled?: boolean
  children: React.ReactNode
}) {
  const { nodeId, disabled, children } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: nodeId, disabled: Boolean(disabled) })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={isDragging ? 'ig-dnd-dragging' : ''}>
      {children}
    </div>
  )
}

export default function ManualFolderGrid(props: {
  tasks: ManualGridTask[]
  hideNameEnabled: boolean
  refreshToken: number
  onDeleteTask: (id: string) => void
  onOpenPreview: (id: string) => void
  onPatchTask: (id: string, patch: Partial<ManualGridTask>) => void
  onRemakeOne?: (task: ManualGridTask) => void
  canvasTools?: {
    autoStackEnabled: boolean
    hideNameEnabled: boolean
    onToggleAutoStack: () => void
    onToggleHideName: () => void
    onRefresh: () => void
  }

  // 用于分离 t2i/i2i 的手动布局，避免互相影响
  storageKey?: string
  // 可选：仅展示某个文件夹（用于自动叠放模式下打开“自定义文件夹”而不退出自动叠放）
  initialOpenFolderId?: string | null
  lockToFolderId?: string | null
  onExitFolder?: () => void
  showRoot?: boolean
  folderHeaderPrefix?: string
}) {
  const {
    tasks,
    hideNameEnabled,
    refreshToken,
    onDeleteTask,
    onOpenPreview,
    onPatchTask,
    initialOpenFolderId = null,
    lockToFolderId = null,
    onExitFolder,
    showRoot = true,
    folderHeaderPrefix = '文件夹',
    onRemakeOne,
    canvasTools,
    storageKey: storageKeyProp
  } = props

  const storageKey = storageKeyProp || DEFAULT_STORAGE_KEY
  const pendingOpenFolderKey = `${PENDING_OPEN_FOLDER_KEY}:${storageKey}`

  const copyText = async (text: string, okMsg: string) => {
    const t = String(text || '')
    if (!t.trim()) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(t)
      uiToast('success', okMsg)
    } catch {
      // 兜底：Electron/权限限制时，弹出“文本查看器”让用户手动复制
      uiTextViewer(t, { title: okMsg, message: '复制失败，请手动复制：' })
    }
  }

  const tasksMap = useMemo(() => {
    const m = new Map<string, ManualGridTask>()
    for (const t of tasks) m.set(t.id, t)
    return m
  }, [tasks])

  // refresh effect 不应因为 tasks 频繁更新而“闪退文件夹”；用 ref 取最新 tasks
  const tasksRef = useRef(tasks)
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  const [layout, setLayout] = useState<ManualLayout>(() => reconcileLayout(loadLayout(storageKey), tasks))
  const [openFolderId, setOpenFolderId] = useState<string | null>(initialOpenFolderId || lockToFolderId || null)

  // 桌面式选择：框选/多选
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  // 框选状态
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [lasso, setLasso] = useState<{ left: number, top: number, width: number, height: number } | null>(null)
  const lassoStartRef = useRef<{ x: number, y: number } | null>(null)
  const lassoBaseSelectionRef = useRef<Set<string>>(new Set())

  // 兼容：dnd-kit 在部分环境下会影响 React 的 onDoubleClick；这里用 pointerdown 自己识别双击打开文件夹
  const folderDblRef = useRef<{ id: string, t: number, x: number, y: number } | null>(null)

  // 文件夹重命名
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 右键菜单：只做“新建文件夹”
  const [menu, setMenu] = useState<{ open: boolean, x: number, y: number, type: 'blank' | 'folder' | 'image', folderId?: string }>(
    { open: false, x: 0, y: 0, type: 'blank' }
  )

  // 选择结束后会触发 click：需要抑制一次，否则会把 selection 清空导致对号消失
  const suppressNextClearClickRef = useRef(false)

  // 桌面体验：点击到画布其他区域时取消选中（不要求一定点在网格内部）
  useEffect(() => {
    if (selectedIds.length === 0) return
    const onDown = (e: MouseEvent) => {
      // 框选/拖拽过程中不打断
      if (lassoStartRef.current) return
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('.ig-result-card')) return
      if (target.closest('.ig-context-menu')) return
      if (target.closest('.ig-rename-input')) return
      clearSelection()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [selectedIds.length])

  // refresh：重新加载布局（并关闭文件夹），同时做 reconcile
  useEffect(() => {
    setSelectedIds([])
    setRenamingFolderId(null)

    const nextLayout = reconcileLayout(loadLayout(storageKey), tasksRef.current)
    setLayout(nextLayout)

    // 外部锁定打开的文件夹优先级最高
    const forced = lockToFolderId || initialOpenFolderId
    if (forced && nextLayout.folders && nextLayout.folders[forced]) {
      setOpenFolderId(forced)
      return
    }

    setOpenFolderId(null)

    // 支持外部请求“打开某个手动文件夹”（用于自动叠放模式下仍可打开用户文件夹）
    try {
      const fid = localStorage.getItem(pendingOpenFolderKey)
      if (fid && nextLayout.folders && nextLayout.folders[fid]) {
        setOpenFolderId(fid)
      }
      if (fid) localStorage.removeItem(pendingOpenFolderKey)
    } catch {
      // 忽略
    }
  }, [refreshToken, lockToFolderId, initialOpenFolderId, storageKey, pendingOpenFolderKey])

  // 当外部传入的锁定文件夹变化时同步
  useEffect(() => {
    const forced = lockToFolderId || initialOpenFolderId
    if (!forced) return
    if (layout.folders && layout.folders[forced]) {
      setOpenFolderId(forced)
    }
  }, [lockToFolderId, initialOpenFolderId, layout])

  // 外部（画布空白区域）触发清空选择
  useEffect(() => {
    const onClear = () => {
      setSelectedIds([])
    }
    window.addEventListener(CLEAR_SELECTION_EVENT as any, onClear as any)
    return () => window.removeEventListener(CLEAR_SELECTION_EVENT as any, onClear as any)
  }, [])

  // tasks 变化时自动 reconcile（新任务进 root 顶部 / 删除失效节点）
  useEffect(() => {
    setLayout(prev => reconcileLayout(prev, tasks))
  }, [tasks])

  // 键盘快捷键：Esc 清空；Delete 删除；Ctrl+A 全选；F2 重命名（仅当打开文件夹且单选文件夹? 这里先做 folder card 点击铅笔）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreKeydown(e)) return
      if (e.key === 'Escape') {
        setSelectedIds([])
        return
      }

      // Ctrl/Cmd + A：全选当前视图的“成功图片”
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        const ids = openFolder
          ? openFolder.taskIds.filter(id => isSuccessTask(tasksMap.get(id)))
          : rootItems
              .map(n => parseNodeId(n))
              .filter(p => !!p && (p as any).type === 'task')
              .map(p => (p as any).id)
              .filter((id: string) => isSuccessTask(tasksMap.get(id)))
        setSelectedIds(ids)
        return
      }

      // Delete/Backspace：删除选中
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault()
        const ids = [...selectedIds]
        uiConfirm(`确定删除选中的 ${ids.length} 张图片吗？`, '删除图片').then(ok => {
          if (!ok) return
          ids.forEach(id => onDeleteTask(id))
          setSelectedIds([])
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedIds, openFolderId, layout, tasks])

  const getDefaultFolderName = (folder: ManualFolder): string => {
    // 默认：若文件夹内所有图片的优化偏好相同且非空，则用该优化偏好；否则 fallback
    const prefs: string[] = []
    for (const tid of folder.taskIds) {
      const t = tasksMap.get(tid)
      const p = (t?.optimizePreference || '').trim()
      if (p) prefs.push(p)
    }
    const uniq = Array.from(new Set(prefs))
    if (uniq.length === 1) return uniq[0]
    if (uniq.length > 1) return '文件夹'
    return '文件夹'
  }

  const folderDisplayName = (folder: ManualFolder): string => {
    const n = (folder.name || '').trim()
    return n ? n : getDefaultFolderName(folder)
  }

  const setFolderName = (folderId: string, name: string) => {
    setLayout(prev => {
      const next = reconcileLayout(prev, tasks)
      const f = next.folders[folderId]
      if (!f) return next
      return { ...next, folders: { ...next.folders, [folderId]: { ...f, name } } }
    })
  }

  const startRenameFolder = (folderId: string) => {
    const f = layout.folders[folderId]
    if (!f) return
    setRenamingFolderId(folderId)
    setRenameValue((f.name || '').trim() || folderDisplayName(f))
  }

  const commitRenameFolder = () => {
    if (!renamingFolderId) return
    const v = (renameValue || '').trim()
    // 允许用户清空：清空后回到“未命名”，显示默认优化偏好名称
    setFolderName(renamingFolderId, v)
    setRenamingFolderId(null)
    setRenameValue('')
  }

  const createEmptyFolder = (opts?: { autoRename?: boolean, insertAtFront?: boolean }): string => {
    const fid = makeFolderId()
    const autoRename = opts?.autoRename !== false
    const insertAtFront = opts?.insertAtFront !== false

    setLayout(prev => {
      const next = reconcileLayout(prev, tasks)
      const folder: ManualFolder = { id: fid, name: '', taskIds: [], createdAt: Date.now() }
      const root = insertAtFront ? [nodeFolderId(fid), ...next.root] : [...next.root, nodeFolderId(fid)]
      return {
        root,
        folders: { ...next.folders, [fid]: folder }
      }
    })

    // 桌面体验：新建后直接进入重命名
    if (autoRename) {
      setRenamingFolderId(fid)
      setRenameValue('新建文件夹')
    }
    return fid
  }

  const dissolveFolder = (folderId: string) => {
    setLayout(prev => {
      const next = reconcileLayout(prev, tasks)
      const f = next.folders[folderId]
      if (!f) return next

      const idx = next.root.indexOf(nodeFolderId(folderId))
      const rootWithout = next.root.filter(n => n !== nodeFolderId(folderId))

      // 把文件夹内的图片按顺序放回 root（插入到文件夹原位置）
      const taskNodes = (f.taskIds || [])
        .filter(id => Boolean(tasksMap.get(id)))
        .map(id => nodeTaskId(id))

      if (idx >= 0) {
        rootWithout.splice(idx, 0, ...taskNodes)
      } else {
        rootWithout.unshift(...taskNodes)
      }

      const folders = { ...next.folders }
      delete folders[folderId]
      return { root: rootWithout, folders }
    })
  }

  const safeFileBase = (name: string) => {
    const raw = (name || '').trim() || 'nexa_export'
    // windows 文件名非法字符过滤
    const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
    return cleaned.slice(0, 48) || 'nexa_export'
  }

  const exportFolderToLocal = async (folderId: string) => {
    const f = layout.folders[folderId]
    if (!f) return
    const items = (f.taskIds || [])
      .map(id => tasksMap.get(id))
      .filter(t => !!t && t.status === 'success' && t.url)
      .map((t, i) => ({
        url: (t as any).url as string,
        fileName: `${safeFileBase(folderDisplayName(f))}_${String(i + 1).padStart(2, '0')}`
      }))

    if (!window.nexaAPI?.selectDirectory || !window.nexaAPI?.exportImagesToDir) {
      uiAlert('当前环境不支持选择目录/导出')
      return
    }
    if (items.length === 0) {
      uiAlert('该文件夹没有可保存的图片')
      return
    }

    const picked = await window.nexaAPI.selectDirectory()
    if (!picked.success) {
      uiAlert(`选择目录失败：${picked.error || '未知错误'}`)
      return
    }
    if (!picked.dirPath) return

    const r = await window.nexaAPI.exportImagesToDir({ items, saveDir: picked.dirPath })
    if (!r.success) {
      uiAlert(`保存失败：${r.error || '未知错误'}`)
      return
    }
    const ok = r.saved?.length || 0
    const bad = r.failed?.length || 0
    uiToast('success', `已保存 ${ok} 张${bad ? `，失败 ${bad} 张` : ''}`)
  }

  const clearSelection = () => setSelectedIds([])

  const selectSingle = (id: string) => setSelectedIds([id])

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      return Array.from(set)
    })
  }

  const selectRange = (id: string) => {
    // shift 选择：按当前视图顺序扩展
    const list = openFolder
      ? openFolder.taskIds
      : rootItems
          .map(n => parseNodeId(n))
          .filter(p => !!p && (p as any).type === 'task')
          .map(p => (p as any).id)

    if (selectedIds.length === 0) {
      selectSingle(id)
      return
    }
    const anchor = selectedIds[selectedIds.length - 1]
    const a = list.indexOf(anchor)
    const b = list.indexOf(id)
    if (a < 0 || b < 0) {
      selectSingle(id)
      return
    }
    const [from, to] = a <= b ? [a, b] : [b, a]
    const slice = list.slice(from, to + 1)
    setSelectedIds(Array.from(new Set([...selectedIds, ...slice])))
  }

  const onTaskClick = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    const isMeta = (e.ctrlKey || e.metaKey)
    const isShift = e.shiftKey
    if (isShift) {
      selectRange(taskId)
      return
    }
    if (isMeta) {
      toggleSelect(taskId)
      return
    }
    selectSingle(taskId)
  }

  const beginLasso = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // 仅在空白区域启动框选（避免与拖拽/双击预览冲突）
    if (target.closest('.ig-result-card') || target.closest('button') || target.closest('.ig-result-card-delete')) return
    if (!surfaceRef.current) return
    const startX = e.clientX
    const startY = e.clientY
    lassoStartRef.current = { x: startX, y: startY }
    // 桌面逻辑：不按 Ctrl/Cmd 时用框选替换；按住 Ctrl/Cmd 时追加
    lassoBaseSelectionRef.current = (e.ctrlKey || e.metaKey) ? new Set(selectedIds) : new Set()
    setLasso({ left: startX, top: startY, width: 0, height: 0 })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const updateLasso = (e: React.PointerEvent) => {
    const start = lassoStartRef.current
    if (!start) return
    const x1 = start.x
    const y1 = start.y
    const x2 = e.clientX
    const y2 = e.clientY
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const right = Math.max(x1, x2)
    const bottom = Math.max(y1, y2)
    setLasso({ left, top, width: right - left, height: bottom - top })

    // 计算相交的图片
    const base = lassoBaseSelectionRef.current
    const next = new Set(base)
    const rect = new DOMRect(left, top, right - left, bottom - top)
    const surface = surfaceRef.current
    if (!surface) return
    const nodes = surface.querySelectorAll<HTMLElement>('[data-select-task]')
    nodes.forEach(el => {
      const id = el.getAttribute('data-select-task')
      if (!id) return
      // 只选择成功图片（与桌面一致：可扩展，但这里先做最常用）
      if (!isSuccessTask(tasksMap.get(id))) return
      const r = el.getBoundingClientRect()
      if (rectsIntersect(rect, r)) next.add(id)
    })
    setSelectedIds(Array.from(next))
  }

  const endLasso = (e: React.PointerEvent) => {
    if (!lassoStartRef.current) return
    lassoStartRef.current = null
    setLasso(null)
    // 只在真的发生了框选（鼠标移动过一定距离）时才抑制下一次 click
    if (lasso && (lasso.width > 5 || lasso.height > 5)) {
      suppressNextClearClickRef.current = true
    }
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // 忽略
    }
  }

  const handleSurfaceClickClear = (e: React.MouseEvent) => {
    if (suppressNextClearClickRef.current) {
      suppressNextClearClickRef.current = false
      return
    }
    const target = e.target as HTMLElement
    if (target.closest('.ig-result-card') || target.closest('button') || target.closest('input') || target.closest('textarea')) return
    clearSelection()
  }

  const handleSurfaceContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    // 只在空白处弹出（避免与未来的“文件/文件夹右键”冲突）
    if (target.closest('.ig-result-card') || target.closest('button') || target.closest('input') || target.closest('textarea')) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ open: true, x: e.clientX, y: e.clientY, type: 'blank' })
  }

  const handleFolderContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ open: true, x: e.clientX, y: e.clientY, type: 'folder', folderId })
  }

  const handleImageContextMenu = (e: React.MouseEvent, taskId: string) => {
    e.preventDefault()
    e.stopPropagation()

    // 右键在未选中图片上：先单选该图片，再打开菜单
    if (!selectedSet.has(taskId)) {
      setSelectedIds([taskId])
    }
    setMenu({ open: true, x: e.clientX, y: e.clientY, type: 'image' })
  }

  // 持久化
  useEffect(() => {
    saveLayout(storageKey, layout)
  }, [layout, storageKey])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 }
    })
  )

  const [activeNode, setActiveNode] = useState<RootNodeId | null>(null)
  const activeTaskId = useMemo(() => {
    if (!activeNode) return null
    const p = parseNodeId(activeNode)
    if (!p || p.type !== 'task') return null
    return p.id
  }, [activeNode])

  const draggingTask = activeTaskId ? tasksMap.get(activeTaskId) : null
  // 只有“成功图片”才允许投放进文件夹（避免 loading/error 造成误导）
  const showOrganizeTargets = !!activeTaskId && isSuccessTask(draggingTask)

  const rootItems = layout.root
  const openFolder = openFolderId ? layout.folders[openFolderId] : null
  const folderTaskNodeIds = useMemo(() => {
    if (!openFolder) return []
    return openFolder.taskIds.map(id => nodeTaskId(id))
  }, [openFolder])

  const dropIdForFolder = (folderId: string) => `drop:folder:${folderId}`

  const moveTaskIdsIntoFolder = (folderId: string, taskIds: string[]) => {
    const ids = (taskIds || []).filter(Boolean)
    if (ids.length === 0) return

    // 只移动“成功图片”
    const okIds = ids.filter(id => isSuccessTask(tasksMap.get(id)))
    if (okIds.length === 0) return

    setLayout(prev => {
      const next = reconcileLayout(prev, tasks)
      const f = next.folders[folderId]
      if (!f) return next

      const root = next.root.filter(n => {
        const p = parseNodeId(n)
        if (!p || p.type !== 'task') return true
        return !okIds.includes(p.id)
      })

      const existing = new Set(f.taskIds || [])
      const appended = okIds.filter(id => !existing.has(id))
      const folders = { ...next.folders, [folderId]: { ...f, taskIds: [...(f.taskIds || []), ...appended] } }
      return { root, folders }
    })
  }

  const handleDragEndRoot = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveNode(null)
    if (!over) return

    const activeParsed = parseNodeId(String(active.id))
    if (!activeParsed) return

    const overId = String(over.id)

    // 1) 放入文件夹：拖到文件夹投放区
    if (overId.startsWith('drop:folder:') && activeParsed.type === 'task') {
      const fid = overId.replace('drop:folder:', '')
      const srcTaskId = activeParsed.id
      moveTaskIdsIntoFolder(fid, [srcTaskId])
      return
    }

    // 兼容：over.id 落在 folder 节点（而非 drop zone）
    if (activeParsed.type === 'task') {
      const overParsed = parseNodeId(overId)
      if (overParsed && overParsed.type === 'folder') {
        moveTaskIdsIntoFolder(overParsed.id, [activeParsed.id])
        return
      }
    }

    // 2) 默认：root 内排序
    const overNodeParsed = parseNodeId(overId)
    if (!overNodeParsed) return
    if (active.id === over.id) return

    setLayout(prev => {
      const next = reconcileLayout(prev, tasks)
      const oldIndex = next.root.indexOf(String(active.id))
      const newIndex = next.root.indexOf(String(over.id))
      if (oldIndex < 0 || newIndex < 0) return next
      return { ...next, root: arrayMove(next.root, oldIndex, newIndex) }
    })
  }

  const moveSelectedIntoFolder = (folderId: string) => {
    // 按 root 的可见顺序移动，避免“随机顺序”
    const rootTaskOrder = rootItems
      .map(n => parseNodeId(n))
      .filter(p => !!p && (p as any).type === 'task')
      .map(p => (p as any).id as string)

    const ordered = rootTaskOrder.filter(id => selectedSet.has(id))
    if (ordered.length === 0) return
    moveTaskIdsIntoFolder(folderId, ordered)
    setSelectedIds([])
  }

  const createFolderAndMoveSelected = () => {
    const rootTaskOrder = rootItems
      .map(n => parseNodeId(n))
      .filter(p => !!p && (p as any).type === 'task')
      .map(p => (p as any).id as string)
    const ordered = rootTaskOrder.filter(id => selectedSet.has(id))
    if (ordered.length === 0) return

    const fid = createEmptyFolder({ autoRename: true, insertAtFront: true })
    moveTaskIdsIntoFolder(fid, ordered)
    setSelectedIds([])
  }

  const deleteSelected = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const ok = await uiConfirm(`确定删除选中的 ${ids.length} 张图片吗？`, '删除图片')
    if (!ok) return
    ids.forEach(id => onDeleteTask(id))
    setSelectedIds([])
  }

  const menuItems = useMemo(() => {
    if (!menu.open) return [] as any[]

    const toolItems = canvasTools ? [
      { id: 't_label', kind: 'label', label: '画布工具' },
      { id: 't_sep0', kind: 'separator' },
      { id: 't_autostack', label: '自动叠放', rightText: canvasTools.autoStackEnabled ? '开' : '关', onClick: () => canvasTools.onToggleAutoStack() },
      { id: 't_hidename', label: '隐藏名称', rightText: canvasTools.hideNameEnabled ? '开' : '关', onClick: () => canvasTools.onToggleHideName() },
      { id: 't_refresh', label: '一键刷新', onClick: () => canvasTools.onRefresh() },
      { id: 't_sep1', kind: 'separator' }
    ] : []

    const folders = Object.values(layout.folders || {})
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

    const selectedSuccess = selectedIds.filter(id => isSuccessTask(tasksMap.get(id)))

    if (menu.type === 'folder' && menu.folderId) {
      const f = layout.folders[menu.folderId]
      const name = f ? folderDisplayName(f) : '文件夹'
      return [
        { id: 'f_label', kind: 'label', label: name },
        { id: 'f_sep1', kind: 'separator' },
        { id: 'f_dissolve', label: '解散文件夹', onClick: () => dissolveFolder(menu.folderId!) },
        { id: 'f_save', label: '保存到本地...', onClick: () => exportFolderToLocal(menu.folderId!) }
      ]
    }

    if (menu.type === 'image') {
      const count = selectedIds.length
      const inFolderView = Boolean(openFolder)
      const single = count === 1 ? tasksMap.get(selectedIds[0]) : null
      const canCopyPrompt = Boolean(single && String(single.prompt || '').trim())
      const canCopyReq = Boolean(single && single.request && String(single.request.url || '').trim())
      const canRemake = Boolean(single && String(single.prompt || '').trim() && onRemakeOne)

      const singleActions = (count === 1 && single) ? [
        { id: 'i_copy_prompt', label: '复制提示词', disabled: !canCopyPrompt, onClick: () => copyText(single.prompt || '', '已复制提示词') },
        { id: 'i_copy_req', label: '复制请求代码', disabled: !canCopyReq, onClick: () => copyText(formatRequestDebugForCopy(single.request as RequestDebug), '已复制请求代码') },
        ...(canRemake ? [{ id: 'i_remake', label: '重新生成 1 张', disabled: !canRemake, onClick: () => onRemakeOne && onRemakeOne(single) }] : []),
        { id: 'i_sep0', kind: 'separator' }
      ] : []

      if (inFolderView) {
        return [
          { id: 'i_label', kind: 'label', label: `已选择 ${count} 张` },
          ...singleActions,
          { id: 'i_del', label: '删除', rightText: 'Del', disabled: count === 0, onClick: () => deleteSelected() }
        ]
      }

      // 根视图：删除 / 放入文件夹 / 新建文件夹并放入
      const canMove = selectedSuccess.length > 0
      return [
        { id: 'i_label', kind: 'label', label: `已选择 ${count} 张` },
        ...singleActions,
        { id: 'i_del', label: '删除', rightText: 'Del', disabled: count === 0, onClick: () => deleteSelected() },
        { id: 'i_sep1', kind: 'separator' },
        { id: 'i_newf', label: '新建文件夹并放入', disabled: !canMove, onClick: () => createFolderAndMoveSelected() },
        { id: 'i_sep2', kind: 'separator' },
        { id: 'i_label2', kind: 'label', label: '放入文件夹' },
        ...(folders.length === 0
          ? [{ id: 'i_none', label: '暂无文件夹', disabled: true }]
          : folders.map(f => ({
              id: `i_mv_${f.id}`,
              label: folderDisplayName(f),
              disabled: !canMove,
              onClick: () => moveSelectedIntoFolder(f.id)
            })))
      ]
    }

    // blank
    if (openFolder) {
      return [
        ...toolItems,
        { id: 'b_new_disabled', label: '新建文件夹（返回根目录使用）', disabled: true }
      ]
    }
    return [
      ...toolItems,
      { id: 'b_new', label: '新建文件夹', onClick: () => createEmptyFolder() }
    ]
  }, [menu, layout, selectedIds, openFolderId, tasks, canvasTools])

  const handleDragEndFolder = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveNode(null)
    if (!over || !openFolder) return
    if (active.id === over.id) return

    const activeParsed = parseNodeId(String(active.id))
    const overParsed = parseNodeId(String(over.id))
    if (!activeParsed || !overParsed) return
    if (activeParsed.type !== 'task' || overParsed.type !== 'task') return

    setLayout(prev => {
      const next = reconcileLayout(prev, tasks)
      const f = openFolderId ? next.folders[openFolderId] : null
      if (!f) return next
      const oldIndex = f.taskIds.indexOf(activeParsed.id)
      const newIndex = f.taskIds.indexOf(overParsed.id)
      if (oldIndex < 0 || newIndex < 0) return next
      const newTaskIds = arrayMove(f.taskIds, oldIndex, newIndex)
      const fid = openFolderId || f.id
      return { ...next, folders: { ...next.folders, [fid]: { ...f, id: fid, taskIds: newTaskIds } } }
    })
  }

  // 打开文件夹：使用双击
  const handleOpenFolder = (folderId: string) => {
    setOpenFolderId(folderId)
  }

  const handleFolderPointerDownMaybeOpen = (e: React.PointerEvent, folderId: string) => {
    if (e.button !== 0) return
    const now = Date.now()
    const x = e.clientX
    const y = e.clientY
    const prev = folderDblRef.current

    // 双击阈值 + 位移阈值：避免拖拽导致误判
    if (
      prev &&
      prev.id === folderId &&
      (now - prev.t) < 360 &&
      Math.abs(x - prev.x) < 6 &&
      Math.abs(y - prev.y) < 6
    ) {
      folderDblRef.current = null
      e.preventDefault()
      e.stopPropagation()
      handleOpenFolder(folderId)
      return
    }

    folderDblRef.current = { id: folderId, t: now, x, y }
  }

  const dragging = !!activeNode

  if (openFolder) {
    return (
      <div style={{ width: '100%' }}>
        <div className="ig-stack-head">
          <button
            type="button"
            className="ig-tool-btn"
            onClick={() => {
              if ((lockToFolderId || !showRoot) && onExitFolder) {
                onExitFolder()
                return
              }
              setOpenFolderId(null)
            }}
          >
            返回
          </button>
          <div className="ig-stack-path">{folderHeaderPrefix}：{shortText(folderDisplayName(openFolder), 64)}</div>
          <button
            type="button"
            className="ig-icon-btn"
            title="重命名文件夹"
            onClick={() => openFolderId && startRenameFolder(openFolderId)}
            style={{ marginLeft: 'auto' }}
          >
            <Pencil size={16} />
          </button>
        </div>

        {renamingFolderId === openFolderId && (
          <div className="ig-rename-row" onClick={(e) => e.stopPropagation()}>
            <input
              className="ig-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="输入文件夹名称（留空=使用优化偏好名称）"
              autoFocus
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRenameFolder()
                if (e.key === 'Escape') {
                  setRenamingFolderId(null)
                  setRenameValue('')
                }
              }}
              onBlur={() => commitRenameFolder()}
            />
          </div>
        )}

        <DndContext
          sensors={sensors}
          onDragStart={(e) => setActiveNode(String(e.active.id) as RootNodeId)}
          onDragCancel={() => setActiveNode(null)}
          onDragEnd={handleDragEndFolder}
        >
          <SortableContext items={folderTaskNodeIds} strategy={rectSortingStrategy}>
            <div
              className="ig-select-fill"
              ref={surfaceRef}
              onPointerDown={beginLasso}
              onPointerMove={updateLasso}
              onPointerUp={endLasso}
              onPointerCancel={endLasso}
              onClick={handleSurfaceClickClear}
              onContextMenu={handleSurfaceContextMenu}
            >
              {lasso && (
                <div
                  className="ig-lasso"
                  style={{ left: lasso.left, top: lasso.top, width: lasso.width, height: lasso.height }}
                />
              )}
              <div className="ig-results-grid ig-select-surface">
                {openFolder.taskIds.map(tid => {
                  const task = tasksMap.get(tid)
                  if (!task) return null
                  const nodeId = nodeTaskId(task.id)
                  const selected = selectedSet.has(task.id)
                  return (
                    <SortableNode key={nodeId} nodeId={nodeId}>
                      <div className="ig-result-wrapper">
                        <div className={`ig-result-card ${selected ? 'ig-selected' : ''}`} data-select-task={task.id}>
                        {selected && (
                          <div className="ig-selected-check" aria-label="已选中">
                            <Check size={14} />
                          </div>
                        )}
                        <div
                          className="ig-result-card-delete"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => onDeleteTask(task.id)}
                          title="删除此任务"
                        >
                          <X size={14} />
                        </div>

                        {task.status === 'loading' && (
                          <div className="ig-skeleton">
                            <Sparkles size={24} className="spin-icon" />
                            <span style={{ fontSize: '0.8rem' }}>生成中...</span>
                          </div>
                        )}
                        {task.status === 'error' && (
                          <div style={{ color: '#ff4d4f', padding: '16px', textAlign: 'center', fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            生成失败<br /><br />{task.errorMsg}
                          </div>
                        )}
                        {task.status === 'success' && task.url && (
                          <img
                            src={task.url}
                            alt="Generated"
                            className="ig-result-img"
                            onClick={(e) => onTaskClick(e, task.id)}
                            onDoubleClick={() => onOpenPreview(task.id)}
                            onContextMenu={(e) => handleImageContextMenu(e, task.id)}
                            onLoad={(e) => {
                              const img = e.currentTarget
                              const actual = `${img.naturalWidth}x${img.naturalHeight}`
                              onPatchTask(task.id, { actualSize: actual })
                            }}
                            onError={() => {
                              const src = task.url ? String(task.url) : ''
                              const briefSrc = src.length > 80 ? `${src.slice(0, 40)}...${src.slice(-35)}` : src
                              onPatchTask(task.id, { status: 'error', errorMsg: `图片加载失败（src=${briefSrc || '空'}）` })
                            }}
                          />
                        )}
                      </div>
                      {!hideNameEnabled && (
                        <div className="ig-result-prompt" title={task.prompt}>
                          {task.prompt}
                        </div>
                      )}
                    </div>
                  </SortableNode>
                  )
                })}
              </div>
            </div>
          </SortableContext>

          <DragOverlay>
            {draggingTask && (
              <div className="ig-dnd-overlay">
                {draggingTask.status === 'success' && draggingTask.url ? (
                  <img src={draggingTask.url} alt="drag" />
                ) : (
                  <div className="ig-dnd-overlay-fallback">拖拽中</div>
                )}
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <ContextMenu
          open={menu.open}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(m => ({ ...m, open: false }))}
          items={menuItems}
        />
      </div>
    )
  }

  if (!showRoot) {
    return (
      <div style={{ width: '100%' }}>
        <div className="ig-stack-head">
          <button type="button" className="ig-tool-btn" onClick={() => onExitFolder && onExitFolder()}>返回</button>
          <div className="ig-stack-path">{folderHeaderPrefix}：不存在或已被删除</div>
        </div>
      </div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setActiveNode(String(e.active.id) as RootNodeId)}
      onDragCancel={() => setActiveNode(null)}
      onDragEnd={handleDragEndRoot}
    >
      <SortableContext items={rootItems} strategy={rectSortingStrategy}>
        <div
          className="ig-select-fill"
          ref={surfaceRef}
          onPointerDown={beginLasso}
          onPointerMove={updateLasso}
          onPointerUp={endLasso}
          onPointerCancel={endLasso}
          onClick={handleSurfaceClickClear}
          onContextMenu={handleSurfaceContextMenu}
        >
          {lasso && (
            <div
              className="ig-lasso"
              style={{ left: lasso.left, top: lasso.top, width: lasso.width, height: lasso.height }}
            />
          )}
          <div className="ig-results-grid ig-select-surface">
            {rootItems.map(nid => {
              const p = parseNodeId(nid)
              if (!p) return null

              if (p.type === 'folder') {
                const folderId = p.id
                const folder = layout.folders[folderId]
                if (!folder) return null
                const coverTask = tasksMap.get(folder.taskIds[0])
                const dropId = dropIdForFolder(folderId)
                const displayName = folderDisplayName(folder)

              return (
                <SortableNode key={nid} nodeId={nid} disabled>
                  <div className="ig-result-wrapper">
                    <div
                      className="ig-result-card ig-folder-card"
                      onDoubleClick={() => handleOpenFolder(folderId)}
                      onContextMenu={(e) => handleFolderContextMenu(e, folderId)}
                      title={displayName}
                    >
                      <FolderDropZone id={dropId} active={dragging && showOrganizeTargets} />
                      <div className="ig-folder-badge">{folder.taskIds.length}</div>
                      <button
                        type="button"
                        className="ig-folder-rename"
                        title="重命名文件夹"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          startRenameFolder(folderId)
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      {coverTask?.url ? (
                        <img src={coverTask.url} alt="folder" className="ig-result-img" />
                      ) : (
                        <div className="ig-folder-empty">
                          <Folder size={28} />
                          <div className="t">{displayName || '新建文件夹'}</div>
                        </div>
                      )}
                      <div className="ig-folder-overlay">
                        <div className="ig-folder-title">{shortText(displayName, 18) || '文件夹'}</div>
                        <div className="ig-folder-sub">双击打开</div>
                      </div>
                    </div>
                    {!hideNameEnabled && (
                      <div className="ig-result-prompt" title={displayName}>{shortText(displayName, 42)}</div>
                    )}

                    {renamingFolderId === folderId && (
                      <div className="ig-rename-row" onClick={(e) => e.stopPropagation()}>
                        <input
                          className="ig-rename-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          placeholder="输入文件夹名称（留空=使用优化偏好名称）"
                          autoFocus
                          onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRenameFolder()
                            if (e.key === 'Escape') {
                              setRenamingFolderId(null)
                              setRenameValue('')
                            }
                          }}
                          onBlur={() => commitRenameFolder()}
                        />
                      </div>
                    )}
                  </div>
                </SortableNode>
              )
            }

            // task
            const task = tasksMap.get(p.id)
            if (!task) return null
            const selected = selectedSet.has(task.id)

            return (
              <SortableNode key={nid} nodeId={nid}>
                <div className="ig-result-wrapper" data-select-task={task.id} onContextMenu={(e) => handleImageContextMenu(e, task.id)}>
                  <div className={`ig-result-card ${selected ? 'ig-selected' : ''}`}>
                    {selected && (
                      <div className="ig-selected-check" aria-label="已选中">
                        <Check size={14} />
                      </div>
                    )}

                    <div
                      className="ig-result-card-delete"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onDeleteTask(task.id)}
                      title="删除此任务"
                    >
                      <X size={14} />
                    </div>

                    {task.status === 'loading' && (
                      <div className="ig-skeleton">
                        <Sparkles size={24} className="spin-icon" />
                        <span style={{ fontSize: '0.8rem' }}>生成中...</span>
                      </div>
                    )}
                    {task.status === 'error' && (
                      <div style={{ color: '#ff4d4f', padding: '16px', textAlign: 'center', fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        生成失败<br /><br />{task.errorMsg}
                      </div>
                    )}
                    {task.status === 'success' && task.url && (
                      <img
                        src={task.url}
                        alt="Generated"
                        className="ig-result-img"
                        onClick={(e) => onTaskClick(e, task.id)}
                        onDoubleClick={() => onOpenPreview(task.id)}
                        onContextMenu={(e) => handleImageContextMenu(e, task.id)}
                        onLoad={(e) => {
                          const img = e.currentTarget
                          const actual = `${img.naturalWidth}x${img.naturalHeight}`
                          onPatchTask(task.id, { actualSize: actual })
                        }}
                        onError={() => {
                          const src = task.url ? String(task.url) : ''
                          const briefSrc = src.length > 80 ? `${src.slice(0, 40)}...${src.slice(-35)}` : src
                          onPatchTask(task.id, { status: 'error', errorMsg: `图片加载失败（src=${briefSrc || '空'}）` })
                        }}
                      />
                    )}
                  </div>
                  {!hideNameEnabled && (
                    <div className="ig-result-prompt" title={task.prompt}>
                      {task.prompt}
                    </div>
                  )}
                </div>
              </SortableNode>
            )
            })}
          </div>
        </div>
      </SortableContext>

      <DragOverlay>
        {draggingTask && (
          <div className="ig-dnd-overlay">
            {draggingTask.status === 'success' && draggingTask.url ? (
              <img src={draggingTask.url} alt="drag" />
            ) : (
              <div className="ig-dnd-overlay-fallback">拖拽中</div>
            )}
          </div>
        )}
      </DragOverlay>

      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        onClose={() => setMenu(m => ({ ...m, open: false }))}
        items={menuItems}
      />
    </DndContext>
  )
}
