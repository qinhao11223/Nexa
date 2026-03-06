import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Plus, Image as ImageIcon, Settings2, Sparkles, Star, FolderOpen, RefreshCw, Library as LibraryIcon, ChevronRight, ChevronLeft, Minus, Zap, Cpu, SearchCode, Loader2, History, Trash2, X, Maximize2, Check, Pencil } from 'lucide-react'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { ImageGenMode } from '../ImageGen'
import CompactModelPicker from '../components/CompactModelPicker'
import OptimizeSystemPromptEditor from '../components/OptimizeSystemPromptEditor'
import PromptLinkPanel from '../components/PromptLinkPanel'
import ManualFolderGrid from '../components/ManualFolderGrid'
import { AutoDraggableTaskCard, AutoManualFolderCard } from '../components/AutoStackCards'
import ContextMenu from '../components/ContextMenu'
import { useSettingsStore } from '../../settings/store'
import { optimizePrompt } from '../../../core/api/chat'
import { resolveApiKey } from '../../settings/utils/apiKeys'
import { takePendingPromptLink } from '../../creative_library/promptLink'
import { makeGroupKey, shortText } from '../utils/stacking'
import { useImageGenStore, type ImageTask } from '../store'
import { formatRequestDebugForCopy } from '../utils/requestDebug'
import { uiConfirm, uiTextViewer } from '../../ui/dialogStore'
import { uiToast } from '../../ui/toastStore'
import { kvGetJsonMigrate, kvSetJson } from '../../../core/persist/kvClient'

// 定义历史记录的数据结构
interface PromptHistory {
  id: string
  original: string
  optimized?: string
  model: string
  time: number
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
  // 容差：避免因为缩放/取整导致显示成奇怪分数
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
    // 兼容旧格式：nexa:///C:/...
    const p = (u.pathname || '').replace(/^\/+/, '')
    return p ? decodeURIComponent(p) : null
  } catch {
    return null
  }
}

export default function TextToImage({ onSwitchMode }: { onSwitchMode: (mode: ImageGenMode) => void }) {
  const { providers, activeProviderId, imageProviderId, updateProvider, outputDirectory, autoSaveEnabled } = useSettingsStore()
  const providerId = imageProviderId || activeProviderId
  const activeProvider = providers.find(p => p.id === providerId)

  // 生图任务全局 store：修复“生成中切换页面任务丢失”
  const allTasks = useImageGenStore(s => s.tasks)
  const hydrateTasks = useImageGenStore(s => s.hydrateFromStorage)
  const refreshTasks = useImageGenStore(s => s.refreshFromStorage)
  const patchTask = useImageGenStore(s => s.patchTask)
  const deleteTask = useImageGenStore(s => s.deleteTask)
  const clearTasksByMode = useImageGenStore(s => s.clearTasksByMode)
  const enqueueGenerateBatch = useImageGenStore(s => s.enqueueGenerateBatch)
  const enqueueGenerateOne = useImageGenStore(s => s.enqueueGenerateOne)

  const tasks = useMemo(() => {
    return (allTasks || []).filter(t => t.mode === 't2i')
  }, [allTasks])
  
  // 安全提取当前的模型列表和选中的值
  const availableModels = activeProvider?.models || []
  const currentImageModel = activeProvider?.selectedImageModel || ''
  const currentPromptModel = activeProvider?.selectedPromptModel || ''

  // 常用模型预设：用于快速切换，减少每次打开下拉后再搜索
  const pinnedImageModels = activeProvider?.pinnedImageModels || []
  const pinnedPromptModels = activeProvider?.pinnedPromptModels || []

  // 记住上次使用的参数（关闭/重启后仍保留）
  const UI_PARAMS_KEY = 'nexa-image-ui-params-t2i-v1'
  const uiDefaults = useMemo(() => ({ ratio: '1:1', res: '2K', prompt: '', isRightPanelOpen: true, batchCount: 1 }), [])

  const [ratio, setRatio] = useState(uiDefaults.ratio)
  const [res, setRes] = useState(uiDefaults.res)
  const [prompt, setPrompt] = useState(uiDefaults.prompt)
  // 用户输入的“优化偏好提示词”
  const [optimizePreference, setOptimizePreference] = useState<string>('')
  // 从创意库写入的“优化偏好”一次性注入
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

  // 画布工具（参考图四）：自动叠放 / 隐藏名称 / 一键刷新（持久化，避免切换界面后“解散”）
  const [autoStackEnabled, setAutoStackEnabled] = useState(() => {
    return false
  })
  const [hideNameEnabled, setHideNameEnabled] = useState(() => {
    return false
  })
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(() => {
    return null
  })
  // 手动拖拽布局刷新 token：用于“一键刷新”时让网格重新加载布局并关闭文件夹
  const [manualRefreshToken, setManualRefreshToken] = useState(0)

  const CANVAS_UI_KEY = 'nexa-image-canvas-ui-v1'
  const AUTO_STACK_NAME_KEY = 'nexa-image-auto-stack-names-v1'
  const PROMPT_HISTORY_KEY = 'nexa-prompt-history'
  const MANUAL_LAYOUT_KEY = 'nexa-image-manual-layout-v1'

  // 自动叠放文件夹名称：用户可重命名；未命名时显示优化偏好
  const [autoStackNameMap, setAutoStackNameMap] = useState<Record<string, string>>(() => {
    return {}
  })
  const [renamingAutoKey, setRenamingAutoKey] = useState<string | null>(null)
  const [renameAutoValue, setRenameAutoValue] = useState<string>('')

  // 自动叠放模式下的桌面式选择：框选/多选
  const [autoSelectedIds, setAutoSelectedIds] = useState<string[]>([])
  const autoSelectedSet = useMemo(() => new Set(autoSelectedIds), [autoSelectedIds])
  const autoSurfaceRef = useRef<HTMLDivElement>(null)
  const [autoLasso, setAutoLasso] = useState<{ left: number, top: number, width: number, height: number } | null>(null)
  const autoLassoStartRef = useRef<{ x: number, y: number } | null>(null)
  const autoLassoBaseRef = useRef<Set<string>>(new Set())
  const autoSuppressNextClearClickRef = useRef(false)

  // 桌面体验：点击到画布其他区域时取消选中（不要求一定点在网格内部）
  useEffect(() => {
    if (autoSelectedIds.length === 0) return
    const onDown = (e: MouseEvent) => {
      if (autoLassoStartRef.current) return
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('.ig-result-card')) return
      if (target.closest('.ig-preview-card')) return
      if (target.closest('.ig-context-menu')) return
      if (target.closest('.ig-rename-input')) return
      autoClearSelection()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [autoSelectedIds.length])
  const canvasContentRef = useRef<HTMLDivElement>(null)

  // 根据当前生图模型名推断可用的分辨率档位（避免选了 4K 但模型实际只支持 2K，导致接口返回 no images returned）
  const getSupportedResOptions = (modelName: string): string[] => {
    const m = (modelName || '').toLowerCase()
    if (m.includes('4k')) return ['1K', '2K', '4K']
    if (m.includes('2k')) return ['1K', '2K']
    if (m.includes('1k')) return ['1K']
    return ['1K', '2K', '4K']
  }

  const supportedResOptions = getSupportedResOptions(currentImageModel)

  // 当切换模型/分辨率后，如果当前选择的分辨率超出模型能力，则自动回退到最大支持档位
  useEffect(() => {
    if (!supportedResOptions.includes(res)) {
      setRes(supportedResOptions[supportedResOptions.length - 1])
    }
  }, [currentImageModel, res])
  
  // 提示词优化相关的状态
  const [isOptimizing, setIsOptimizing] = useState(false)

  // 历史记录状态 (后续可以放入 localStorage)
  const [historyList, setHistoryList] = useState<PromptHistory[]>(() => {
    return []
  })

  const [canvasHydrated, setCanvasHydrated] = useState(false)
  const [namesHydrated, setNamesHydrated] = useState(false)
  const [historyHydrated, setHistoryHydrated] = useState(false)

  const [manualLayoutRaw, setManualLayoutRaw] = useState<any>(null)

  // hydrate: canvas tools
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

  // hydrate: auto stack names
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

  // hydrate: prompt history
  useEffect(() => {
    let alive = true
    ;(async () => {
      const p = await kvGetJsonMigrate<any>(PROMPT_HISTORY_KEY, [])
      if (!alive) return
      setHistoryList(Array.isArray(p) ? p : [])
      setHistoryHydrated(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  // hydrate: manual layout (for auto-stack folder view)
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
  
  // 预览模态框状态：用 taskId 关联，方便做“保存/复制/重新制作/信息展示”
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null)
  const previewTask = previewTaskId ? tasks.find(t => t.id === previewTaskId) : null
  const [previewMsg, setPreviewMsg] = useState<string>('')

  // 自动叠放开启时：打开“自定义文件夹”的文件夹视图（不退出自动叠放）
  const [openManualFolderId, setOpenManualFolderId] = useState<string | null>(null)

  // 自动叠放下：拖拽把“未分类图片”放入自定义文件夹
  const autoDnDSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )
  const [autoDragActiveId, setAutoDragActiveId] = useState<string | null>(null)

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
      out.push({ id: fid, name: displayName, count: taskIds.length, coverUrl: coverTask?.url })
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

  // 从创意库返回后，一次性写入 Prompt / 优化偏好
  useEffect(() => {
    const pending = takePendingPromptLink('t2i')
    if (!pending) return
    if (pending.target === 'prompt') {
      setPrompt(pending.text)
    } else {
      setInjectOptimizeCustomText(pending.text)
    }
  }, [])

  // 当历史记录更新时，自动存入本地
  useEffect(() => {
    if (!historyHydrated) return
    const t = window.setTimeout(() => {
      void kvSetJson(PROMPT_HISTORY_KEY, historyList)
    }, 420)
    return () => window.clearTimeout(t)
  }, [historyHydrated, historyList])

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

  // 页面挂载时同步一次 localStorage（用户可能在别的界面点了“一键刷新”/或未来 i2i 共用）
  useEffect(() => {
    hydrateTasks()
  }, [])

  const handleBatchDecrease = () => setBatchCount(prev => Math.max(1, prev - 1))
  const handleBatchIncrease = () => setBatchCount(prev => Math.min(10, prev + 1))

  // 一键刷新：重新读取本地缓存并整理展示（不改动真实图片文件）
  const handleRefreshGrid = () => {
    refreshTasks()
    setOpenGroupKey(null)
    setPreviewTaskId(null)
    setManualRefreshToken(v => v + 1)
  }

  // 根据截图要求，新增多种画面比例
  const ratios = ['Auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9']

  // 处理模型更新同步到全局状态
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

  // 核心功能：调用大语言模型优化提示词
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
      
      // 保存到历史记录
      const newRecord: PromptHistory = {
        id: Date.now().toString(),
        original: prompt,
        optimized: optimizedText,
        model: currentPromptModel,
        time: Date.now()
      }
      setHistoryList(prev => [newRecord, ...prev])

      setPrompt(optimizedText)
    } catch (error: any) {
      uiToast('error', `优化失败: ${error.message || '未知错误'}`)
    } finally {
      setIsOptimizing(false)
    }
  }

  // 计算分辨率字符串 helper
  const getSizeFromRatioAndRes = (ratioStr: string, resStr: string): string => {
    let base = 1024
    if (resStr === '2K') base = 2048
    if (resStr === '4K') base = 4096

    // 如果是 Auto，默认使用 base x base (1:1)
    if (ratioStr === 'Auto') return `${base}x${base}`

    const [wStr, hStr] = ratioStr.split(':')
    const w = parseInt(wStr)
    const h = parseInt(hStr)
    
    if (!w || !h) return `${base}x${base}`

    let width, height
    // 逻辑：以长边为基准 (base)，短边根据比例缩放
    // 这样 2K 就能保证至少有一边达到 2048 像素
    if (w >= h) {
      width = base
      height = Math.round(base * h / w)
    } else {
      height = base
      width = Math.round(base * w / h)
    }
    
    // 确保是 8 的倍数 (很多生图框架要求 8 或 64 的倍数)
    width = Math.round(width / 8) * 8
    height = Math.round(height / 8) * 8

    return `${width}x${height}`
  }

  // 核心功能：调用大模型生成图片
  const handleGenerateClick = async () => {
    if (!prompt.trim()) {
      uiToast('info', '请先输入提示词')
      return
    }
    if (!activeProvider) {
      uiToast('info', '请先在设置中选择或配置 API 网站')
      return
    }
    if (!currentImageModel) {
      uiToast('info', '请在左下角选择“生图模型”')
      return
    }

    const imageApiKey = resolveApiKey(activeProvider, 'image')
    if (!imageApiKey) {
      uiToast('error', '请先在设置中配置“生图 Key”')
      return
    }

    // 计算实际发送给 API 的分辨率 (例如 "1024x576")
    // 对 comfly 这类网关：实际调用用 aspectRatio + imageSize，不强依赖像素；这里仍保留 targetSize 仅用于信息展示
    const targetSize = getSizeFromRatioAndRes(ratio, res)

    enqueueGenerateBatch({
      mode: 't2i',
      baseUrl: activeProvider.baseUrl,
      apiKey: imageApiKey,
      model: currentImageModel,
      prompt,
      ratio,
      targetSize,
      imageSize: res,
      optimizePreference,
      batchCount,
      // 自动保存开关：关闭时不触发主进程下载，只展示远端 url
      saveDir: autoSaveEnabled ? outputDirectory : undefined
    })
  }

  // 从某个提示词直接再生成 1 张（用于“重新制作”）
  const handleGenerateOne = async (args: { promptText: string, ratioValue: string, size?: string }) => {
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
      mode: 't2i',
      baseUrl: activeProvider.baseUrl,
      apiKey: imageApiKey,
      model: currentImageModel,
      prompt: args.promptText,
      ratio: args.ratioValue,
      targetSize: sizeToUse,
      imageSize: res,
      optimizePreference: previewTask?.optimizePreference || optimizePreference,
      saveDir: autoSaveEnabled ? outputDirectory : undefined
    })
  }

  // 删除卡片任务
  const handleDeleteTask = (id: string) => {
    deleteTask(id)
  }

  // 清空画布任务（避免项目迁移后旧路径任务一直报错）
  const handleClearTasks = async () => {
    const ok = await uiConfirm('确定要清空当前画布上的所有图片任务吗？', '清空画布')
    if (!ok) return
    clearTasksByMode('t2i')
  }

  // 历史记录相关操作
  const handleClearHistory = async () => {
    const ok = await uiConfirm('确定要清空所有提示词优化记录吗？', '清空记录')
    if (!ok) return
    setHistoryList([])
  }

  const handleDeleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation() // 防止点击触发上层元素
    setHistoryList(prev => prev.filter(item => item.id !== id))
  }

  // 点击历史记录时，填入提示词框
  const handleApplyHistory = (text: string) => {
    setPrompt(text)
  }

  // 自动叠放：按优化偏好分组（同一偏好 >=2 张成功图 才形成文件夹）
  // 说明：用户已整理进“自定义文件夹”的图片不参与自动叠放，避免重复出现
  const stackGroups = useMemo(() => {
    const success = tasks.filter(t => t.status === 'success' && t.url && !manualTaskIdSetForAuto.has(t.id))
    const map = new Map<string, { key: string, pref: string, items: ImageTask[], last: number }>()

    for (const t of success) {
      const pref = (t.optimizePreference || '').trim()
      if (!pref) continue
      const key = makeGroupKey(pref)
      const ts = t.createdAt || Date.now()
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
    if (!stackGroupKeySet.has(openGroupKey)) {
      setOpenGroupKey(null)
    }
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
        // 已进入自定义文件夹的不参与“根视图选择”
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
    if (!autoStackEnabled) return [] as ImageTask[]
    if (openGroupKey) return [] as ImageTask[]
    if (openManualFolderId) return [] as ImageTask[]

    return tasks.filter(t => {
      // 未分类只展示“图片”（成功）
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

  // 自动叠放根视图：生成中任务也要展示（但不参与分组/拖拽入文件夹）
  const autoGeneratingTasks = useMemo(() => {
    if (!autoStackEnabled) return [] as ImageTask[]
    if (openGroupKey) return [] as ImageTask[]
    if (openManualFolderId) return [] as ImageTask[]
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
    
    // 只在真的发生了框选（鼠标移动过一定距离）时才抑制下一次 click
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

  const autoHandleSurfaceClickClear = (e: React.MouseEvent) => {
    if (autoSuppressNextClearClickRef.current) {
      autoSuppressNextClearClickRef.current = false
      return
    }
    const target = e.target as HTMLElement
    if (target.closest('.ig-result-card') || target.closest('button') || target.closest('input') || target.closest('textarea')) return
    autoClearSelection()
  }

  // 左键点击“画布空白处”清空选择（包含：选中后 / 右键菜单关闭后）
  // 说明：
  // - 自动叠放开启：清空 autoSelectedIds
  // - 自动叠放关闭：广播给 ManualFolderGrid 清空其内部选择
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
      // 如果正在显示“自定义文件夹”视图，则只需要清空手动选择
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
        }
      },
      {
        id: 'cm_hidename',
        label: '隐藏名称',
        rightText: hideNameEnabled ? '开' : '关',
        onClick: () => setHideNameEnabled(v => !v)
      },
      { id: 'cm_sep1', kind: 'separator' },
      {
        id: 'cm_refresh',
        label: '一键刷新',
        rightText: 'R',
        onClick: () => handleRefreshGrid()
      }
    ]
  }, [canvasMenu.open, autoStackEnabled, hideNameEnabled, handleRefreshGrid])


  return (
    <div className="ig-layout">
      {/* 1. 左侧控制面板 (无图片上传区) */}
      <div className="ig-left">
        <div className="ig-panel-block">
          <div className="ig-block-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ImageIcon size={18} color="#5b6df0" />
              <span>参数配置 (文字生图)</span>
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
              {['1K', '2K', '4K'].map(r => {
                const disabled = !supportedResOptions.includes(r)
                return (
                <div
                  key={r}
                  className={`ig-pill ${res === r ? 'active' : ''}`}
                  onClick={() => !disabled && setRes(r)}
                  title={disabled ? '当前模型不支持该分辨率' : ''}
                  style={{
                    opacity: disabled ? 0.35 : 1,
                    cursor: disabled ? 'not-allowed' : 'pointer'
                  }}
                >
                  {r}
                </div>
              )})}
            </div>
          </div>
        </div>

        {/* 提示词输入区块与优化按钮 */}
        <div className="ig-panel-block">
          <div className="ig-block-header">
            <span>提示词 (Prompt)</span>
            <button 
              className="ig-optimize-btn" 
              onClick={handleOptimizePromptClick}
              disabled={isOptimizing || !prompt.trim()}
              style={{ 
                opacity: (isOptimizing || !prompt.trim()) ? 0.5 : 1, 
                cursor: (isOptimizing || !prompt.trim()) ? 'not-allowed' : 'pointer' 
              }}
            >
              {isOptimizing ? <Loader2 size={12} className="spin-icon" /> : <Zap size={12} />} 
              {isOptimizing ? '优化中...' : '优化'}
            </button>
          </div>
          <textarea 
            className="ig-prompt-input" 
            placeholder="描述想生成的画面..."
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
          />
        </div>

        {/* 新功能：提示词优化系统提示词预设（独立组件，避免单文件过大） */}
        <OptimizeSystemPromptEditor
          providerId={providerId}
          scopeKey="t2i"
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
          <button className="ig-toolbar-btn active">
            <ImageIcon size={16} /> 文字生图
          </button>
          <button className="ig-toolbar-btn" onClick={() => onSwitchMode('i2i')}>
            <FolderOpen size={16} /> 图像改图
          </button>
          <button className="ig-toolbar-btn" onClick={() => onSwitchMode('library')}>
            <LibraryIcon size={16} /> 创意库
          </button>
        </div>

        {/* 右上角画布工具：同时保留右键菜单入口 */}
        <div className="ig-canvas-toptools" aria-label="画布工具">
          <button
            type="button"
            className={`ig-tool-btn ${autoStackEnabled ? 'active' : ''}`}
            onClick={() => {
              setAutoStackEnabled(v => !v)
              setOpenGroupKey(null)
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
              onDeleteTask={handleDeleteTask}
              onRemakeOne={(t) => {
                handleGenerateOne({
                  promptText: t.prompt,
                  ratioValue: t.ratio || ratio,
                  size: t.targetSize
                })
              }}
              canvasTools={{
                autoStackEnabled,
                hideNameEnabled,
                onToggleAutoStack: () => {
                  setAutoStackEnabled(v => !v)
                  setOpenGroupKey(null)
                },
                onToggleHideName: () => setHideNameEnabled(v => !v),
                onRefresh: () => handleRefreshGrid()
              }}
              onOpenPreview={(id) => {
                setPreviewTaskId(id)
                setPreviewMsg('')
              }}
              onPatchTask={patchTask}
              initialOpenFolderId={openManualFolderId}
              lockToFolderId={openManualFolderId}
              onExitFolder={() => setOpenManualFolderId(null)}
              showRoot={false}
              folderHeaderPrefix="文件夹"
            />
          )}

          {/* 自动叠放根视图：自定义文件夹 + 按偏好叠放 + 未分类（可把未分类拖入自定义文件夹） */}
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
          {autoStackEnabled && !openManualFolderId && openGroupKey ? (
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
                <div key={task.id} className="ig-result-wrapper" data-select-task={task.status === 'success' && task.url ? task.id : undefined}>
                  <div className={`ig-result-card ${autoSelectedSet.has(task.id) ? 'ig-selected' : ''}`}>
                    {/* 删除按钮 */}
                    <div
                      className="ig-result-card-delete"
                      onClick={() => handleDeleteTask(task.id)}
                      title="删除此任务"
                    >
                      <X size={14} />
                    </div>

                    {autoSelectedSet.has(task.id) && task.status === 'success' && task.url && (
                      <div className="ig-selected-check" aria-label="已选中">
                        <Check size={14} />
                      </div>
                    )}

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
                        onClick={(e) => autoOnTaskClick(e, task.id, autoVisibleSuccessIds)}
                        onDoubleClick={() => {
                          setPreviewTaskId(task.id)
                          setPreviewMsg('')
                        }}
                        onLoad={(e) => {
                          // 记录平台实际返回的图片尺寸，便于定位“为什么选了 2K 但实际只有 1K”
                          const img = e.currentTarget
                          const actual = `${img.naturalWidth}x${img.naturalHeight}`
                          patchTask(task.id, { actualSize: actual })
                        }}
                        onError={() => {
                          // 发生断图时，直接把错误信息落到任务上（用户可见），并避免静默失败
                          const src = task.url ? String(task.url) : ''
                          const briefSrc = src.length > 80 ? `${src.slice(0, 40)}...${src.slice(-35)}` : src
                          patchTask(task.id, { status: 'error', errorMsg: `图片加载失败（src=${briefSrc || '空'}）` })
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
              ))}
              </div>
            </div>
          ) : (
            // 自动叠放根视图由上方分区渲染；这里只在关闭自动叠放时展示手动网格
            (autoStackEnabled ? null : (
              <ManualFolderGrid
                tasks={tasks}
                hideNameEnabled={hideNameEnabled}
                refreshToken={manualRefreshToken}
                onDeleteTask={handleDeleteTask}
                onRemakeOne={(t) => {
                  handleGenerateOne({
                    promptText: t.prompt,
                    ratioValue: t.ratio || ratio,
                    size: t.targetSize
                  })
                }}
                canvasTools={{
                  autoStackEnabled,
                  hideNameEnabled,
                  onToggleAutoStack: () => {
                    setAutoStackEnabled(v => !v)
                    setOpenGroupKey(null)
                  },
                  onToggleHideName: () => setHideNameEnabled(v => !v),
                  onRefresh: () => handleRefreshGrid()
                }}
                onOpenPreview={(id) => {
                  setPreviewTaskId(id)
                  setPreviewMsg('')
                }}
                onPatchTask={patchTask}
              />
            ))
          )}
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

          {/* 清空画布按钮 */}
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
          >
            <Sparkles size={16} /> 开始
          </button>

        </div>

        {/* 侧边栏折叠按钮 (依附在画布右边缘) */}
        <button className="ig-collapse-btn" onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}>
          {isRightPanelOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

        {/* 全屏预览模态框 */}
        <div 
          className={`ig-preview-modal ${previewTask ? 'show' : ''}`}
          onClick={() => setPreviewTaskId(null)}
        >
          {previewTask && previewTask.url && (
            <div className="ig-preview-card" onClick={(e) => e.stopPropagation()}>
              <button className="ig-preview-close" onClick={() => setPreviewTaskId(null)}>
                <X size={24} />
              </button>

              <div className="ig-preview-media">
                <img 
                  src={previewTask.url}
                  alt="Preview" 
                  className="ig-preview-img" 
                   onLoad={(e) => {
                     // 预览时也记录一次尺寸（如果网格未触发 onLoad）
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

                      // 1) 已是本地：直接在资源管理器中定位
                      if (localPath && window.nexaAPI?.showItemInFolder) {
                        const r = await window.nexaAPI.showItemInFolder({ filePath: localPath })
                        setPreviewMsg(r.success ? '已在资源管理器中定位文件' : '定位文件失败')
                        return
                      }

                      // 2) 远端：先下载到 output，再定位
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
                      // 用该任务的提示词重新生成 1 张
                      handleGenerateOne({
                        promptText: previewTask.prompt,
                        ratioValue: previewTask.ratio,
                        size: previewTask.targetSize
                      })
                      setPreviewMsg('已提交重新制作任务')
                    }}
                    title="用相同提示词重新制作 1 张"
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
                    <span className="v">
                      {(() => {
                        const local = tryGetLocalFilePathFromUrl(previewTask.url!)
                        if (local) return getFileNameFromPath(local)
                        try {
                          const u = new URL(previewTask.url!)
                          return getFileNameFromPath(u.pathname || previewTask.url!)
                        } catch {
                          return '未知'
                        }
                      })()}
                    </span>
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
          )}
        </div>

        <ContextMenu
          open={canvasMenu.open}
          x={canvasMenu.x}
          y={canvasMenu.y}
          onClose={() => setCanvasMenu(m => ({ ...m, open: false }))}
          items={canvasMenuItems}
        />
      </div>

      {/* 3. 右侧历史/收藏区 */}
      <div className={`ig-right ${isRightPanelOpen ? '' : 'collapsed'}`}>
        {/* 创意库：展示已有模板，并支持一键写入 */}
        <PromptLinkPanel
          mode="t2i"
          onOpenLibrary={() => onSwitchMode('library')}
          onApplyPrompt={(text) => setPrompt(text)}
          onApplyOptimizeCustom={(text) => setInjectOptimizeCustomText(text)}
        />

        <div className="ig-right-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <History size={18} color="#3b82f6" /> 优化记录
          </div>
          {historyList.length > 0 && (
            <button className="ig-clear-btn" onClick={handleClearHistory} title="清空记录">
              <Trash2 size={14} /> 清空
            </button>
          )}
        </div>
        
        {historyList.length === 0 ? (
          <div className="ig-empty-collection">
            <div style={{ width: 64, height: 64, borderRadius: '50%', backgroundColor: '#181b21', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <History size={32} color="#8e94a8" />
            </div>
            <p>还没有优化记录<br/><span style={{ fontSize: '0.8rem' }}>使用左侧的“优化”按钮开始</span></p>
          </div>
        ) : (
          <div className="ig-history-list">
            {historyList.map(item => (
              <div 
                key={item.id} 
                className="ig-history-item"
                onClick={() => handleApplyHistory(item.optimized || item.original)}
              >
                <div className="ig-history-thumb">
                  <Zap size={20} />
                </div>
                <div className="ig-history-info">
                  <span className="title">{item.original}</span>
                  <span className="desc">
                    {new Date(item.time).toLocaleTimeString()} · {item.model}
                  </span>
                </div>
                <X 
                  size={14} 
                  className="ig-history-item-delete" 
                  onClick={(e) => handleDeleteHistoryItem(item.id, e)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
