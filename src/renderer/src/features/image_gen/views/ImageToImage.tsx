import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Image as ImageIcon, Sparkles, FolderOpen, Library as LibraryIcon, ChevronRight, ChevronLeft, Minus, Cpu, SearchCode, X, Trash2, Pencil, LayoutGrid } from 'lucide-react'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ImageGenMode } from '../ImageGen'
import CompactModelPicker from '../components/CompactModelPicker'
import { useSettingsStore } from '../../settings/store'
import { optimizePrompt } from '../../../core/api/chat'
import { resolveApiKey } from '../../settings/utils/apiKeys'
import OptimizeSystemPromptEditor from '../components/OptimizeSystemPromptEditor'
import PromptLinkPanel from '../components/PromptLinkPanel'
import { takePendingPromptLink } from '../../creative_library/promptLink'
import CreativeCollectionsPanel from '../components/CreativeCollectionsPanel'
import ManualFolderGrid from '../components/ManualFolderGrid'
import { AutoDraggableTaskCard, AutoManualFolderCard } from '../components/AutoStackCards'
import ContextMenu from '../components/ContextMenu'
import { makeGroupKey, shortText } from '../utils/stacking'
import { useImageGenStore } from '../store'
import { formatRequestDebugForCopy } from '../utils/requestDebug'
import { uiConfirm, uiTextViewer } from '../../ui/dialogStore'
import { uiToast } from '../../ui/toastStore'
import { kvGetJsonMigrate, kvSetJson } from '../../../core/persist/kvClient'

export default function ImageToImage({ onSwitchMode }: { onSwitchMode: (mode: ImageGenMode) => void }) {
  const { providers, activeProviderId, imageProviderId, updateProvider, outputDirectory, autoSaveEnabled } = useSettingsStore()
  const providerId = imageProviderId || activeProviderId
  const activeProvider = providers.find(p => p.id === providerId)
  
  const availableModels = activeProvider?.models || []
  const currentImageModel = activeProvider?.selectedImageModel || ''
  const currentPromptModel = activeProvider?.selectedPromptModel || ''

  // 常用模型预设：用于快速切换，减少每次打开下拉后再搜索
  const pinnedImageModels = activeProvider?.pinnedImageModels || []
  const pinnedPromptModels = activeProvider?.pinnedPromptModels || []

  // 生成任务（按 mode 过滤，避免与文字生图混在一起）
  const allTasks = useImageGenStore(s => s.tasks)
  const hydrateTasks = useImageGenStore(s => s.hydrateFromStorage)
  const refreshTasks = useImageGenStore(s => s.refreshFromStorage)
  const patchTask = useImageGenStore(s => s.patchTask)
  const deleteTask = useImageGenStore(s => s.deleteTask)
  const clearTasksByMode = useImageGenStore(s => s.clearTasksByMode)
  const enqueueGenerateBatch = useImageGenStore(s => s.enqueueGenerateBatch)
  const enqueueGenerateOne = useImageGenStore(s => s.enqueueGenerateOne)

  const tasks = useMemo(() => (allTasks || []).filter(t => t.mode === 'i2i'), [allTasks])

  // 记住上次使用的参数（关闭/重启后仍保留）
  const UI_PARAMS_KEY = 'nexa-image-ui-params-i2i-v1'
  const uiDefaults = useMemo(() => ({ ratio: '1:1', res: '2K', prompt: '', isRightPanelOpen: true, batchCount: 1 }), [])

  const [ratio, setRatio] = useState(uiDefaults.ratio)
  const [res, setRes] = useState(uiDefaults.res)
  const [prompt, setPrompt] = useState(uiDefaults.prompt)
  const [optimizePreference, setOptimizePreference] = useState<string>('')
  const [injectOptimizeCustomText, setInjectOptimizeCustomText] = useState<string>('')
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(Boolean(uiDefaults.isRightPanelOpen))
  const [batchCount, setBatchCount] = useState(() => Math.max(1, Math.min(10, Number(uiDefaults.batchCount) || 1)))

  const [uiHydrated, setUiHydrated] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const p = await kvGetJsonMigrate<any>(UI_PARAMS_KEY, uiDefaults as any)
      if (!alive) return
      if (p && typeof p === 'object') {
        setRatio(typeof p.ratio === 'string' ? p.ratio : uiDefaults.ratio)
        setRes(typeof p.res === 'string' ? p.res : uiDefaults.res)
        setPrompt(typeof p.prompt === 'string' ? p.prompt : uiDefaults.prompt)
        setIsRightPanelOpen(typeof p.isRightPanelOpen === 'boolean' ? p.isRightPanelOpen : uiDefaults.isRightPanelOpen)
        setBatchCount(Math.max(1, Math.min(10, Number(p.batchCount) || uiDefaults.batchCount)))
      }
      setUiHydrated(true)
    })()
    return () => {
      alive = false
    }
  }, [UI_PARAMS_KEY, uiDefaults])

  useEffect(() => {
    if (!uiHydrated) return
    const t = window.setTimeout(() => {
      void kvSetJson(UI_PARAMS_KEY, { ratio, res, prompt, isRightPanelOpen, batchCount })
    }, 360)
    return () => window.clearTimeout(t)
  }, [uiHydrated, ratio, res, prompt, isRightPanelOpen, batchCount, UI_PARAMS_KEY])
  
  const [isOptimizing, setIsOptimizing] = useState(false)

  // 图生图输入图片
  const fileInputRef = useRef<HTMLInputElement>(null)
  const MAX_INPUT_IMAGES = 20
  const [inputImages, setInputImages] = useState<Array<{ id: string, dataUrl: string, base64: string, name: string }>>([])
  const [dragOver, setDragOver] = useState(false)
  const [isUploadGalleryOpen, setIsUploadGalleryOpen] = useState(false)

  const uploadDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  const refIdSeed = useRef(0)
  const makeRefId = () => {
    refIdSeed.current += 1
    return `ref_${Date.now()}_${refIdSeed.current}_${Math.random().toString(16).slice(2, 8)}`
  }

  function SortableUploadThumb(props: {
    id: string
    dataUrl: string
    name: string
    onRemove: () => void
  }) {
    const { id, dataUrl, name, onRemove } = props
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging
    } = useSortable({ id })

    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.72 : 1,
      boxShadow: isDragging ? '0 14px 40px rgba(0,0,0,0.55)' : undefined,
      zIndex: isDragging ? 2 : 0
    }

    return (
      <div ref={setNodeRef} className="ig-upload-modal-thumb" style={style} title={name} {...attributes} {...listeners}>
        <img src={dataUrl} alt={name} draggable={false} />
        <button
          type="button"
          className="ig-upload-remove"
          onPointerDown={(e) => {
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="移除"
        >
          <X size={14} />
        </button>
        <div className="ig-upload-modal-name">{name}</div>
      </div>
    )
  }

  // 预览模态框
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null)
  const [previewMsg, setPreviewMsg] = useState<string>('')

  const tasksMap = useMemo(() => {
    const m = new Map<string, any>()
    for (const t of tasks) m.set(t.id, t)
    return m
  }, [tasks])

  const previewTask = previewTaskId ? tasksMap.get(previewTaskId) : null

  const CANVAS_UI_KEY = 'nexa-image-canvas-ui-i2i-v1'
  const AUTO_STACK_NAME_KEY = 'nexa-image-auto-stack-names-i2i-v1'
  const MANUAL_LAYOUT_KEY = 'nexa-image-manual-layout-i2i-v1'

  const [canvasHydrated, setCanvasHydrated] = useState(false)
  const [namesHydrated, setNamesHydrated] = useState(false)
  const [manualLayoutRaw, setManualLayoutRaw] = useState<any>(null)

  // 画布工具：自动叠放 / 隐藏名称 / 一键刷新（i2i 独立持久化）
  const [autoStackEnabled, setAutoStackEnabled] = useState(() => {
    return false
  })
  const [hideNameEnabled, setHideNameEnabled] = useState(() => {
    return false
  })
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(() => {
    return null
  })

  const [manualRefreshToken, setManualRefreshToken] = useState(0)

  // hydrate: canvas tools / names / manual layout
  useEffect(() => {
    let alive = true
    ;(async () => {
      const p = await kvGetJsonMigrate<any>(CANVAS_UI_KEY, {})
      if (!alive) return
      setAutoStackEnabled(Boolean(p?.autoStackEnabled))
      setHideNameEnabled(Boolean(p?.hideNameEnabled))
      const v = p?.openGroupKey
      setOpenGroupKey(typeof v === 'string' && v.trim() ? v : null)
      setCanvasHydrated(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const p = await kvGetJsonMigrate<any>(AUTO_STACK_NAME_KEY, {})
      if (!alive) return
      setAutoStackNameMap(p && typeof p === 'object' ? p : {})
      setNamesHydrated(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const p = await kvGetJsonMigrate<any>(MANUAL_LAYOUT_KEY, null)
      if (!alive) return
      setManualLayoutRaw(p && typeof p === 'object' ? p : null)
    })()
    return () => {
      alive = false
    }
  }, [manualRefreshToken])

  // 自动叠放文件夹名称：用户可重命名；未命名时显示优化偏好
  const [autoStackNameMap, setAutoStackNameMap] = useState<Record<string, string>>(() => {
    return {}
  })
  const [renamingAutoKey, setRenamingAutoKey] = useState<string | null>(null)
  const [renameAutoValue, setRenameAutoValue] = useState<string>('')

  // 自动叠放开启时：打开“自定义文件夹”的文件夹视图（不退出自动叠放）
  const [openManualFolderId, setOpenManualFolderId] = useState<string | null>(null)

  // 自动叠放下：拖拽把“未分类图片”放入自定义文件夹
  const autoDnDSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )
  const [autoDragActiveId, setAutoDragActiveId] = useState<string | null>(null)

  // 自动叠放下的桌面式选择：框选/多选
  const [autoSelectedIds, setAutoSelectedIds] = useState<string[]>([])
  const autoSelectedSet = useMemo(() => new Set(autoSelectedIds), [autoSelectedIds])
  const autoSurfaceRef = useRef<HTMLDivElement>(null)
  const [autoLasso, setAutoLasso] = useState<{ left: number, top: number, width: number, height: number } | null>(null)
  const autoLassoStartRef = useRef<{ x: number, y: number } | null>(null)
  const autoLassoBaseRef = useRef<Set<string>>(new Set())
  const autoSuppressNextClearClickRef = useRef(false)

  const canvasContentRef = useRef<HTMLDivElement>(null)

  const handleRefreshGrid = () => {
    refreshTasks()
    setOpenGroupKey(null)
    setOpenManualFolderId(null)
    setPreviewTaskId(null)
    setManualRefreshToken(v => v + 1)
  }

  const handleClearTasks = async () => {
    if (!tasks.length) return
    const ok = await uiConfirm('确定要清空当前画布上的所有图片任务吗？', '清空画布')
    if (!ok) return
    clearTasksByMode('i2i')
    setOpenGroupKey(null)
    setOpenManualFolderId(null)
    setPreviewTaskId(null)
    setManualRefreshToken(v => v + 1)
  }

  const handleDeleteTask = (id: string) => {
    if (previewTaskId === id) setPreviewTaskId(null)
    deleteTask(id)
  }

  // 从创意库返回后，一次性写入 Prompt / 优化偏好
  useEffect(() => {
    hydrateTasks()
    const pending = takePendingPromptLink('i2i')
    if (!pending) return
    if (pending.target === 'prompt') {
      setPrompt(pending.text)
    } else {
      setInjectOptimizeCustomText(pending.text)
    }
  }, [])

  // 画布工具持久化
  useEffect(() => {
    if (!canvasHydrated) return
    const t = window.setTimeout(() => {
      void kvSetJson(CANVAS_UI_KEY, { autoStackEnabled, hideNameEnabled, openGroupKey })
    }, 320)
    return () => window.clearTimeout(t)
  }, [canvasHydrated, autoStackEnabled, hideNameEnabled, openGroupKey])

  useEffect(() => {
    if (!namesHydrated) return
    const t = window.setTimeout(() => {
      void kvSetJson(AUTO_STACK_NAME_KEY, autoStackNameMap)
    }, 360)
    return () => window.clearTimeout(t)
  }, [namesHydrated, autoStackNameMap])

  // 手动文件夹（用户自建）在自动叠放模式下也需要显示
  const manualLayoutInfoForAuto = useMemo(() => {
    const parsed = manualLayoutRaw
    if (!parsed || typeof parsed !== 'object') {
      return { folders: [] as { id: string, name: string, count: number, coverUrl?: string }[], taskIdSet: new Set<string>() }
    }
    const root: string[] = Array.isArray((parsed as any)?.root) ? (parsed as any).root : []
    const foldersObj = (parsed as any)?.folders && typeof (parsed as any).folders === 'object' ? (parsed as any).folders : {}

    const out: { id: string, name: string, count: number, coverUrl?: string }[] = []
    const allTaskIds = new Set<string>()
    for (const node of root) {
      const m = /^folder:(.+)$/.exec(String(node))
      if (!m) continue
      const fid = m[1]
      const f = (foldersObj as any)[fid]
      if (!f) continue
      const taskIds: string[] = Array.isArray((f as any).taskIds) ? (f as any).taskIds : []
      taskIds.forEach(id => allTaskIds.add(id))

      const customName = (typeof (f as any).name === 'string' ? (f as any).name : '').trim()
      let displayName = customName
      if (!displayName) {
        const prefs = taskIds
          .map(id => tasks.find(t => t.id === id))
          .map(t => (t?.optimizePreference || '').trim())
          .filter(Boolean) as string[]
        const uniq = Array.from(new Set(prefs))
        displayName = uniq.length === 1 ? uniq[0] : '文件夹'
      }

      const coverTask = taskIds.map(id => tasks.find(t => t.id === id)).find(t => t?.status === 'success' && t?.url)

      out.push({ id: fid, name: displayName, count: taskIds.length, coverUrl: (coverTask as any)?.url })
    }
    return { folders: out, taskIdSet: allTaskIds }
  }, [tasks, manualLayoutRaw])

  const manualFoldersForAuto = manualLayoutInfoForAuto.folders
  const manualTaskIdSetForAuto = manualLayoutInfoForAuto.taskIdSet

  const openManualFolder = useMemo(() => {
    if (!openManualFolderId) return null
    return manualFoldersForAuto.find(f => f.id === openManualFolderId) || null
  }, [openManualFolderId, manualFoldersForAuto])

  useEffect(() => {
    if (!autoStackEnabled) {
      setOpenManualFolderId(null)
      return
    }
    if (openManualFolderId && !openManualFolder) {
      setOpenManualFolderId(null)
    }
  }, [autoStackEnabled, openManualFolderId, openManualFolder])

  const autoDraggingTask = useMemo(() => {
    if (!autoDragActiveId) return null
    const m = /^task:(.+)$/.exec(autoDragActiveId)
    if (!m) return null
    return tasks.find(t => t.id === m[1]) || null
  }, [autoDragActiveId, tasks])

  const moveTasksIntoManualFolder = async (folderId: string, taskIds: string[]) => {
    // 只移动成功图片
    const ok = taskIds.filter(id => {
      const t = tasks.find(x => x.id === id)
      return Boolean(t && t.status === 'success' && t.url)
    })
    if (ok.length === 0) return

    const parsed = await kvGetJsonMigrate<any>(MANUAL_LAYOUT_KEY, null)
    if (!parsed || typeof parsed !== 'object') return
    const root: string[] = Array.isArray((parsed as any)?.root) ? (parsed as any).root : []
    const foldersObj = (parsed as any)?.folders && typeof (parsed as any).folders === 'object' ? (parsed as any).folders : {}
    const f = (foldersObj as any)[folderId]
    if (!f) return

    // 从 root 移除这些 task node（如果存在）
    const root2 = root.filter(n => {
      const m = /^task:(.+)$/.exec(String(n))
      if (!m) return true
      return !ok.includes(m[1])
    })

    // 从所有文件夹里先去重（避免重复出现）
    for (const fv of Object.values(foldersObj as any)) {
      if (!fv || typeof fv !== 'object') continue
      if (Array.isArray((fv as any).taskIds)) {
        ;(fv as any).taskIds = (fv as any).taskIds.filter((id: string) => !ok.includes(id))
      }
    }

    const existing = new Set(Array.isArray((f as any).taskIds) ? (f as any).taskIds : [])
    const appended = ok.filter(id => !existing.has(id))
    ;(f as any).taskIds = [...(Array.isArray((f as any).taskIds) ? (f as any).taskIds : []), ...appended]

    const updated = { ...parsed, root: root2, folders: foldersObj }
    await kvSetJson(MANUAL_LAYOUT_KEY, updated)
    setManualLayoutRaw(updated)
    setManualRefreshToken(v => v + 1)
  }

  // 自动叠放：按优化偏好聚合
  const stackGroups = useMemo(() => {
    const success = tasks.filter(t => t.status === 'success' && t.url && !manualTaskIdSetForAuto.has(t.id))
    const map = new Map<string, { key: string, pref: string, items: any[], last: number }>()

    for (const t of success) {
      const pref = (t.optimizePreference || '').trim()
      if (!pref) continue
      const key = makeGroupKey(pref)
      const ts = (t as any).createdAt || Date.now()
      const cur = map.get(key)
      if (!cur) map.set(key, { key, pref, items: [t], last: ts })
      else {
        cur.items.push(t)
        cur.last = Math.max(cur.last, ts)
      }
    }

    return Array.from(map.values())
      .filter(g => g.items.length >= 2)
      .sort((a, b) => b.last - a.last)
  }, [tasks, manualTaskIdSetForAuto])

  const stackGroupKeySet = useMemo(() => new Set(stackGroups.map(g => g.key)), [stackGroups])
  const openGroup = useMemo(() => {
    if (!openGroupKey) return null
    return stackGroups.find(g => g.key === openGroupKey) || null
  }, [openGroupKey, stackGroups])

  // 如果记住的 openGroupKey 已不存在（例如删除了图片导致分组不足 2 张），自动退出文件夹
  useEffect(() => {
    if (!openGroupKey) return
    if (!autoStackEnabled) return
    if (!stackGroupKeySet.has(openGroupKey)) setOpenGroupKey(null)
  }, [openGroupKey, autoStackEnabled, stackGroupKeySet])

  const autoVisibleSuccessIds = useMemo(() => {
    if (!autoStackEnabled) return [] as string[]
    if (openGroupKey) {
      return tasks
        .filter(t => t.status === 'success' && t.url && makeGroupKey((t.optimizePreference || '').trim()) === openGroupKey)
        .map(t => t.id)
    }

    // 根视图：只允许选择当前可见的“成功且未被自动打包进文件夹”的图片
    return tasks
      .filter(t => {
        if (t.status !== 'success' || !t.url) return false
        if (manualTaskIdSetForAuto.has(t.id)) return false
        const pref = (t.optimizePreference || '').trim()
        if (!pref) return true
        const key = makeGroupKey(pref)
        return !stackGroupKeySet.has(key)
      })
      .map(t => t.id)
  }, [autoStackEnabled, openGroupKey, tasks, stackGroupKeySet, manualTaskIdSetForAuto])

  // 自动叠放根视图下的“未分类图片”：不属于“按优化偏好叠放”，也不在自定义文件夹
  const autoUnclassifiedTasks = useMemo(() => {
    if (!autoStackEnabled) return [] as any[]
    if (openGroupKey) return [] as any[]
    if (openManualFolderId) return [] as any[]

    return tasks.filter(t => {
      if (t.status !== 'success' || !t.url) return false
      if (manualTaskIdSetForAuto.has(t.id)) return false
      const pref = (t.optimizePreference || '').trim()
      if (pref) {
        const key = makeGroupKey(pref)
        if (stackGroupKeySet.has(key)) return false
      }
      return true
    })
  }, [autoStackEnabled, openGroupKey, openManualFolderId, tasks, manualTaskIdSetForAuto, stackGroupKeySet])

  // 自动叠放根视图：生成中任务也要展示
  const autoGeneratingTasks = useMemo(() => {
    if (!autoStackEnabled) return [] as any[]
    if (openGroupKey) return [] as any[]
    if (openManualFolderId) return [] as any[]
    return tasks.filter(t => t.status === 'loading')
  }, [autoStackEnabled, openGroupKey, openManualFolderId, tasks])

  // 自动叠放视图切换时，清理框选状态
  useEffect(() => {
    setAutoSelectedIds([])
    setAutoLasso(null)
    autoLassoStartRef.current = null
  }, [autoStackEnabled, openGroupKey])

  const getAutoFolderName = (key: string, pref: string): string => {
    const n = (autoStackNameMap[key] || '').trim()
    return n ? n : (pref || '')
  }

  const startRenameAutoFolder = (key: string, pref: string) => {
    setRenamingAutoKey(key)
    setRenameAutoValue(getAutoFolderName(key, pref))
  }

  const commitRenameAutoFolder = () => {
    if (!renamingAutoKey) return
    const v = (renameAutoValue || '').trim()
    setAutoStackNameMap(prev => ({ ...prev, [renamingAutoKey]: v }))
    setRenamingAutoKey(null)
    setRenameAutoValue('')
  }

  const autoClearSelection = () => setAutoSelectedIds([])
  const autoToggleSelect = (id: string) => {
    setAutoSelectedIds(prev => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      return Array.from(set)
    })
  }
  const autoSelectSingle = (id: string) => setAutoSelectedIds([id])
  const autoSelectRange = (id: string, visibleIds: string[]) => {
    if (autoSelectedIds.length === 0) {
      autoSelectSingle(id)
      return
    }
    const anchor = autoSelectedIds[autoSelectedIds.length - 1]
    const a = visibleIds.indexOf(anchor)
    const b = visibleIds.indexOf(id)
    if (a < 0 || b < 0) {
      autoSelectSingle(id)
      return
    }
    const [from, to] = a <= b ? [a, b] : [b, a]
    const slice = visibleIds.slice(from, to + 1)
    setAutoSelectedIds(Array.from(new Set([...autoSelectedIds, ...slice])))
  }
  const autoOnTaskClick = (e: React.MouseEvent, id: string, visibleIds: string[]) => {
    e.stopPropagation()
    if (e.shiftKey) {
      autoSelectRange(id, visibleIds)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      autoToggleSelect(id)
      return
    }
    autoSelectSingle(id)
  }

  const autoRectsIntersect = (a: DOMRect, b: DOMRect): boolean => {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
  }
  const autoBeginLasso = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.ig-result-card') || target.closest('button') || target.closest('.ig-result-card-delete')) return
    autoLassoStartRef.current = { x: e.clientX, y: e.clientY }
    autoLassoBaseRef.current = (e.ctrlKey || e.metaKey) ? new Set(autoSelectedIds) : new Set()
    setAutoLasso({ left: e.clientX, top: e.clientY, width: 0, height: 0 })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const autoUpdateLasso = (e: React.PointerEvent, visibleIds: string[]) => {
    const start = autoLassoStartRef.current
    if (!start) return
    const x1 = start.x
    const y1 = start.y
    const x2 = e.clientX
    const y2 = e.clientY
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const right = Math.max(x1, x2)
    const bottom = Math.max(y1, y2)
    setAutoLasso({ left, top, width: right - left, height: bottom - top })

    const base = autoLassoBaseRef.current
    const next = new Set(base)
    const rect = new DOMRect(left, top, right - left, bottom - top)
    const surface = autoSurfaceRef.current
    if (!surface) return
    const nodes = surface.querySelectorAll<HTMLElement>('[data-select-task]')
    nodes.forEach(el => {
      const id = el.getAttribute('data-select-task')
      if (!id) return
      if (!visibleIds.includes(id)) return
      const r = el.getBoundingClientRect()
      if (autoRectsIntersect(rect, r)) next.add(id)
    })
    setAutoSelectedIds(Array.from(next))
  }
  const autoEndLasso = (e: React.PointerEvent) => {
    if (!autoLassoStartRef.current) return
    autoLassoStartRef.current = null
    if (autoLasso && (autoLasso.width > 5 || autoLasso.height > 5)) {
      autoSuppressNextClearClickRef.current = true
    }
    setAutoLasso(null)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // 忽略
    }
  }
  const autoHandleSurfaceClickClear = () => {
    if (autoSuppressNextClearClickRef.current) {
      autoSuppressNextClearClickRef.current = false
      return
    }
    autoClearSelection()
  }

  // 左键点击“画布空白处”清空选择
  const handleCanvasBlankMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (
      target.closest('.ig-result-card') ||
      target.closest('.ig-context-menu') ||
      target.closest('.ig-canvas-toptools') ||
      target.closest('.ig-top-toolbar') ||
      target.closest('.ig-bottom-action-bar') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('button')
    ) {
      return
    }
    if (canvasContentRef.current && !canvasContentRef.current.contains(target)) return

    // 先清空手动文件夹/手动网格的选择（无论当前是否自动叠放）
    window.dispatchEvent(new CustomEvent('nexa-image-clear-selection-v1'))

    if (autoStackEnabled) {
      if (openManualFolderId) return
      if (autoLassoStartRef.current) return
      setAutoSelectedIds([])
    }
  }

  // 右键菜单：把“自动叠放/隐藏名称/一键刷新”放进菜单
  const [canvasMenu, setCanvasMenu] = useState<{ open: boolean, x: number, y: number }>(
    { open: false, x: 0, y: 0 }
  )

  const handleCanvasContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (
      target.closest('.ig-result-card') ||
      target.closest('.ig-context-menu') ||
      target.closest('.ig-top-toolbar') ||
      target.closest('.ig-bottom-action-bar') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('button')
    ) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    setCanvasMenu({ open: true, x: e.clientX, y: e.clientY })
  }

  const canvasMenuItems = useMemo(() => {
    if (!canvasMenu.open) return [] as any[]
    return [
      { id: 'cm_label', kind: 'label', label: '画布工具' },
      { id: 'cm_sep0', kind: 'separator' },
      {
        id: 'cm_autostack',
        label: '自动叠放',
        rightText: autoStackEnabled ? '开' : '关',
        onClick: () => {
          setAutoStackEnabled(v => !v)
          setOpenGroupKey(null)
          setOpenManualFolderId(null)
        }
      },
      {
        id: 'cm_hidename',
        label: '隐藏名称',
        rightText: hideNameEnabled ? '开' : '关',
        onClick: () => setHideNameEnabled(v => !v)
      },
      { id: 'cm_sep1', kind: 'separator' },
      { id: 'cm_refresh', label: '一键刷新', rightText: 'R', onClick: () => handleRefreshGrid() }
    ]
  }, [canvasMenu.open, autoStackEnabled, hideNameEnabled, handleRefreshGrid])

  const ratios = ['Auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9']

  const getSizeFromRatioAndRes = (ratioStr: string, resStr: string): string => {
    let base = 1024
    if (resStr === '2K') base = 2048
    if (resStr === '4K') base = 4096
    if (ratioStr === 'Auto') return `${base}x${base}`
    const [wStr, hStr] = ratioStr.split(':')
    const w = parseInt(wStr, 10)
    const h = parseInt(hStr, 10)
    if (!w || !h) return `${base}x${base}`
    let width: number
    let height: number
    if (w >= h) {
      width = base
      height = Math.round(base * h / w)
    } else {
      height = base
      width = Math.round(base * w / h)
    }
    width = Math.round(width / 8) * 8
    height = Math.round(height / 8) * 8
    return `${width}x${height}`
  }

  function parseSizeStr(size?: string): { w: number, h: number } | null {
    if (!size) return null
    const m = /^\s*(\d{2,5})\s*x\s*(\d{2,5})\s*$/.exec(size)
    if (!m) return null
    const w = parseInt(m[1], 10)
    const h = parseInt(m[2], 10)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
    return { w, h }
  }

  function gcd(a: number, b: number): number {
    let x = Math.abs(a)
    let y = Math.abs(b)
    while (y) {
      const t = x % y
      x = y
      y = t
    }
    return x || 1
  }

  const KNOWN_RATIOS: Array<{ label: string, w: number, h: number }> = [
    { label: '1:1', w: 1, h: 1 },
    { label: '3:4', w: 3, h: 4 },
    { label: '4:3', w: 4, h: 3 },
    { label: '9:16', w: 9, h: 16 },
    { label: '16:9', w: 16, h: 9 },
    { label: '2:3', w: 2, h: 3 },
    { label: '3:2', w: 3, h: 2 },
    { label: '4:5', w: 4, h: 5 },
    { label: '5:4', w: 5, h: 4 },
    { label: '21:9', w: 21, h: 9 }
  ]

  function formatNiceRatio(w: number, h: number): string {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '-'
    const r = w / h
    let best: { label: string, diff: number } | null = null
    for (const k of KNOWN_RATIOS) {
      const kr = k.w / k.h
      const diff = Math.abs(r - kr)
      if (!best || diff < best.diff) best = { label: k.label, diff }
    }
    if (best && best.diff < 0.02) return best.label
    const g = gcd(w, h)
    const rw = Math.round(w / g)
    const rh = Math.round(h / g)
    if (rw > 0 && rh > 0 && rw <= 99 && rh <= 99) return `${rw}:${rh}`
    return `${r.toFixed(3)}:1`
  }

  function getFileNameFromPath(p: string): string {
    const s = p.replace(/\\/g, '/')
    const idx = s.lastIndexOf('/')
    return idx >= 0 ? s.slice(idx + 1) : s
  }

  function tryGetLocalFilePathFromUrl(url: string): string | null {
    try {
      const u = new URL(url)
      if (u.protocol !== 'nexa:') return null
      if (u.hostname === 'local') {
        return u.searchParams.get('path')
      }
      const p = (u.pathname || '').replace(/^\/+/, '')
      return p ? decodeURIComponent(p) : null
    } catch {
      return null
    }
  }

  const pickFile = () => {
    if (!fileInputRef.current) return
    fileInputRef.current.value = ''
    fileInputRef.current.click()
  }

  const clearInputImages = async () => {
    if (inputImages.length === 0) return
    const ok = await uiConfirm('确定要清空已上传的参考图片吗？', '清空参考图')
    if (!ok) return
    setInputImages([])
  }

  const readImageFile = async (file: File) => {
    const name = file.name || 'image'
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('read failed'))
      reader.readAsDataURL(file)
    })
    const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl)
    if (!m) throw new Error('不支持的图片格式')
    const base64 = m[2]
    return { id: makeRefId(), dataUrl, base64, name }
  }

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files || []).filter(Boolean)
    if (list.length === 0) return

    const remain = Math.max(0, MAX_INPUT_IMAGES - inputImages.length)
    if (remain <= 0) {
      uiToast('info', `最多上传 ${MAX_INPUT_IMAGES} 张图片`)
      return
    }

    const toAdd = list.slice(0, remain)
    const next: Array<{ id: string, dataUrl: string, base64: string, name: string }> = []
    for (const f of toAdd) {
      try {
        next.push(await readImageFile(f))
      } catch (e: any) {
        // 单张失败不影响其它
        console.warn('read file failed', e)
      }
    }

    if (next.length === 0) {
      uiToast('error', '读取图片失败')
      return
    }

    setInputImages(prev => [...prev, ...next].slice(0, MAX_INPUT_IMAGES))
  }

  const handleGenerateClick = () => {
    if (inputImages.length === 0) {
      uiToast('info', '请先上传参考图片')
      return
    }
    if (!prompt.trim()) {
      uiToast('info', '请先输入提示词')
      return
    }
    if (!activeProvider) {
      uiToast('info', '请先在设置中选择或配置 API 网站')
      return
    }
    if (!currentImageModel) {
      uiToast('info', '请先选择生图模型')
      return
    }

    const imageApiKey = resolveApiKey(activeProvider, 'image')
    if (!imageApiKey) {
      uiToast('error', '请先在设置中配置“生图 Key”')
      return
    }

    const targetSize = getSizeFromRatioAndRes(ratio, res)
    enqueueGenerateBatch({
      mode: 'i2i',
      baseUrl: activeProvider.baseUrl,
      apiKey: imageApiKey,
      model: currentImageModel,
      prompt,
      ratio,
      targetSize,
      imageSize: res,
      optimizePreference,
      batchCount,
      inputImagesBase64: inputImages.map(x => x.base64),
      inputImageNames: inputImages.map(x => x.name),
      saveDir: autoSaveEnabled ? outputDirectory : undefined
    })
  }

  const handleGenerateOne = (args: { promptText: string, ratioValue: string, size?: string }) => {
    if (inputImages.length === 0) {
      uiToast('info', '请先上传参考图片（用于重新制作）')
      return
    }
    if (!activeProvider) {
      uiToast('info', '请先在设置中选择或配置 API 网站')
      return
    }
    if (!currentImageModel) {
      uiToast('info', '请先选择生图模型')
      return
    }

    const imageApiKey = resolveApiKey(activeProvider, 'image')
    if (!imageApiKey) {
      uiToast('error', '请先在设置中配置“生图 Key”')
      return
    }

    const sizeToUse = args.size || getSizeFromRatioAndRes(args.ratioValue, res)
    enqueueGenerateOne({
      mode: 'i2i',
      baseUrl: activeProvider.baseUrl,
      apiKey: imageApiKey,
      model: currentImageModel,
      prompt: args.promptText,
      ratio: args.ratioValue,
      targetSize: sizeToUse,
      imageSize: res,
      optimizePreference,
      inputImagesBase64: inputImages.map(x => x.base64),
      inputImageNames: inputImages.map(x => x.name),
      saveDir: autoSaveEnabled ? outputDirectory : undefined
    })
  }

  const handleBatchDecrease = () => setBatchCount(prev => Math.max(1, prev - 1))
  const handleBatchIncrease = () => setBatchCount(prev => Math.min(10, prev + 1))

  const handleUpdateModel = (type: 'image' | 'prompt', modelName: string) => {
    if (providerId) {
      if (type === 'image') {
        updateProvider(providerId, { selectedImageModel: modelName })
      } else {
        updateProvider(providerId, { selectedPromptModel: modelName })
      }
    } else {
      uiToast('info', '请先在全局设置中添加并选中一个 API 网站')
    }
  }

  const handleOptimizePromptClick = async () => {
    if (!prompt.trim()) {
      uiToast('info', '请先输入你要优化的原始提示词')
      return
    }
    if (!activeProvider) {
      uiToast('info', '请先在设置中选择或配置 API 网站')
      return
    }
    if (!currentPromptModel) {
      uiToast('info', '请在左下角选择用于“优化”的提示词模型')
      return
    }

    const promptApiKey = resolveApiKey(activeProvider, 'prompt')
    if (!promptApiKey) {
      uiToast('error', '请先在设置中配置“优化 Key”')
      return
    }

    setIsOptimizing(true)
    try {
      const optimizedText = await optimizePrompt(
        activeProvider.baseUrl,
        promptApiKey,
        currentPromptModel,
        prompt,
        optimizePreference
      )
      setPrompt(optimizedText)
    } catch (error: any) {
      uiToast('error', `优化失败: ${error.message || '未知错误'}`)
    } finally {
      setIsOptimizing(false)
    }
  }

  return (
    <div className="ig-layout">
      {/* 1. 左侧控制面板 (包含图片上传区) */}
      <div className="ig-left">
        <div className="ig-panel-block">
          <div className="ig-block-header">
            <span>资源素材</span>

            <div className="ig-block-actions">
              <button
                type="button"
                className="ig-mini-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  clearInputImages()
                }}
                title="一键清空已上传图片"
                disabled={inputImages.length === 0}
                style={{ opacity: inputImages.length === 0 ? 0.5 : 1, cursor: inputImages.length === 0 ? 'not-allowed' : 'pointer' }}
              >
                <Trash2 size={14} />
                清空
              </button>

              <button
                type="button"
                className="ig-mini-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  if (inputImages.length === 0) {
                    pickFile()
                    return
                  }
                  setIsUploadGalleryOpen(true)
                }}
                title={inputImages.length === 0 ? '上传图片' : '展开已上传图片'}
              >
                <LayoutGrid size={14} />
                展开
              </button>
            </div>
          </div>
          {/* 这里是你截图中要求的上传图片区域 */}
          <div
            className="ig-upload-area"
            onClick={pickFile}
            onDragEnter={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(true)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(false)
            }}
            onDrop={async (e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(false)
              try {
                await addFiles(e.dataTransfer?.files || [])
              } catch (err: any) {
                uiToast('error', err?.message || '读取图片失败')
              }
            }}
            style={{
              borderColor: dragOver ? 'rgba(0, 229, 255, 0.55)' : undefined,
              color: dragOver ? '#00e5ff' : undefined
            }}
            title="点击选择图片，或拖拽图片到此区域"
          >
            {inputImages.length > 0 ? (
              <div className="ig-upload-scroll" onClick={(e) => e.stopPropagation()}>
                {inputImages.length < MAX_INPUT_IMAGES && (
                  <button
                    type="button"
                    className="ig-upload-plus"
                    onClick={(e) => {
                      e.stopPropagation()
                      pickFile()
                    }}
                    title="继续添加图片"
                  >
                    <Plus size={18} />
                    添加
                  </button>
                )}

                {inputImages.map((img, idx) => (
                  <div key={`${img.name}_${idx}`} className="ig-upload-thumb" title={img.name}>
                    <img src={img.dataUrl} alt={img.name} />
                    <button
                      type="button"
                      className="ig-upload-remove"
                      onClick={(e) => {
                        e.stopPropagation()
                        setInputImages(prev => prev.filter((_, i) => i !== idx))
                      }}
                      title="移除"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <Plus size={32} />
                <span style={{ marginTop: 8, fontSize: '0.9rem' }}>上传图片</span>
                <span style={{ fontSize: '0.75rem', marginTop: 4 }}>可拖拽图片到此区域（最多 20 张）</span>
              </>
            )}

            {inputImages.length > 0 && (
              <div className="ig-upload-count">{inputImages.length}/{MAX_INPUT_IMAGES}</div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={async (e) => {
                try {
                  await addFiles(e.target.files || [])
                } catch (err: any) {
                  uiToast('error', err?.message || '读取图片失败')
                }
              }}
            />
          </div>
        </div>

        <div className="ig-panel-block">
          <div className="ig-block-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ImageIcon size={18} color="#5b6df0" />
              <span>参数配置 (图生图)</span>
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: '0.8rem', color: '#8e94a8', marginBottom: 8 }}>画面比例</div>
            <div className="ig-pill-group">
              {ratios.map(r => (
                <div key={r} className={`ig-pill ${ratio === r ? 'active' : ''}`} onClick={() => setRatio(r)}>
                  {r}
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: '0.8rem', color: '#8e94a8', marginBottom: 8 }}>分辨率</div>
            <div className="ig-pill-group">
              {['1K', '2K', '4K'].map(r => (
                <div key={r} className={`ig-pill ${res === r ? 'active' : ''}`} onClick={() => setRes(r)}>
                  {r}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 提示词输入区块与优化按钮 */}
        <div className="ig-panel-block">
          <div className="ig-block-header">
            <span>提示词</span>
            <div className="ig-block-actions">
              <button
                type="button"
                className="ig-mini-btn"
                onClick={() => setPrompt('')}
                disabled={!prompt.trim() || isOptimizing}
                title="清空提示词"
              >
                清空
              </button>
              <button
                className="ig-optimize-btn"
                onClick={handleOptimizePromptClick}
                disabled={isOptimizing || !prompt.trim()}
                style={{
                  opacity: (isOptimizing || !prompt.trim()) ? 0.5 : 1,
                  cursor: (isOptimizing || !prompt.trim()) ? 'not-allowed' : 'pointer'
                }}
              >
                {isOptimizing ? '优化中...' : '优化'}
              </button>
            </div>
          </div>
          <textarea 
            className="ig-prompt-input" 
            placeholder="请用简单的中文描述你想生成的画面..."
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
          />
        </div>

        {/* 新功能：提示词优化系统提示词预设 */}
        <OptimizeSystemPromptEditor
          providerId={providerId}
          scopeKey="i2i"
          onPreferenceChange={(v) => setOptimizePreference(v)}
          injectCustomText={injectOptimizeCustomText}
          onInjectedCustomTextConsumed={() => setInjectOptimizeCustomText('')}
        />

        {/* 模型选择区域 */}
        <div className="ig-panel-block" style={{ marginTop: 'auto', marginBottom: '8px' }}>
          <CompactModelPicker
            label="生图模型"
            value={currentImageModel}
            placeholder="选择生图模型..."
            icon={<Cpu size={14} />}
            pinned={pinnedImageModels}
            models={availableModels}
            onSelect={(m: string) => handleUpdateModel('image', m)}
          />

          <CompactModelPicker
            label="提示词优化模型"
            value={currentPromptModel}
            placeholder="选择优化模型..."
            icon={<SearchCode size={14} />}
            pinned={pinnedPromptModels}
            models={availableModels}
            onSelect={(m: string) => handleUpdateModel('prompt', m)}
          />
        </div>

      </div>

      {/* 2. 中间主画布区 */}
      <div className="ig-center">
        {/* 顶部功能切换 */}
        <div className="ig-top-toolbar">
          <button className="ig-toolbar-btn" onClick={() => onSwitchMode('t2i')}>
            <ImageIcon size={16} /> 文字生图
          </button>
          <button className="ig-toolbar-btn active">
            <FolderOpen size={16} /> 图像改图
          </button>
          <button className="ig-toolbar-btn" onClick={() => onSwitchMode('library')}>
            <LibraryIcon size={16} /> 创意库
          </button>
        </div>

        {/* 右上角画布工具 */}
        <div className="ig-canvas-toptools" aria-label="画布工具">
          <button
            type="button"
            className={`ig-tool-btn ${autoStackEnabled ? 'active' : ''}`}
            onClick={() => {
              setAutoStackEnabled(v => !v)
              setOpenGroupKey(null)
              setOpenManualFolderId(null)
            }}
            title="自动叠放：把相同优化偏好下的成功图片打包成文件夹"
          >
            自动叠放
          </button>
          <button
            type="button"
            className={`ig-tool-btn ${hideNameEnabled ? 'active' : ''}`}
            onClick={() => setHideNameEnabled(v => !v)}
            title="隐藏名称：隐藏图片/文件夹下方的文字"
          >
            隐藏名称
          </button>
          <button
            type="button"
            className="ig-tool-btn"
            onClick={handleRefreshGrid}
            title="一键刷新：重新加载并整理图片展示"
          >
            一键刷新
          </button>
        </div>

        <div
          className="ig-canvas-content"
          ref={canvasContentRef}
          onMouseDown={handleCanvasBlankMouseDown}
          onContextMenu={handleCanvasContextMenu}
        >
          {/* 自动叠放开启时：自定义文件夹内部视图（不退出自动叠放） */}
          {autoStackEnabled && openManualFolderId && (
            <ManualFolderGrid
              tasks={tasks}
              hideNameEnabled={hideNameEnabled}
              refreshToken={manualRefreshToken}
              storageKey={MANUAL_LAYOUT_KEY}
              onDeleteTask={handleDeleteTask}
              onOpenPreview={(id) => {
                setPreviewTaskId(id)
                setPreviewMsg('')
              }}
              onPatchTask={patchTask as any}
              onRemakeOne={(t) => {
                handleGenerateOne({ promptText: t.prompt, ratioValue: t.ratio || ratio, size: t.targetSize })
              }}
              canvasTools={{
                autoStackEnabled,
                hideNameEnabled,
                onToggleAutoStack: () => {
                  setAutoStackEnabled(v => !v)
                  setOpenGroupKey(null)
                  setOpenManualFolderId(null)
                },
                onToggleHideName: () => setHideNameEnabled(v => !v),
                onRefresh: () => handleRefreshGrid()
              }}
              initialOpenFolderId={openManualFolderId}
              lockToFolderId={openManualFolderId}
              onExitFolder={() => setOpenManualFolderId(null)}
              showRoot={false}
              folderHeaderPrefix="文件夹"
            />
          )}

          {/* 自动叠放根视图：自定义文件夹 + 按偏好叠放 + 未分类 */}
          {autoStackEnabled && !openManualFolderId && !openGroupKey && (
            <DndContext
              sensors={autoDnDSensors}
              onDragStart={(e) => setAutoDragActiveId(String(e.active.id))}
              onDragCancel={() => setAutoDragActiveId(null)}
              onDragEnd={(e) => {
                setAutoDragActiveId(null)
                const activeId = String(e.active.id)
                const overId = e.over ? String(e.over.id) : ''
                const am = /^task:(.+)$/.exec(activeId)
                const om = /^mf:(.+)$/.exec(overId)
                if (!am || !om) return
                void moveTasksIntoManualFolder(om[1], [am[1]])
              }}
            >
              {autoGeneratingTasks.length > 0 && (
                <div style={{ width: '100%' }}>
                  <div className="ig-stack-title">生成中</div>
                  <div className="ig-results-grid">
                    {autoGeneratingTasks.map(task => (
                      <AutoDraggableTaskCard
                        key={task.id}
                        task={task}
                        selected={false}
                        hideNameEnabled={hideNameEnabled}
                        onDelete={() => handleDeleteTask(task.id)}
                        onOpenPreview={() => {}}
                        onSelect={() => {}}
                        onPatch={(patch) => patchTask(task.id, patch as any)}
                      />
                    ))}
                  </div>
                  <div className="ig-stack-divider" />
                </div>
              )}

              {manualFoldersForAuto.length > 0 && (
                <div style={{ width: '100%' }}>
                  <div className="ig-stack-title">自定义文件夹</div>
                  <div className="ig-results-grid">
                    {manualFoldersForAuto.map(f => (
                      <AutoManualFolderCard
                        key={f.id}
                        id={f.id}
                        name={f.name}
                        count={f.count}
                        coverUrl={f.coverUrl}
                        hideNameEnabled={hideNameEnabled}
                        onOpen={() => {
                          setOpenGroupKey(null)
                          setOpenManualFolderId(f.id)
                        }}
                        dragging={Boolean(autoDraggingTask && autoDraggingTask.status === 'success' && autoDraggingTask.url)}
                      />
                    ))}
                  </div>
                  <div className="ig-stack-divider" />
                </div>
              )}

              {stackGroups.length > 0 && (
                <div style={{ width: '100%' }}>
                  <div className="ig-stack-title">按优化偏好叠放</div>
                  <div className="ig-results-grid">
                    {stackGroups.map(g => (
                      <div key={g.key} className="ig-result-wrapper">
                        <div
                          className="ig-result-card ig-folder-card"
                          onDoubleClick={() => setOpenGroupKey(g.key)}
                          title={g.pref}
                        >
                          <div className="ig-folder-badge">{g.items.length}</div>
                          <button
                            type="button"
                            className="ig-folder-rename"
                            title="重命名文件夹"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation()
                              startRenameAutoFolder(g.key, g.pref)
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <img src={g.items[0].url!} alt="folder" className="ig-result-img" />
                          <div className="ig-folder-overlay">
                            <div className="ig-folder-title">{shortText(getAutoFolderName(g.key, g.pref), 18) || '优化偏好'}</div>
                          </div>
                        </div>
                        {!hideNameEnabled && (
                          <div className="ig-result-prompt" title={getAutoFolderName(g.key, g.pref)}>{shortText(getAutoFolderName(g.key, g.pref), 42)}</div>
                        )}

                        {renamingAutoKey === g.key && (
                          <div className="ig-rename-row" onClick={(e) => e.stopPropagation()}>
                            <input
                              className="ig-rename-input"
                              value={renameAutoValue}
                              onChange={(e) => setRenameAutoValue(e.target.value)}
                              placeholder="输入文件夹名称（留空=使用优化偏好名称）"
                              autoFocus
                              onPointerDown={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRenameAutoFolder()
                                if (e.key === 'Escape') {
                                  setRenamingAutoKey(null)
                                  setRenameAutoValue('')
                                }
                              }}
                              onBlur={() => commitRenameAutoFolder()}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="ig-stack-divider" />
                </div>
              )}

              <div style={{ width: '100%' }}>
                <div className="ig-stack-title">未分类</div>
                <div
                  className="ig-select-fill"
                  ref={autoSurfaceRef}
                  onPointerDown={autoBeginLasso}
                  onPointerMove={(e) => autoUpdateLasso(e, autoVisibleSuccessIds)}
                  onPointerUp={autoEndLasso}
                  onPointerCancel={autoEndLasso}
                  onClick={autoHandleSurfaceClickClear}
                >
                  {autoLasso && (
                    <div
                      className="ig-lasso"
                      style={{ left: autoLasso.left, top: autoLasso.top, width: autoLasso.width, height: autoLasso.height }}
                    />
                  )}

                  <div className="ig-results-grid ig-select-surface">
                    {autoUnclassifiedTasks.map(task => (
                      <AutoDraggableTaskCard
                        key={task.id}
                        task={task}
                        selected={autoSelectedSet.has(task.id)}
                        hideNameEnabled={hideNameEnabled}
                        onDelete={() => handleDeleteTask(task.id)}
                        onOpenPreview={() => {
                          setPreviewTaskId(task.id)
                          setPreviewMsg('')
                        }}
                        onSelect={(e: React.MouseEvent) => autoOnTaskClick(e, task.id, autoVisibleSuccessIds)}
                        onPatch={(patch) => patchTask(task.id, patch as any)}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <DragOverlay>
                {autoDraggingTask && autoDraggingTask.status === 'success' && autoDraggingTask.url ? (
                  <div className="ig-dnd-overlay">
                    <img src={autoDraggingTask.url} alt="drag" />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}

          {autoStackEnabled && openGroupKey && (
            <div className="ig-stack-head">
              <button type="button" className="ig-tool-btn" onClick={() => setOpenGroupKey(null)}>返回</button>
              <div className="ig-stack-path">文件夹：{shortText(getAutoFolderName(openGroupKey, openGroup?.pref || openGroupKey), 64)}</div>
            </div>
          )}

          {/* 自动叠放打开某个“按优化偏好叠放”文件夹时：显示该组图片 */}
          {autoStackEnabled && !openManualFolderId && openGroupKey && (
            <div
              className="ig-select-fill"
              ref={autoSurfaceRef}
              onPointerDown={autoBeginLasso}
              onPointerMove={(e) => autoUpdateLasso(e, autoVisibleSuccessIds)}
              onPointerUp={autoEndLasso}
              onPointerCancel={autoEndLasso}
              onClick={autoHandleSurfaceClickClear}
            >
              {autoLasso && (
                <div
                  className="ig-lasso"
                  style={{ left: autoLasso.left, top: autoLasso.top, width: autoLasso.width, height: autoLasso.height }}
                />
              )}

              <div className="ig-results-grid ig-select-surface">
                {tasks
                  .filter(t => t.status === 'success' && t.url && !manualTaskIdSetForAuto.has(t.id) && makeGroupKey((t.optimizePreference || '').trim()) === openGroupKey)
                  .map(task => (
                    <AutoDraggableTaskCard
                      key={task.id}
                      task={task}
                      selected={autoSelectedSet.has(task.id)}
                      hideNameEnabled={hideNameEnabled}
                      onDelete={() => handleDeleteTask(task.id)}
                      onOpenPreview={() => {
                        setPreviewTaskId(task.id)
                        setPreviewMsg('')
                      }}
                      onSelect={(e: React.MouseEvent) => autoOnTaskClick(e, task.id, autoVisibleSuccessIds)}
                      onPatch={(patch) => patchTask(task.id, patch as any)}
                    />
                  ))}
              </div>
            </div>
          )}

          {/* 手动网格（自动叠放关闭） */}
          {!autoStackEnabled && (
            <ManualFolderGrid
              tasks={tasks}
              hideNameEnabled={hideNameEnabled}
              refreshToken={manualRefreshToken}
              storageKey={MANUAL_LAYOUT_KEY}
              onDeleteTask={handleDeleteTask}
              onOpenPreview={(id) => {
                setPreviewTaskId(id)
                setPreviewMsg('')
              }}
              onPatchTask={patchTask as any}
              onRemakeOne={(t) => {
                handleGenerateOne({ promptText: t.prompt, ratioValue: t.ratio || ratio, size: t.targetSize })
              }}
              canvasTools={{
                autoStackEnabled,
                hideNameEnabled,
                onToggleAutoStack: () => {
                  setAutoStackEnabled(v => !v)
                  setOpenGroupKey(null)
                  setOpenManualFolderId(null)
                },
                onToggleHideName: () => setHideNameEnabled(v => !v),
                onRefresh: () => handleRefreshGrid()
              }}
            />
          )}

          <ContextMenu
            open={canvasMenu.open}
            x={canvasMenu.x}
            y={canvasMenu.y}
            items={canvasMenuItems as any}
            onClose={() => setCanvasMenu(v => ({ ...v, open: false }))}
          />
        </div>

        {/* 底部悬浮生成操作组 */}
        <div className="ig-bottom-action-bar">
          
          {/* 并发数量选择器 */}
          <div className="ig-batch-control">
            <button className="ig-batch-btn" onClick={handleBatchDecrease}>
              <Minus size={14} />
            </button>
            <span className="ig-batch-value">{batchCount}</span>
            <button className="ig-batch-btn" onClick={handleBatchIncrease}>
              <Plus size={14} />
            </button>
          </div>

          <button
            className="ig-bottom-btn"
            onClick={handleClearTasks}
            title="清空画布"
            style={{ opacity: tasks.length ? 1 : 0.45 }}
            disabled={!tasks.length}
          >
            <Trash2 size={16} /> 清空
          </button>

          {/* 带中文的开始生成按钮 */}
          <button
            className="ig-start-btn"
            onClick={handleGenerateClick}
            style={{
              opacity: (inputImages.length > 0 && prompt.trim()) ? 1 : 0.6,
              cursor: (inputImages.length > 0 && prompt.trim()) ? 'pointer' : 'not-allowed'
            }}
            title={inputImages.length === 0 ? '请先上传参考图片' : (!prompt.trim() ? '请先输入提示词' : '')}
          >
            <Sparkles size={16} />
            开始
          </button>

        </div>

        {/* 侧边栏折叠按钮 (依附在画布右边缘) */}
        <button className="ig-collapse-btn" onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}>
          {isRightPanelOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

      </div>

      {/* 预览模态框 */}
      {previewTask && previewTask.url && (
        <div className={`ig-preview-modal ${previewTaskId ? 'show' : ''}`} onMouseDown={() => setPreviewTaskId(null)}>
          <div className="ig-preview-card" onMouseDown={(e) => e.stopPropagation()}>
            <button className="ig-preview-close" onClick={() => setPreviewTaskId(null)} title="关闭">
              <X size={20} />
            </button>

            <div className="ig-preview-media">
              <img
                src={previewTask.url}
                alt="Preview"
                className="ig-preview-img"
                onLoad={(e) => {
                  const img = e.currentTarget
                  const actual = `${img.naturalWidth}x${img.naturalHeight}`
                  patchTask(previewTask.id, { actualSize: actual })
                }}
              />
            </div>

            <div className="ig-preview-side">
              <div className="ig-preview-side-title">图片操作</div>
              <div className="ig-preview-actions">
                <button
                  type="button"
                  className="ig-preview-btn"
                  onClick={async () => {
                    const url = previewTask.url!
                    const localPath = tryGetLocalFilePathFromUrl(url)
                    if (localPath && window.nexaAPI?.showItemInFolder) {
                      const r = await window.nexaAPI.showItemInFolder({ filePath: localPath })
                      setPreviewMsg(r.success ? '已在资源管理器中定位文件' : '定位文件失败')
                      return
                    }
                    if (window.nexaAPI?.downloadImage && window.nexaAPI?.showItemInFolder) {
                      const fileName = `nexa_${Date.now()}_save`
                      const dl = await window.nexaAPI.downloadImage({ url, saveDir: outputDirectory, fileName })
                      if (!dl.success || !dl.localPath) {
                        setPreviewMsg(`保存失败：${dl.error || '未知错误'}`)
                        return
                      }
                      const p = tryGetLocalFilePathFromUrl(dl.localPath)
                      if (p) {
                        await window.nexaAPI.showItemInFolder({ filePath: p })
                        setPreviewMsg('已保存到本地并打开文件位置')
                        return
                      }
                    }
                    setPreviewMsg('保存失败：当前环境不支持')
                  }}
                  title="保存（下载到本地并定位）"
                >
                  保存
                </button>

                <button
                  type="button"
                  className="ig-preview-btn"
                  onClick={async () => {
                    const url = previewTask.url!
                    if (!window.nexaAPI?.copyImageToClipboard) {
                      setPreviewMsg('复制失败：当前环境不支持')
                      return
                    }
                    const r = await window.nexaAPI.copyImageToClipboard({ url })
                    setPreviewMsg(r.success ? '已复制图片到剪贴板' : `复制失败：${r.error || '未知错误'}`)
                  }}
                  title="复制图片到剪贴板"
                >
                  复制
                </button>

                <button
                  type="button"
                  className="ig-preview-btn"
                  onClick={async () => {
                    const req = previewTask.request
                    if (!req || !req.url) {
                      setPreviewMsg('无请求信息（可能是旧任务或未记录）')
                      return
                    }
                    const text = formatRequestDebugForCopy(req)
                    try {
                      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                      await navigator.clipboard.writeText(text)
                      setPreviewMsg('已复制请求代码（已脱敏）')
                    } catch {
                      uiTextViewer(text, { title: '复制失败，请手动复制（已脱敏）' })
                      setPreviewMsg('复制失败：已弹出手动复制框')
                    }
                  }}
                  title="复制本次调用 API 的请求代码（已脱敏）"
                >
                  复制请求
                </button>

                <button
                  type="button"
                  className="ig-preview-btn primary"
                  onClick={() => {
                    handleGenerateOne({ promptText: previewTask.prompt, ratioValue: previewTask.ratio, size: previewTask.targetSize })
                    setPreviewMsg('已提交重新制作任务（使用当前上传的参考图）')
                  }}
                  title="用相同提示词重新制作 1 张（需要当前仍上传着参考图）"
                >
                  重新制作
                </button>
              </div>

              <div className="ig-preview-debug" aria-label="接口返回调试信息">
                <div className="ig-preview-debug-head">
                  <div className="t">接口返回</div>
                  <button
                    type="button"
                    className="ig-preview-debug-btn"
                    onClick={async () => {
                      const t = previewTask.response?.dataPreview || previewTask.errorMsg || ''
                      if (!t.trim()) {
                        setPreviewMsg('暂无可复制的返回内容')
                        return
                      }
                      try {
                        if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                        await navigator.clipboard.writeText(t)
                        setPreviewMsg('已复制接口返回内容')
                      } catch {
                        uiTextViewer(t, { title: '复制失败，请手动复制' })
                        setPreviewMsg('复制失败：已弹出手动复制框')
                      }
                    }}
                    title="复制接口返回内容"
                  >
                    复制返回
                  </button>
                </div>
                <div className="ig-preview-debug-body">
                  {previewTask.status === 'error'
                    ? (previewTask.errorMsg || '生成失败（无错误信息）')
                    : (previewTask.response?.dataPreview || '暂无（可能是旧任务或未记录）')}
                </div>
              </div>

              <div className="ig-preview-info">
                <div className="ig-preview-info-row">
                  <span className="k">文件</span>
                  <span className="v">{(() => {
                    const local = tryGetLocalFilePathFromUrl(previewTask.url!)
                    if (local) return getFileNameFromPath(local)
                    try {
                      const u = new URL(previewTask.url!)
                      return getFileNameFromPath(u.pathname || previewTask.url!)
                    } catch {
                      return '未知'
                    }
                  })()}</span>
                </div>

                <div className="ig-preview-info-row">
                  <span className="k">参考图</span>
                  <span className="v">{(() => {
                    const names = previewTask.inputImageNames || (previewTask.inputImageName ? [previewTask.inputImageName] : [])
                    if (names.length === 0) {
                      const current = inputImages.map(x => x.name)
                      if (current.length === 0) return '-'
                      return `${current.length} 张`
                    }
                    const shown = names.slice(0, 2).join(', ')
                    return names.length <= 2 ? `${names.length} 张：${shown}` : `${names.length} 张：${shown}...`
                  })()}</span>
                </div>

                <div className="ig-preview-info-row">
                  <span className="k">期望比例</span>
                  <span className="v">{previewTask.ratio || '-'}</span>
                </div>

                <div className="ig-preview-info-row">
                  <span className="k">实际比例</span>
                  <span className="v">{(() => {
                    const s = parseSizeStr(previewTask.actualSize)
                    if (!s) return '-'
                    return formatNiceRatio(s.w, s.h)
                  })()}</span>
                </div>

                <div className="ig-preview-info-row">
                  <span className="k">像素</span>
                  <span className="v">{previewTask.actualSize || '-'}</span>
                </div>

                {previewMsg && (
                  <div className="ig-preview-tip">{previewMsg}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 已上传图片：展开窗口 */}
      {isUploadGalleryOpen && (
        <div className="ig-preview-modal show" onMouseDown={() => setIsUploadGalleryOpen(false)}>
          <div className="ig-upload-modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ig-upload-modal-head">
              <div className="t">已上传图片</div>
              <div className="sub">{inputImages.length}/{MAX_INPUT_IMAGES}</div>
              <div className="sub" style={{ marginLeft: 10 }}>拖拽可排序</div>
              <div className="spacer" />

              <button
                type="button"
                className="ig-mini-btn"
                onClick={() => pickFile()}
                title="继续添加图片"
                disabled={inputImages.length >= MAX_INPUT_IMAGES}
                style={{ opacity: inputImages.length >= MAX_INPUT_IMAGES ? 0.5 : 1, cursor: inputImages.length >= MAX_INPUT_IMAGES ? 'not-allowed' : 'pointer' }}
              >
                <Plus size={14} />
                添加
              </button>

              <button
                type="button"
                className="ig-mini-btn"
                onClick={() => clearInputImages()}
                title="一键清空"
                disabled={inputImages.length === 0}
                style={{ opacity: inputImages.length === 0 ? 0.5 : 1, cursor: inputImages.length === 0 ? 'not-allowed' : 'pointer' }}
              >
                <Trash2 size={14} />
                清空
              </button>

              <button
                type="button"
                className="ig-upload-modal-close"
                onClick={() => setIsUploadGalleryOpen(false)}
                title="关闭"
              >
                <X size={18} />
              </button>
            </div>

            {inputImages.length === 0 ? (
              <div className="ig-upload-modal-empty">
                <div className="t">还没有上传图片</div>
                <div className="d">点击“添加”或把图片拖进来</div>
              </div>
            ) : (
              <DndContext
                sensors={uploadDndSensors}
                onDragEnd={(e: DragEndEvent) => {
                  const { active, over } = e
                  if (!over) return
                  if (active.id === over.id) return
                  setInputImages(prev => {
                    const oldIndex = prev.findIndex(x => x.id === active.id)
                    const newIndex = prev.findIndex(x => x.id === over.id)
                    if (oldIndex < 0 || newIndex < 0) return prev
                    return arrayMove(prev, oldIndex, newIndex)
                  })
                }}
              >
                <SortableContext items={inputImages.map(x => x.id)} strategy={rectSortingStrategy}>
                  <div
                    className="ig-upload-modal-grid"
                    onDragEnter={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onDrop={async (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      try {
                        await addFiles(e.dataTransfer?.files || [])
                      } catch (err: any) {
                        uiToast('error', err?.message || '读取图片失败')
                      }
                    }}
                  >
                    {inputImages.map((img) => (
                      <SortableUploadThumb
                        key={img.id}
                        id={img.id}
                        dataUrl={img.dataUrl}
                        name={img.name}
                        onRemove={() => setInputImages(prev => prev.filter(x => x.id !== img.id))}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>
      )}

      {/* 3. 右侧区域：链接提示词 + 收藏占位 */}
      <div className={`ig-right ${isRightPanelOpen ? '' : 'collapsed'}`}>
        <PromptLinkPanel
          mode="i2i"
          onOpenLibrary={() => onSwitchMode('library')}
          onApplyPrompt={(text) => setPrompt(text)}
          onApplyOptimizeCustom={(text) => setInjectOptimizeCustomText(text)}
        />

        <CreativeCollectionsPanel
          mode="i2i"
          onOpenLibrary={() => onSwitchMode('library')}
          onApplyPrompt={(text) => setPrompt(text)}
          onApplyOptimizeCustom={(text) => setInjectOptimizeCustomText(text)}
        />
      </div>
    </div>
  )
}
