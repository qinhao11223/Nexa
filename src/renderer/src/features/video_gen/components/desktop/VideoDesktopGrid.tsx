import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, ChevronLeft, Folder, FolderOpen, Film } from 'lucide-react'
import type { VideoMode, VideoTask } from '../../store'
import VideoContextMenu, { type VideoContextMenuItem } from './VideoContextMenu'
import { loadLayout, makeFolderId, nodeFolderId, nodeTaskId, parseNodeId, reconcileLayout, saveLayout, type VideoManualLayout, type VideoRootNodeId } from './layout'
import ConfirmModal from '../ConfirmModal'

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

function FolderDropZone(props: { id: string, active: boolean }) {
  const { id, active } = props
  const { isOver, setNodeRef } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`vg-folder-drop ${active ? 'show' : ''} ${isOver ? 'over' : ''}`} aria-hidden={!active}>
      放入文件夹
    </div>
  )
}

function SortableRootNode(props: {
  nodeId: VideoRootNodeId
  disabled?: boolean
  children: React.ReactNode
}) {
  const { nodeId, disabled, children } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: nodeId, disabled: Boolean(disabled) })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.65 : 1
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={isDragging ? 'vg-dnd-dragging' : ''}>
      {children}
    </div>
  )
}

function SortableFolderTask(props: { id: string, children: React.ReactNode }) {
  const { id, children } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.65 : 1
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={isDragging ? 'vg-dnd-dragging' : ''}>
      {children}
    </div>
  )
}

function shortText(s: string, max = 38): string {
  const t = String(s || '').trim()
  if (t.length <= max) return t
  return t.slice(0, max) + '...'
}

export default function VideoDesktopGrid(props: {
  mode: VideoMode
  tasks: VideoTask[]
  outputDirectory: string
  onOpen: (taskId: string) => void
  onDeleteTasks: (ids: string[]) => void
}) {
  const { mode, tasks, outputDirectory, onOpen, onDeleteTasks } = props

  const storageKey = mode === 't2v' ? 'nexa-video-manual-layout-t2v-v1' : 'nexa-video-manual-layout-i2v-v1'
  const openFolderKey = mode === 't2v' ? 'nexa-video-open-folder-t2v-v1' : 'nexa-video-open-folder-i2v-v1'

  const taskIds = useMemo(() => tasks.map(t => t.id), [tasks])
  const taskMap = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])

  const [layout, setLayout] = useState<VideoManualLayout>(() => reconcileLayout(loadLayout(storageKey), taskIds))
  const [openFolderId, setOpenFolderId] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(openFolderKey)
      return v && v.trim() ? v : null
    } catch {
      return null
    }
  })

  // selection
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  useEffect(() => {
    // mode 切换时重新加载布局
    const next = reconcileLayout(loadLayout(storageKey), taskIds)
    setLayout(next)
    try {
      const v = localStorage.getItem(openFolderKey)
      setOpenFolderId(v && v.trim() ? v : null)
    } catch {
      setOpenFolderId(null)
    }
    // 清理选择
    setSelectedIds([])
  }, [storageKey])

  // tasks 变化时：自动对齐布局
  useEffect(() => {
    setLayout(prev => reconcileLayout(prev, taskIds))
  }, [taskIds.join('|')])

  // 持久化布局 + 打开文件夹
  useEffect(() => {
    saveLayout(storageKey, layout)
  }, [storageKey, layout])

  useEffect(() => {
    try {
      localStorage.setItem(openFolderKey, openFolderId || '')
    } catch {
      // ignore
    }
  }, [openFolderId, openFolderKey])

  const currentFolder = openFolderId ? layout.folders[openFolderId] : null
  const isInFolder = Boolean(openFolderId && currentFolder)

  const visibleRootNodes = useMemo(() => layout.root || [], [layout.root])
  const visibleTaskIds = useMemo(() => {
    if (isInFolder && currentFolder) return currentFolder.taskIds
    const ids: string[] = []
    for (const n of visibleRootNodes) {
      const p = parseNodeId(n)
      if (p?.type === 'task') ids.push(p.id)
    }
    return ids
  }, [isInFolder, currentFolder?.taskIds?.join('|'), visibleRootNodes.join('|')])

  // lasso
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [lasso, setLasso] = useState<{ left: number, top: number, width: number, height: number } | null>(null)
  const lassoStartRef = useRef<{ x: number, y: number } | null>(null)
  const lassoBaseSelectionRef = useRef<Set<string>>(new Set())
  const suppressNextClearClickRef = useRef(false)

  const beginLasso = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement | null)?.closest('.vg-desk-card')) return
    lassoStartRef.current = { x: e.clientX, y: e.clientY }
    lassoBaseSelectionRef.current = (e.ctrlKey || e.metaKey) ? new Set(selectedIds) : new Set()
    setLasso({ left: e.clientX, top: e.clientY, width: 0, height: 0 })
  }

  const updateLasso = (e: React.PointerEvent) => {
    const start = lassoStartRef.current
    if (!start) return
    const left = Math.min(start.x, e.clientX)
    const right = Math.max(start.x, e.clientX)
    const top = Math.min(start.y, e.clientY)
    const bottom = Math.max(start.y, e.clientY)
    const nextRect = { left, top, width: right - left, height: bottom - top }
    setLasso(nextRect)

    const surface = surfaceRef.current
    if (!surface) return
    const sel = new Set<string>(lassoBaseSelectionRef.current)
    const lassoRect = new DOMRect(nextRect.left, nextRect.top, nextRect.width, nextRect.height)
    const nodes = Array.from(surface.querySelectorAll('[data-vtask-id]')) as HTMLElement[]
    for (const el of nodes) {
      const id = el.getAttribute('data-vtask-id') || ''
      if (!id) continue
      if (!visibleTaskIds.includes(id)) continue
      const r = el.getBoundingClientRect()
      if (rectsIntersect(r, lassoRect)) sel.add(id)
    }
    setSelectedIds(Array.from(sel))
  }

  const endLasso = () => {
    if (!lassoStartRef.current) return
    lassoStartRef.current = null
    if (lasso && (lasso.width > 5 || lasso.height > 5)) suppressNextClearClickRef.current = true
    setLasso(null)
  }

  const clearSelection = () => setSelectedIds([])

  const selectAllVisible = () => {
    if (!visibleTaskIds.length) return
    setSelectedIds([...visibleTaskIds])
  }

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreKeydown(e)) return

      // 框选过程中不打断
      if (lassoStartRef.current) return

      if (e.key === 'Escape') {
        clearSelection()
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedIds.length) return
        const ids = [...selectedIds]
        askConfirm({
          title: '删除任务',
          message: `确定要删除选中的 ${ids.length} 个任务吗？`,
          confirmText: '删除',
          danger: true,
          onConfirm: () => {
            onDeleteTasks(ids)
            clearSelection()
          }
        })
        return
      }

      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a') {
        e.preventDefault()
        selectAllVisible()
        return
      }

      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault()
        if (!selectedIds.length) return
        saveSelectedToOutput()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key).toLowerCase() === 'n') {
        e.preventDefault()
        if (isInFolder) {
          setOpenFolderId(null)
        }
        const id = makeFolderId()
        setLayout(prev => {
          const next: VideoManualLayout = {
            root: [nodeFolderId(id), ...(prev.root || [])],
            folders: {
              ...(prev.folders || {}),
              [id]: { id, name: '新建文件夹', taskIds: [], createdAt: Date.now() }
            }
          }
          return reconcileLayout(next, taskIds)
        })
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds.join('|'), visibleTaskIds.join('|'), onDeleteTasks, isInFolder, taskIds.join('|')])

  // context menu
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [menuTarget, setMenuTarget] = useState<{ kind: 'blank' | 'task' | 'folder', id?: string }>({ kind: 'blank' })
  const [tip, setTip] = useState('')

  const [confirmState, setConfirmState] = useState<null | {
    title?: string
    message: string
    confirmText?: string
    danger?: boolean
    onConfirm: () => void
  }>(null)

  const askConfirm = (args: {
    title?: string
    message: string
    confirmText?: string
    danger?: boolean
    onConfirm: () => void
  }) => setConfirmState(args)

  // rename folder
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const showTip = (text: string) => {
    setTip(text)
    window.setTimeout(() => setTip(''), 2400)
  }

  const dissolveFolder = (folderId: string) => {
    setLayout(prev => {
      const f = prev.folders?.[folderId]
      const moved = f?.taskIds || []
      const nextFolders = { ...(prev.folders || {}) }
      delete nextFolders[folderId]
      const withoutFolderNode = (prev.root || []).filter(n => n !== nodeFolderId(folderId))
      const movedNodes = moved.map(nodeTaskId)
      const next: VideoManualLayout = {
        root: [...movedNodes, ...withoutFolderNode],
        folders: nextFolders
      }
      return reconcileLayout(next, taskIds)
    })
    if (openFolderId === folderId) setOpenFolderId(null)
  }

  const moveTasksToFolder = (folderId: string, ids: string[]) => {
    if (!ids.length) return
    setLayout(prev => {
      const root = (prev.root || []).filter(n => {
        const p = parseNodeId(n)
        return !(p?.type === 'task' && ids.includes(p.id))
      })
      const f = prev.folders?.[folderId]
      if (!f) return prev
      const existing = new Set((f.taskIds || []).map(String))
      const nextIds = [...ids.filter(id => !existing.has(id)), ...(f.taskIds || [])]
      const next: VideoManualLayout = {
        root,
        folders: {
          ...(prev.folders || {}),
          [folderId]: { ...f, taskIds: nextIds }
        }
      }
      return reconcileLayout(next, taskIds)
    })
    clearSelection()
  }

  const moveTasksToRoot = (ids: string[]) => {
    if (!ids.length) return
    if (!currentFolder) return
    setLayout(prev => {
      const f = prev.folders?.[currentFolder.id]
      if (!f) return prev
      const nextFolderIds = (f.taskIds || []).filter(id => !ids.includes(id))
      const next: VideoManualLayout = {
        root: [...ids.map(nodeTaskId), ...(prev.root || [])],
        folders: {
          ...(prev.folders || {}),
          [currentFolder.id]: { ...f, taskIds: nextFolderIds }
        }
      }
      return reconcileLayout(next, taskIds)
    })
    clearSelection()
  }

  const saveSelectedToOutput = async () => {
    const list = selectedIds
      .map(id => taskMap.get(id))
      .filter(Boolean) as VideoTask[]
    const okList = list.filter(t => Boolean(t.url))
    if (!okList.length) {
      showTip('没有可保存的视频（需要 url）')
      return
    }
    if (!window.nexaAPI?.downloadVideo) {
      showTip('保存失败：当前环境不支持')
      return
    }

    let saved = 0
    for (const t of okList) {
      try {
        const r = await window.nexaAPI.downloadVideo({
          url: String(t.url),
          saveDir: outputDirectory,
          fileName: `nexa_video_${t.createdAt || Date.now()}_${Math.floor(Math.random() * 1000)}`
        })
        if (r.success) saved += 1
      } catch {
        // ignore
      }
    }
    showTip(saved ? `已保存 ${saved} 个到输出目录` : '保存失败')
  }

  const exportSelectedToDir = async () => {
    const list = selectedIds
      .map(id => taskMap.get(id))
      .filter(Boolean) as VideoTask[]
    const okList = list.filter(t => Boolean(t.url))
    if (!okList.length) {
      showTip('没有可导出的视频（需要 url）')
      return
    }
    if (!window.nexaAPI?.selectDirectory || !window.nexaAPI?.exportVideosToDir) {
      showTip('导出失败：当前环境不支持')
      return
    }
    const picked = await window.nexaAPI.selectDirectory()
    if (!picked.success) {
      showTip(`导出失败：${picked.error || '选择目录失败'}`)
      return
    }
    if (!picked.dirPath) {
      showTip('已取消导出')
      return
    }
    const r = await window.nexaAPI.exportVideosToDir({
      saveDir: picked.dirPath,
      items: okList.map((t, idx) => ({
        url: String(t.url),
        fileName: `nexa_video_${t.createdAt || Date.now()}_${idx + 1}`
      }))
    })
    if (!r.success) {
      showTip(`导出失败：${r.error || '未知错误'}`)
      return
    }
    const failed = Array.isArray(r.failed) ? r.failed.length : 0
    showTip(failed ? `导出完成（失败 ${failed} 个）` : '导出完成')
  }

  const menuItems: VideoContextMenuItem[] = useMemo(() => {
    const items: VideoContextMenuItem[] = []
    const hasSelection = selectedIds.length > 0

    if (menuTarget.kind === 'task') {
      const t = menuTarget.id ? taskMap.get(menuTarget.id) : undefined
      items.push({ id: 'label_task', kind: 'label', label: '视频任务' })
      items.push({
        id: 'open',
        label: t?.url ? '打开预览' : '查看详情',
        disabled: !t,
        onClick: () => t && onOpen(String(t.id))
      })
      items.push({ id: 'sep1', kind: 'separator' })
    }

    if (menuTarget.kind === 'folder') {
      const f = menuTarget.id ? layout.folders[menuTarget.id] : null
      items.push({ id: 'label_folder', kind: 'label', label: '文件夹' })
      items.push({
        id: 'open_folder',
        label: '打开',
        onClick: () => {
          if (!menuTarget.id) return
          setOpenFolderId(menuTarget.id)
        }
      })
      items.push({
        id: 'rename_folder',
        label: '重命名',
        disabled: !menuTarget.id,
        onClick: () => {
          if (!menuTarget.id) return
          setRenamingFolderId(menuTarget.id)
          setRenameValue(String(f?.name || ''))
        }
      })
      items.push({
        id: 'dissolve_folder',
        label: '解散文件夹（移到根目录）',
        disabled: !menuTarget.id,
        onClick: () => {
          if (!menuTarget.id) return
          const folderId = menuTarget.id
          askConfirm({
            title: '解散文件夹',
            message: '确定要解散该文件夹吗？文件夹内的视频会回到根目录。',
            confirmText: '解散',
            danger: true,
            onConfirm: () => dissolveFolder(folderId)
          })
        }
      })
      items.push({
        id: 'delete_folder',
        label: '删除文件夹',
        disabled: !menuTarget.id,
        onClick: () => {
          if (!menuTarget.id) return
          const count = f?.taskIds?.length || 0
          const folderId = menuTarget.id
          askConfirm({
            title: '删除文件夹',
            message: count > 0
              ? `该文件夹内还有 ${count} 个视频。删除文件夹将先解散文件夹并保留视频到根目录。继续？`
              : '确定要删除该文件夹吗？',
            confirmText: '删除',
            danger: true,
            onConfirm: () => dissolveFolder(folderId)
          })
        }
      })
      items.push({ id: 'sep_f', kind: 'separator' })
    }

    if (!isInFolder) {
      items.push({
        id: 'new_folder',
        label: '新建文件夹',
        rightText: 'Ctrl+Shift+N',
        onClick: () => {
          const id = makeFolderId()
          setLayout(prev => {
            const next: VideoManualLayout = {
              root: [nodeFolderId(id), ...(prev.root || [])],
              folders: {
                ...(prev.folders || {}),
                [id]: { id, name: '新建文件夹', taskIds: [], createdAt: Date.now() }
              }
            }
            return reconcileLayout(next, taskIds)
          })
          setRenamingFolderId(id)
          setRenameValue('新建文件夹')
        }
      })
      items.push({ id: 'sep2', kind: 'separator' })
    }

    if (isInFolder && currentFolder && hasSelection) {
      items.push({
        id: 'move_root',
        label: '移到根目录',
        onClick: () => moveTasksToRoot(selectedIds)
      })
      items.push({ id: 'sep_move', kind: 'separator' })
    }

    items.push({
      id: 'save_out',
      label: '保存到输出目录',
      disabled: !hasSelection,
      onClick: () => saveSelectedToOutput()
    })

    items.push({
      id: 'export',
      label: '导出选中...',
      disabled: !hasSelection,
      onClick: () => exportSelectedToDir()
    })

    items.push({ id: 'sep3', kind: 'separator' })

    items.push({
      id: 'select_all',
      label: '全选',
      rightText: 'Ctrl+A',
      disabled: !visibleTaskIds.length,
      onClick: () => selectAllVisible()
    })
    items.push({
      id: 'clear_sel',
      label: '取消选择',
      rightText: 'Esc',
      disabled: !hasSelection,
      onClick: () => clearSelection()
    })

    items.push({ id: 'sep4', kind: 'separator' })

    items.push({
      id: 'delete',
      label: hasSelection ? `删除选中（${selectedIds.length}）` : '删除',
      rightText: 'Del',
      disabled: !hasSelection,
      onClick: () => {
        if (!hasSelection) return
        const ids = [...selectedIds]
        askConfirm({
          title: '删除任务',
          message: `确定要删除选中的 ${ids.length} 个任务吗？`,
          confirmText: '删除',
          danger: true,
          onConfirm: () => {
            onDeleteTasks(ids)
            clearSelection()
          }
        })
      }
    })

    return items
  }, [menuTarget.kind, menuTarget.id, selectedIds.join('|'), visibleTaskIds.join('|'), isInFolder, currentFolder?.id, layout.folders])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [dragActiveId, setDragActiveId] = useState<string | null>(null)

  const onRootDragStart = (e: DragStartEvent) => {
    setDragActiveId(String(e.active.id))
  }

  const onRootDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    setDragActiveId(null)
    if (!over) return

    const activeId = String(active.id)
    const overId = String(over.id)

    // drop into folder
    if (overId.startsWith('drop:')) {
      const folderId = overId.slice('drop:'.length)
      const p = parseNodeId(activeId)
      if (p?.type === 'task') {
        moveTasksToFolder(folderId, [p.id])
      }
      return
    }

    // reorder in root
    if (activeId === overId) return
    setLayout(prev => {
      const oldIndex = (prev.root || []).indexOf(activeId)
      const newIndex = (prev.root || []).indexOf(overId)
      if (oldIndex < 0 || newIndex < 0) return prev
      const nextRoot = arrayMove(prev.root || [], oldIndex, newIndex)
      return { ...prev, root: nextRoot }
    })
  }

  // folder reorder
  const onFolderDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over) return
    const a = String(active.id)
    const o = String(over.id)
    if (a === o) return
    if (!currentFolder) return
    const ids = currentFolder.taskIds || []
    const oldIndex = ids.indexOf(a)
    const newIndex = ids.indexOf(o)
    if (oldIndex < 0 || newIndex < 0) return
    const nextIds = arrayMove(ids, oldIndex, newIndex)
    setLayout(prev => {
      const f = prev.folders?.[currentFolder.id]
      if (!f) return prev
      return {
        ...prev,
        folders: { ...(prev.folders || {}), [currentFolder.id]: { ...f, taskIds: nextIds } }
      }
    })
  }

  const renderTaskCard = (t: VideoTask) => {
    const isRunning = t.status === 'running' || t.status === 'queued'
    const isError = t.status === 'error'
    const isOk = t.status === 'success'
    const canOpen = Boolean(t.url)
    const selected = selectedSet.has(t.id)

    return (
      <div
        key={t.id}
        className={`vg-desk-card vg-desk-task ${canOpen ? 'clickable' : ''} ${selected ? 'selected' : ''}`}
        data-vtask-id={t.id}
        onDoubleClick={() => onOpen(t.id)}
        onPointerDown={(e) => {
          // selection
          if (e.button !== 0) return
          if (lassoStartRef.current) return
          e.stopPropagation()
          if (e.ctrlKey || e.metaKey) {
            const next = new Set(selectedSet)
            if (next.has(t.id)) next.delete(t.id)
            else next.add(t.id)
            setSelectedIds(Array.from(next))
          } else {
            setSelectedIds([t.id])
          }
        }}
        title={t.prompt}
      >
        <div className="vg-card-media">
          {t.url ? (
            <video src={t.url} muted playsInline preload="metadata" />
          ) : (
            <div className="vg-card-ph">
              <Film size={26} style={{ opacity: 0.65 }} />
            </div>
          )}

          <div className="vg-card-badge">
            <span>{isRunning ? 'running' : isOk ? 'success' : isError ? 'error' : t.status}</span>
          </div>

          {isRunning && (
            <div className="vg-card-progress">
              <div className="bar" style={{ width: `${Math.max(0, Math.min(100, t.progress || 0))}%` }} />
            </div>
          )}

          {selected && (
            <div className="vg-desk-check" title="已选择">
              <Check size={14} />
            </div>
          )}
        </div>

        <div className="vg-card-meta">
          <div className="p">{shortText(t.prompt, 38)}</div>
          <div className="m">{t.durationSec}s · {t.aspectRatio}</div>
          {t.status === 'error' && t.errorMsg ? (
            <div className="vg-desk-err" title={t.errorMsg}>{shortText(t.errorMsg, 48)}</div>
          ) : null}
        </div>
      </div>
    )
  }

  const renderFolderCard = (folderId: string) => {
    const f = layout.folders[folderId]
    if (!f) return null
    const count = f.taskIds?.length || 0
    const coverTask = count ? taskMap.get(f.taskIds[0]) : undefined
    const isRenaming = renamingFolderId === folderId
    const dropId = `drop:${folderId}`
    const canDrop = Boolean(dragActiveId && String(dragActiveId).startsWith('task:'))

    return (
      <div
        className="vg-desk-card vg-desk-folder"
        data-vfolder-id={folderId}
        onDoubleClick={() => setOpenFolderId(folderId)}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          // click folder doesn't alter task selection by default
        }}
        title={f.name || '文件夹'}
      >
        <FolderDropZone id={dropId} active={canDrop} />
        <div className="vg-folder-media">
          {coverTask?.url ? (
            <video src={coverTask.url} muted playsInline preload="metadata" />
          ) : (
            <div className="vg-folder-ph"><Folder size={26} style={{ opacity: 0.7 }} /></div>
          )}
        </div>

        <div className="vg-folder-meta">
          {isRenaming ? (
            <div className="vg-folder-rename">
              <input
                className="vg-folder-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = renameValue.trim()
                    setLayout(prev => {
                      const cur = prev.folders?.[folderId]
                      if (!cur) return prev
                      return { ...prev, folders: { ...(prev.folders || {}), [folderId]: { ...cur, name: v } } }
                    })
                    setRenamingFolderId(null)
                  }
                  if (e.key === 'Escape') setRenamingFolderId(null)
                }}
                autoFocus
              />
              <button
                type="button"
                className="vg-folder-icon"
                title="保存"
                onClick={() => {
                  const v = renameValue.trim()
                  setLayout(prev => {
                    const cur = prev.folders?.[folderId]
                    if (!cur) return prev
                    return { ...prev, folders: { ...(prev.folders || {}), [folderId]: { ...cur, name: v } } }
                  })
                  setRenamingFolderId(null)
                }}
              >
                <Check size={14} />
              </button>
              <button type="button" className="vg-folder-icon" title="取消" onClick={() => setRenamingFolderId(null)}>
                ×
              </button>
            </div>
          ) : (
            <>
              <div className="t">{f.name || '文件夹'}</div>
              <div className="d">{count} 个视频</div>
            </>
          )}
        </div>
      </div>
    )
  }

  const onSurfaceClick = () => {
    if (suppressNextClearClickRef.current) {
      suppressNextClearClickRef.current = false
      return
    }
    if (lassoStartRef.current) return
    clearSelection()
  }

  const onSurfaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const target = e.target as HTMLElement | null
    const taskEl = target?.closest('[data-vtask-id]') as HTMLElement | null
    const folderEl = target?.closest('[data-vfolder-id]') as HTMLElement | null

    if (taskEl) {
      const id = taskEl.getAttribute('data-vtask-id') || ''
      if (id && !selectedSet.has(id)) setSelectedIds([id])
      setMenuTarget({ kind: 'task', id })
    } else if (folderEl && !isInFolder) {
      const id = folderEl.getAttribute('data-vfolder-id') || ''
      setMenuTarget({ kind: 'folder', id })
    } else {
      setMenuTarget({ kind: 'blank' })
    }

    setMenuPos({ x: e.clientX, y: e.clientY })
    setMenuOpen(true)
  }

  if (!tasks.length && !Object.keys(layout.folders || {}).length) {
    return (
      <div className="vg-canvas">
        <div className="vg-empty">
          <FolderOpen size={44} style={{ opacity: 0.6 }} />
          <div className="t">还没有视频任务</div>
          <div className="d">输入提示词并点击“开始”生成视频</div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={surfaceRef}
      className="vg-canvas vg-desk"
      onClick={onSurfaceClick}
      onContextMenu={onSurfaceContextMenu}
      onPointerDown={beginLasso}
      onPointerMove={updateLasso}
      onPointerUp={endLasso}
      onPointerCancel={endLasso}
    >
      <div className="vg-desk-head">
        {isInFolder && currentFolder ? (
          <>
            <button type="button" className="vg-desk-back" onClick={() => setOpenFolderId(null)} title="返回根目录">
              <ChevronLeft size={16} /> 返回
            </button>
            <div className="vg-desk-path">{currentFolder.name || '文件夹'} <span className="muted">({currentFolder.taskIds.length})</span></div>
          </>
        ) : (
          <div className="vg-desk-path">根目录 <span className="muted">({visibleTaskIds.length})</span></div>
        )}
      </div>

      {!isInFolder ? (
        <DndContext
          sensors={sensors}
          onDragStart={onRootDragStart}
          onDragEnd={onRootDragEnd}
          onDragCancel={() => setDragActiveId(null)}
        >
          <SortableContext items={visibleRootNodes} strategy={rectSortingStrategy}>
            <div className="vg-grid vg-desk-grid">
              {visibleRootNodes.map(n => {
                const p = parseNodeId(n)
                if (!p) return null
                if (p.type === 'folder') {
                  return (
                    <SortableRootNode key={n} nodeId={n}>
                      {renderFolderCard(p.id)}
                    </SortableRootNode>
                  )
                }
                const t = taskMap.get(p.id)
                if (!t) return null
                return (
                  <SortableRootNode key={n} nodeId={n}>
                    {renderTaskCard(t)}
                  </SortableRootNode>
                )
              })}
            </div>
          </SortableContext>

          <DragOverlay>
            {dragActiveId ? (
              <div className="vg-drag-overlay">拖拽中</div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <DndContext
          sensors={sensors}
          onDragEnd={onFolderDragEnd}
        >
          <SortableContext items={currentFolder?.taskIds || []} strategy={rectSortingStrategy}>
            <div className="vg-grid vg-desk-grid">
              {(currentFolder?.taskIds || []).map(id => {
                const t = taskMap.get(id)
                if (!t) return null
                return (
                  <SortableFolderTask key={id} id={id}>
                    {renderTaskCard(t)}
                  </SortableFolderTask>
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {lasso && (
        <div className="vg-lasso" style={{ left: lasso.left, top: lasso.top, width: lasso.width, height: lasso.height }} />
      )}

      {tip ? <div className="vg-desk-tip">{tip}</div> : null}

      <VideoContextMenu
        open={menuOpen}
        x={menuPos.x}
        y={menuPos.y}
        items={menuItems}
        onClose={() => setMenuOpen(false)}
      />

      <ConfirmModal
        open={Boolean(confirmState)}
        title={confirmState?.title}
        message={confirmState?.message || ''}
        confirmText={confirmState?.confirmText}
        danger={confirmState?.danger}
        onCancel={() => setConfirmState(null)}
        onConfirm={() => {
          const fn = confirmState?.onConfirm
          setConfirmState(null)
          if (fn) fn()
        }}
      />
    </div>
  )
}
