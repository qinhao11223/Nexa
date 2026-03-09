import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot, Copy, Images, Maximize2, Minus, Plus, Play, Settings2, Sparkles, X } from 'lucide-react'
import ImageDrop from '../../components/ImageDrop'
import MultiImageDrop from '../../components/MultiImageDrop'
import ModelPicker from '../../components/ModelPicker'
import type { QuickAppInputImage } from '../../types'
import { useSettingsStore } from '../../../settings/store'
import { resolveApiKey } from '../../../settings/utils/apiKeys'
import { uiConfirm, uiPrompt, uiTextEditor, uiTextViewer } from '../../../ui/dialogStore'
import { uiToast } from '../../../ui/toastStore'
import { chatCompletionsText, type ChatMessage } from '../../../../core/api/chatCompletions'
import { generateImage } from '../../../../core/api/image'
import { useQuickAppAgentPresetStore, type AgentRole } from '../../agents/store'
import { kvGetJson, kvGetJsonMigrate, kvRemove, kvSetJson } from '../../../../core/persist/kvClient'
import { ensureQuickAppImageData, isDataUrl, parseNexaLocalPath, srcToDataUrl } from '../../utils/localImage'
import { formatRequestDebugForCopy } from '../../../image_gen/utils/requestDebug'
import { usePromptLibraryStore, type PromptSet } from '../../prompt_library/store'
import { useProductShotTaskStore, type TaskInputImage } from '../../product_shot_tasks/store'
import ProductShotPromptGenie from './ProductShotPromptGenie'
import '../../styles/quickApps.css'

type Slot = { key: string, label: string, required?: boolean }

const MAX_LLM_PRODUCT_ANGLES = 6
const MAX_GEN_PRODUCT_ANGLES = 8

const CACHE_SAVE_DIR = 'cache/input-images/i2v'

const PS_INPUT_MANIFEST_KEY_V1 = 'nexa-qa-product-shot-input-manifest:v1'
const PS_SESSION_KEY_V1 = 'nexa-qa-product-shot-session:v1'
const PS_INPUT_MANIFEST_KEY_V2 = 'nexa-qa-product-shot-input-manifest:v2'
const PS_SESSION_KEY_V2 = 'nexa-qa-product-shot-session:v2'

const PS_WORKSPACE_SCRATCH = '__scratch__'

function psInputKey(workspaceId: string) {
  return `${PS_INPUT_MANIFEST_KEY_V2}:${workspaceId}`
}

function psSessionKey(workspaceId: string) {
  return `${PS_SESSION_KEY_V2}:${workspaceId}`
}

const ALLOWED_RATIOS = ['Auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9'] as const
const ALLOWED_RES = ['1K', '2K', '4K'] as const

function isAllowedRatio(v: string): v is (typeof ALLOWED_RATIOS)[number] {
  return (ALLOWED_RATIOS as any).includes(String(v || ''))
}

function isAllowedRes(v: string): v is (typeof ALLOWED_RES)[number] {
  return (ALLOWED_RES as any).includes(String(v || ''))
}

function clampInt(n: any, min: number, max: number) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, v))
}

type GenieTemplateSource = 'editor' | 'set'
type GenieSendFlags = {
  model: boolean
  wear_ref: boolean
  pose: boolean
  outfit: boolean
  scene: boolean
  product: boolean
}

const DEFAULT_GENIE_FLAGS: GenieSendFlags = {
  model: true,
  wear_ref: true,
  pose: true,
  outfit: true,
  scene: true,
  product: false
}

type InputManifestItem = { id: string, name: string, localPath: string, createdAt: number }
type ProductShotInputManifest = {
  productAngles: InputManifestItem[]
  slots: Record<string, InputManifestItem | null>
  updatedAt?: number
}

type ProductShotSession = {
  agent1Template?: string
  agent2Template?: string
  agent3Template?: string
  agent1Output?: string
  agent2Output?: string
  finalPrompt?: string
  outImages?: string[]
  outMetaByUrl?: Record<string, { createdAt: number, model: string, ratio: string, res: string, targetSize: string, actualSize?: string }>
  agent1Model?: string
  agent2Model?: string
  genModel?: string

  genRatio?: string
  genRes?: string

  taskBatchCount?: number

  genieTemplateSource?: GenieTemplateSource
  genieBaseSetId?: string
  genieUseImages?: boolean
  genieFlags?: Partial<GenieSendFlags>
  genieProductAngleCount?: number
  genieUserIdea?: string

  updatedAt?: number
}

// Keep in-memory snapshot so switching routes doesn't blank the UI
let memManifestByWs: Record<string, ProductShotInputManifest | null> = {}
let memSessionByWs: Record<string, ProductShotSession | null> = {}
let memDebugByWs: Record<string, Record<string, { request?: any, response?: any }>> = {}

function getFileNameFromPath(p: string): string {
  const s = String(p || '').replace(/\\/g, '/')
  const idx = s.lastIndexOf('/')
  return idx >= 0 ? s.slice(idx + 1) : s
}

function hasNexaLocal(u: string) {
  return /^nexa:\/\//i.test(String(u || ''))
}

function imageLocalPath(img: QuickAppInputImage | null | undefined): string {
  const lp = String((img as any)?.localPath || '').trim()
  if (lp && hasNexaLocal(lp)) return lp
  const du = String((img as any)?.dataUrl || '').trim()
  if (du && hasNexaLocal(du)) return du
  return ''
}

function normalizeId(img: QuickAppInputImage): string {
  return String(img?.id || '').trim() || `qa_img_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function joinNonEmpty(parts: Array<string | null | undefined>, sep = '\n\n') {
  return parts.map(s => String(s || '').trim()).filter(Boolean).join(sep)
}

function copyText(text: string) {
  const t = String(text || '')
  if (!t.trim()) {
    uiToast('info', '没有可复制的内容')
    return
  }
  if (!navigator.clipboard?.writeText) {
    uiTextViewer(t, { title: '复制内容' })
    return
  }
  navigator.clipboard.writeText(t)
    .then(() => uiToast('success', '已复制'))
    .catch(() => uiToast('error', '复制失败'))
}

function inferDataUrlExt(dataUrl: string) {
  const u = String(dataUrl || '')
  if (u.startsWith('data:image/png')) return 'png'
  if (u.startsWith('data:image/webp')) return 'webp'
  if (u.startsWith('data:image/jpeg')) return 'jpg'
  return 'png'
}

function safeFileName(s: string) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 120) || 'image'
}

function formatBytes(n: number) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0B'
  if (v < 1024) return `${Math.round(v)}B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`
  return `${(v / (1024 * 1024)).toFixed(2)}MB`
}

function taskInputFromImg(img: QuickAppInputImage): TaskInputImage | null {
  const lp = String((img as any)?.localPath || (img as any)?.dataUrl || '').trim()
  if (!lp.startsWith('nexa://local?path=')) return null
  return {
    id: String((img as any)?.id || '').trim() || `qa_img_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    name: String(img?.name || 'image'),
    localPath: lp,
    createdAt: Number((img as any)?.createdAt || Date.now())
  }
}

function shortTs(ts: number) {
  const d = new Date(Number(ts || 0) || Date.now())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}${dd}-${hh}${mi}`
}

function isCachedLocalPath(s: string) {
  return /^nexa:\/\/local\?path=/i.test(String(s || ''))
}

function tryGetLocalFilePathFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'nexa:') return null
    if (u.hostname === 'local') return u.searchParams.get('path')
    const p = (u.pathname || '').replace(/^\/+/, '')
    return p ? decodeURIComponent(p) : null
  } catch {
    return null
  }
}

// same logic as image_gen: ratio + res => pixel size
function getSizeFromRatioAndRes(ratioStr: string, resStr: string): string {
  let base = 1024
  if (resStr === '2K') base = 2048
  if (resStr === '4K') base = 4096

  if (ratioStr === 'Auto') return `${base}x${base}`

  const [wStr, hStr] = String(ratioStr || '').split(':')
  const w = parseInt(wStr, 10)
  const h = parseInt(hStr, 10)
  if (!w || !h) return `${base}x${base}`

  let width = base
  let height = base
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

type SentItem = { label: string, img: QuickAppInputImage }

function SentImagesPanel(props: { title: string, items: SentItem[] }) {
  const { title, items } = props
  return (
    <div className="ps-sent">
      <div className="ps-sent-head">
        <div className="ps-sent-title">{title}</div>
        <div className="ps-sent-sub">（以下为实际发送给 AI 的压缩图，可下载核对）</div>
      </div>
      {items.length === 0 ? (
        <div className="ps-sent-empty">没有可发送的图片</div>
      ) : (
        <div className="ps-sent-grid">
          {items.map((it, idx) => {
            const ext = inferDataUrlExt(it.img.dataUrl)
            const fileName = safeFileName(`${it.label}_${idx + 1}.${ext}`)
            const meta = `${it.img.width || ''}${it.img.height ? `x${it.img.height}` : ''}${it.img.bytes ? ` · ${formatBytes(it.img.bytes)}` : ''}`.trim()
            const absPath = parseNexaLocalPath(String(it.img.localPath || it.img.dataUrl || ''))
            return (
              <div key={`${it.label}_${idx}`} className="ps-sent-item">
                <div className="ps-sent-thumb">
                  <img src={it.img.dataUrl} alt={it.label} draggable={false} />
                </div>
                <div className="ps-sent-info">
                  <div className="ps-sent-lab" title={it.label}>{it.label}</div>
                  <div className="ps-sent-meta">{meta || ' '}</div>
                </div>
                <button
                  className="ps-sent-dl"
                  type="button"
                  onClick={async () => {
                    // ensure we download the actual sent (data url) image
                    try {
                      const src = String(it.img.sourceDataUrl || it.img.localPath || it.img.dataUrl || '')
                      const dataUrl = await srcToDataUrl(src)
                      const a = document.createElement('a')
                      a.href = dataUrl
                      a.download = fileName
                      a.click()
                    } catch {
                      // fallback: reveal cached file
                      const api = (window as any).nexaAPI
                      if (api?.showItemInFolder && absPath) {
                        try { await api.showItemInFolder({ filePath: absPath }) } catch { /* ignore */ }
                      }
                    }
                  }}
                  title={absPath ? '下载失败时会定位到缓存文件' : '下载'}
                >
                  下载
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function assembleFinalPrompt(args: {
  agent3Template: string
  agent2Output: string
  agent1Output: string
}): string {
  const a3 = String(args.agent3Template || '').trim()
  const a2 = String(args.agent2Output || '').trim()
  const a1 = String(args.agent1Output || '').trim()

  return joinNonEmpty([
    a3,
    a2 ? `### **【首图拍摄动作】**\n\n${a2}` : '',
    a1 ? `产品详细信息提示词：\n\n${a1}` : ''
  ])
}

export default function ProductShotStudio() {
  const navigate = useNavigate()
  const loc = useLocation()
  const providers = useSettingsStore(s => s.providers)
  const activeProviderId = useSettingsStore(s => s.activeProviderId)
  const appsProviderId = useSettingsStore(s => s.appsProviderId)
  const autoSaveEnabled = useSettingsStore(s => s.autoSaveEnabled)
  const outputDirectory = useSettingsStore(s => s.outputDirectory)

  const effectiveProviderId = (appsProviderId || activeProviderId || '').trim()
  const provider = useMemo(() => providers.find(p => p.id === effectiveProviderId) || null, [providers, effectiveProviderId])

  const urlSetId = useMemo(() => {
    try {
      return new URLSearchParams(String(loc.search || '')).get('set') || ''
    } catch {
      return ''
    }
  }, [loc.search])

  const promptApiKey = useMemo(() => provider ? resolveApiKey(provider, 'prompt') : '', [provider])
  const promptModel = useMemo(() => String(provider?.selectedPromptModel || '').trim(), [provider])
  const imageApiKey = useMemo(() => provider ? resolveApiKey(provider, 'image') : '', [provider])
  const imageModel = useMemo(() => String(provider?.selectedImageModel || '').trim(), [provider])
  const baseUrl = useMemo(() => String(provider?.baseUrl || '').trim(), [provider])

  const allModels = useMemo(() => {
    const list = Array.isArray(provider?.models) ? provider!.models : []
    const out = list.map(String).map(s => s.trim()).filter(Boolean)
    const extra = [promptModel, imageModel].map(s => String(s || '').trim()).filter(Boolean)
    const uniq = new Set<string>([...extra, ...out])
    return Array.from(uniq)
  }, [provider, promptModel, imageModel])

  const slots: Slot[] = useMemo(() => ([
    { key: 'wear_ref', label: '佩戴参考（可选）' },
    { key: 'model', label: '我们的模特（可选）' },
    { key: 'outfit', label: '服装参考（可选）' },
    { key: 'scene', label: '场景图（可选）' },
    { key: 'pose', label: '参考姿态图（可选）' }
  ]), [])

  const [productAngles, setProductAngles] = useState<QuickAppInputImage[]>(() => {
    const m = memManifestByWs[PS_WORKSPACE_SCRATCH] || null
    if (!m) return []
    return (m.productAngles || [])
      .filter((x: any) => x && x.id && x.localPath)
      .slice(0, 24)
      .map((x: any) => ({
        id: String(x.id),
        name: String(x.name || 'image'),
        dataUrl: String(x.localPath),
        base64: '',
        localPath: String(x.localPath),
        createdAt: Number(x.createdAt || Date.now())
      }))
  })
  const [images, setImages] = useState<Record<string, QuickAppInputImage | null>>(() => {
    const init: Record<string, QuickAppInputImage | null> = {}
    for (const s of slots) init[s.key] = null
    const m = memManifestByWs[PS_WORKSPACE_SCRATCH] || null
    if (!m || !m.slots) return init
    for (const s of slots) {
      const it = (m.slots as any)[s.key] as InputManifestItem | null
      if (it && it.id && it.localPath) {
        init[s.key] = {
          id: String(it.id),
          name: String(it.name || 'image'),
          dataUrl: String(it.localPath),
          base64: '',
          localPath: String(it.localPath),
          createdAt: Number(it.createdAt || Date.now())
        }
      }
    }
    return init
  })

  const [inputHydratedWs, setInputHydratedWs] = useState<string>('')
  const [sessionHydratedWs, setSessionHydratedWs] = useState<string>('')
  const persistingRef = useRef({ manifest: 0 as any, session: 0 as any })

  const promptSets = usePromptLibraryStore(s => s.sets)
  const activeSetIdByApp = usePromptLibraryStore(s => s.activeSetIdByApp)
  const setActiveSet = usePromptLibraryStore(s => s.setActive)
  const addPromptSet = usePromptLibraryStore(s => s.addSet)
  const updatePromptSet = usePromptLibraryStore(s => s.updateSet)
  const removePromptSet = usePromptLibraryStore(s => s.removeSet)

  const addTask = useProductShotTaskStore(s => s.addTask)

  const presets = useQuickAppAgentPresetStore(s => s.presets)
  const activePresetId = useQuickAppAgentPresetStore(s => s.activePresetId)
  const setActivePreset = useQuickAppAgentPresetStore(s => s.setActivePreset)
  const addPreset = useQuickAppAgentPresetStore(s => s.addPreset)
  const updatePreset = useQuickAppAgentPresetStore(s => s.updatePreset)
  const removePreset = useQuickAppAgentPresetStore(s => s.removePreset)

  const presetsByRole = useMemo(() => {
    const map: Record<AgentRole, any[]> = { agent_1: [], agent_2: [], agent_3: [] }
    for (const p of presets) {
      if (p.role === 'agent_1' || p.role === 'agent_2' || p.role === 'agent_3') map[p.role].push(p)
    }
    for (const k of Object.keys(map) as AgentRole[]) {
      map[k].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.updatedAt - a.updatedAt)
    }
    return map
  }, [presets])

  const initialTextForRole = (role: AgentRole) => {
    const activeId = activePresetId?.[role]
    if (activeId) {
      const p = presets.find(x => x.id === activeId)
      if (p) return p.text
    }
    const first = presetsByRole[role]?.[0]
    return first?.text || ''
  }

  const seedSession = memSessionByWs[PS_WORKSPACE_SCRATCH] || null
  const [agent1Template, setAgent1Template] = useState(() => (seedSession?.agent1Template ?? initialTextForRole('agent_1')))
  const [agent2Template, setAgent2Template] = useState(() => (seedSession?.agent2Template ?? initialTextForRole('agent_2')))
  const [agent3Template, setAgent3Template] = useState(() => (seedSession?.agent3Template ?? initialTextForRole('agent_3')))

  const [agent1Output, setAgent1Output] = useState(() => String(seedSession?.agent1Output || ''))
  const [agent2Output, setAgent2Output] = useState(() => String(seedSession?.agent2Output || ''))
  const [finalPrompt, setFinalPrompt] = useState(() => String(seedSession?.finalPrompt || ''))
  const [outImages, setOutImages] = useState<string[]>(() => (
    Array.isArray(seedSession?.outImages) ? seedSession!.outImages!.map(String).filter(Boolean) : []
  ))

  const [outMetaByUrl, setOutMetaByUrl] = useState<Record<string, { createdAt: number, model: string, ratio: string, res: string, targetSize: string, actualSize?: string }>>(() => {
    const m = seedSession?.outMetaByUrl
    if (!m || typeof m !== 'object') return {}
    return m as any
  })

  const debugRef = useRef<Record<string, { request?: any, response?: any }>>(memDebugByWs[PS_WORKSPACE_SCRATCH] || {})
  const [debugTick, setDebugTick] = useState(0)

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewMsg, setPreviewMsg] = useState('')

  const [busy, setBusy] = useState<null | 'agent1' | 'agent2' | 'merge' | 'gen' | 'task'>(null)

  const editText = async (title: string, text: string, apply: (next: string) => void) => {
    const t = String(text || '')
    const next = await uiTextEditor(t, { title, size: 'lg' })
    if (next === null) return
    apply(String(next))
  }

  const missingRequired = useMemo(() => productAngles.length === 0, [productAngles])

  const canUseLLM = Boolean(baseUrl && promptApiKey && promptModel)
  const canGenImage = Boolean(baseUrl && imageApiKey && imageModel)

  const saveDir = useMemo(() => {
    return autoSaveEnabled ? String(outputDirectory || '').trim() || undefined : undefined
  }, [autoSaveEnabled, outputDirectory])

  const promptPinned = useMemo(() => {
    const list = (provider?.pinnedPromptModels || []).filter(Boolean)
    return list.slice(0, 4)
  }, [provider])

  const imagePinned = useMemo(() => {
    const list = (provider?.pinnedImageModels || []).filter(Boolean)
    return list.slice(0, 4)
  }, [provider])

  const [agent1Model, setAgent1Model] = useState(() => String(seedSession?.agent1Model || promptModel))
  const [agent2Model, setAgent2Model] = useState(() => String(seedSession?.agent2Model || promptModel))
  const [genModel, setGenModel] = useState(() => String(seedSession?.genModel || imageModel))

  const [genRatio, setGenRatio] = useState<'Auto' | '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '2:3' | '3:2' | '21:9'>(() => {
    const r = String(seedSession?.genRatio || '')
    return (['Auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9'].includes(r) ? (r as any) : '1:1')
  })
  const [genRes, setGenRes] = useState<'1K' | '2K' | '4K'>(() => {
    const r = String(seedSession?.genRes || '')
    return (['1K', '2K', '4K'].includes(r) ? (r as any) : '1K')
  })
  const [genParamsOpen, setGenParamsOpen] = useState(false)

  const [taskBatchCount, setTaskBatchCount] = useState<number>(() => clampInt((seedSession as any)?.taskBatchCount, 1, 20))

  const [genieOpen, setGenieOpen] = useState(false)
  const [genieTemplateSource, setGenieTemplateSource] = useState<GenieTemplateSource>(() => (((seedSession as any)?.genieTemplateSource === 'set') ? 'set' : 'editor'))
  const [genieBaseSetId, setGenieBaseSetId] = useState<string>(() => String((seedSession as any)?.genieBaseSetId || 'follow-active'))
  const [genieUseImages, setGenieUseImages] = useState<boolean>(() => Boolean((seedSession as any)?.genieUseImages))
  const [genieFlags, setGenieFlags] = useState<GenieSendFlags>(() => ({ ...DEFAULT_GENIE_FLAGS, ...(((seedSession as any)?.genieFlags || {}) as any) }))
  const [genieProductAngleCount, setGenieProductAngleCount] = useState<number>(() => clampInt((seedSession as any)?.genieProductAngleCount, 0, 2))
  const [genieUserIdea, setGenieUserIdea] = useState<string>(() => String((seedSession as any)?.genieUserIdea || ''))

  const decTaskBatch = () => setTaskBatchCount(v => clampInt(v - 1, 1, 20))
  const incTaskBatch = () => setTaskBatchCount(v => clampInt(v + 1, 1, 20))

  const setsForProductShot = useMemo(() => {
    const list = (promptSets || []).filter(s => s.appId === 'product_shot')
    return list
      .slice()
      .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.updatedAt - a.updatedAt)
  }, [promptSets])

  const [activePromptSetId, setActivePromptSetId] = useState<string>(() => {
    const id = String((activeSetIdByApp as any)?.product_shot || '').trim()
    return id
  })

  useEffect(() => {
    const id = String((activeSetIdByApp as any)?.product_shot || '').trim()
    if (id && id !== activePromptSetId) setActivePromptSetId(id)
  }, [activeSetIdByApp])

  const activePromptSetObj = useMemo(() => {
    const id = String(activePromptSetId || '').trim()
    if (!id) return null
    return setsForProductShot.find(x => x.id === id) || null
  }, [activePromptSetId, setsForProductShot])

  const workspaceId = useMemo(() => {
    const id = String(activePromptSetId || '').trim()
    return id || PS_WORKSPACE_SCRATCH
  }, [activePromptSetId])

  const inputHydrated = inputHydratedWs === workspaceId
  const sessionHydrated = sessionHydratedWs === workspaceId

  const lastAppliedSetRef = useRef<{ id: string | null, a1: string, a2: string, a3: string, r: string, res: string, m1: string, m2: string, gm: string } | null>(null)

  const applyPromptSet = async (s: PromptSet) => {
    const nextId = String(s?.id || '').trim()
    if (!nextId) return
    // Switch workspace by template group id.
    // Per-template workspaces prevent images/outputs from leaking across groups.
    setActivePromptSetId(nextId)
    setActiveSet('product_shot', nextId)
    lastAppliedSetRef.current = null
    uiToast('success', `已切换模板组：${String(s.name || '').trim() || '未命名'}`)
  }

  // Apply selected set from URL (ProductShotHome -> Studio)
  useEffect(() => {
    const id = String(urlSetId || '').trim()
    if (!id) return
    const cur = setsForProductShot.find(x => x.id === id) || null
    if (!cur) return

    // avoid re-applying when already selected
    if (String(activePromptSetId || '') === id) {
      // strip set param to avoid future re-triggers
      try {
        const sp = new URLSearchParams(String(loc.search || ''))
        if (sp.get('set')) {
          sp.delete('set')
          navigate(`/apps/product_shot?${sp.toString()}`, { replace: true })
        }
      } catch {
        // ignore
      }
      return
    }

    void (async () => {
      try {
        setActivePromptSetId(String(cur.id))
        setActiveSet('product_shot', String(cur.id))
      } finally {
        try {
          const sp = new URLSearchParams(String(loc.search || ''))
          if (sp.get('set')) {
            sp.delete('set')
            navigate(`/apps/product_shot?${sp.toString()}`, { replace: true })
          }
        } catch {
          // ignore
        }
      }
    })()
  }, [urlSetId, setsForProductShot, activePromptSetId, loc.search, navigate])

  const saveAsPromptSet = async () => {
    const name = await uiPrompt('模板组名称', { title: '保存到提示词库', placeholder: '例如：帽子（ededed背景）' })
    if (!name) return
    const category = await uiPrompt('分类（可选）', { title: '保存到提示词库', placeholder: '例如：帽子 / 饰品 / 袜子' })

    const created = addPromptSet({
      appId: 'product_shot',
      name,
      category: category || undefined,
      agent1Template: String(agent1Template || ''),
      agent2Template: String(agent2Template || ''),
      agent3Template: String(agent3Template || ''),
      agent1Model: String(agent1Model || ''),
      agent2Model: String(agent2Model || ''),
      genModel: String(genModel || ''),
      genRatio: String(genRatio || ''),
      genRes: String(genRes || '')
    })

    // Clone current workspace into the newly created template group workspace
    // so the UI doesn't blank on switch.
    try {
      const newWsId = String(created.id || '').trim() || PS_WORKSPACE_SCRATCH
      const m = buildManifest()
      const s = buildSession()
      memManifestByWs[newWsId] = m
      memSessionByWs[newWsId] = s
      await kvSetJson(psInputKey(newWsId), m)
      await kvSetJson(psSessionKey(newWsId), s)
    } catch {
      // ignore
    }

    setActivePromptSetId(created.id)
    setActiveSet('product_shot', created.id)
    lastAppliedSetRef.current = null
    uiToast('success', '已保存到提示词库')
  }

  const overwritePromptSet = async () => {
    const id = String(activePromptSetId || '').trim()
    if (!id) {
      uiToast('info', '请先选择一个模板组')
      return
    }
    const cur = setsForProductShot.find(x => x.id === id)
    const ok = await uiConfirm(`覆盖保存模板组「${cur?.name || '未命名'}」？`, '覆盖保存')
    if (!ok) return
    updatePromptSet(id, {
      agent1Template: String(agent1Template || ''),
      agent2Template: String(agent2Template || ''),
      agent3Template: String(agent3Template || ''),
      agent1Model: String(agent1Model || ''),
      agent2Model: String(agent2Model || ''),
      genModel: String(genModel || ''),
      genRatio: String(genRatio || ''),
      genRes: String(genRes || '')
    } as any)
    lastAppliedSetRef.current = { id, a1: String(agent1Template || ''), a2: String(agent2Template || ''), a3: String(agent3Template || ''), r: String(genRatio || ''), res: String(genRes || ''), m1: String(agent1Model || ''), m2: String(agent2Model || ''), gm: String(genModel || '') }
    uiToast('success', '已覆盖保存')
  }

  const deletePromptSet = async () => {
    const id = String(activePromptSetId || '').trim()
    if (!id) {
      uiToast('info', '请先选择一个模板组')
      return
    }
    const cur = setsForProductShot.find(x => x.id === id)
    const ok = await uiConfirm(`确定删除模板组「${cur?.name || '未命名'}」？`, '删除')
    if (!ok) return
    removePromptSet(id)
    try {
      delete memManifestByWs[id]
      delete memSessionByWs[id]
      delete memDebugByWs[id]
      await kvRemove(psInputKey(id))
      await kvRemove(psSessionKey(id))
    } catch {
      // ignore
    }
    setActiveSet('product_shot', null)
    setActivePromptSetId('')
    lastAppliedSetRef.current = null
    uiToast('success', '已删除')
  }

  const createTask = async () => {
    const count = clampInt(taskBatchCount, 1, 20)
    if (!effectiveProviderId) {
      uiToast('info', '未选择 Provider（请先在设置里选择/配置）')
      return
    }
    if (missingRequired) {
      uiToast('info', '请先上传至少一张“产品不同角度图”')
      return
    }

    // Ensure inputs are cached to nexa://local
    const ensureCached = async () => {
      // angles
      let nextAngles = productAngles.slice()
      for (let i = 0; i < nextAngles.length; i++) {
        const img = nextAngles[i]
        const lp = imageLocalPath(img)
        if (lp) continue
        const cached = await cacheInputImage(img, 'qa_ps_angle')
        nextAngles[i] = cached
      }
      setProductAngles(nextAngles)

      // slots
      const nextSlots: any = { ...images }
      for (const s of slots) {
        const img = nextSlots[s.key]
        if (!img) continue
        const lp = imageLocalPath(img)
        if (lp) continue
        nextSlots[s.key] = await cacheInputImage(img, `qa_ps_${s.key}`)
      }
      setImages(nextSlots)

      return { nextAngles, nextSlots }
    }

    setBusy('task')
    try {
      const cached = await ensureCached()
      const angleInputs: TaskInputImage[] = cached.nextAngles
        .map(taskInputFromImg)
        .filter(Boolean) as any

      if (angleInputs.length === 0) {
        uiToast('error', '图片缓存失败（请重试）')
        return
      }

      const slotInputs: Record<string, TaskInputImage | null> = {}
      for (const s of slots) {
        const img = cached.nextSlots[s.key] as QuickAppInputImage | null
        slotInputs[s.key] = img ? taskInputFromImg(img) : null
      }

      const setObj = activePromptSetId ? setsForProductShot.find(x => x.id === activePromptSetId) : null
      const label = setObj ? `${String(setObj.category || '').trim() ? `${String(setObj.category).trim()}/` : ''}${String(setObj.name || '').trim()}` : '未分组'

      const baseTs = Date.now()
      const baseTitle = `${label} ${shortTs(baseTs)}`
      for (let i = 0; i < count; i++) {
        const title = count > 1 ? `${baseTitle} (${i + 1}/${count})` : baseTitle
        addTask({
          title,
          promptSetId: activePromptSetId || undefined,
          promptSetLabel: label,
          providerId: effectiveProviderId,
          productAngles: angleInputs.slice(),
          slots: { ...slotInputs },
          agent1Template: String(agent1Template || ''),
          agent2Template: String(agent2Template || ''),
          agent3Template: String(agent3Template || ''),
          agent1Model: String(effectiveAgent1Model || ''),
          agent2Model: String(effectiveAgent2Model || ''),
          genModel: String(effectiveGenModel || ''),
          genRatio: String(genRatio === 'Auto' ? '1:1' : genRatio),
          genRes: String(genRes || '1K'),
          agent1Output: String(agent1Output || ''),
          agent2Output: String(agent2Output || ''),
          finalPrompt: String(finalPrompt || ''),
          outImages: []
        } as any)
      }

      uiToast('success', `已创建 ${count} 个任务：后台自动跑全流程（可在“应用-任务列表”查看）`)
    } catch (e: any) {
      uiToast('error', e?.message || '创建任务失败')
    } finally {
      setBusy(null)
    }
  }

  const [showAgent1Sent, setShowAgent1Sent] = useState(false)
  const [showAgent2Sent, setShowAgent2Sent] = useState(false)
  const [showGenSent, setShowGenSent] = useState(false)

  const effectiveAgent1Model = String(agent1Model || promptModel || '').trim()
  const effectiveAgent2Model = String(agent2Model || promptModel || '').trim()
  const effectiveGenModel = String(genModel || imageModel || '').trim()

  const previewMeta = useMemo(() => {
    if (!previewUrl) return null
    return (outMetaByUrl as any)?.[previewUrl] || null
  }, [previewUrl, outMetaByUrl])

  const previewDebug = useMemo(() => {
    if (!previewUrl) return null
    // debugRef is stable; debugTick triggers refresh
    return debugRef.current?.[previewUrl] || null
  }, [previewUrl, debugTick])

  const previewAbsPath = useMemo(() => {
    if (!previewUrl) return null
    return tryGetLocalFilePathFromUrl(previewUrl)
  }, [previewUrl])

  const previewFileName = useMemo(() => {
    const abs = String(previewAbsPath || '').trim()
    if (abs) return getFileNameFromPath(abs)
    const u = String(previewUrl || '').trim()
    if (!u) return ''
    if (u.startsWith('http://') || u.startsWith('https://')) {
      try {
        const x = new URL(u)
        return getFileNameFromPath(x.pathname)
      } catch {
        return ''
      }
    }
    return ''
  }, [previewUrl, previewAbsPath])

  // keep per-workspace debug cache
  const prevWsRef = useRef<string>(workspaceId)
  useEffect(() => {
    try {
      const prev = prevWsRef.current
      if (prev) memDebugByWs[prev] = debugRef.current || {}
      prevWsRef.current = workspaceId
      debugRef.current = memDebugByWs[workspaceId] || {}
      setDebugTick(v => v + 1)
      setPreviewUrl(null)
      setPreviewMsg('')
    } catch {
      // ignore
    }
  }, [workspaceId])

  // hydrate persisted manifest + session
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const key = psInputKey(workspaceId)
        let m = await kvGetJsonMigrate<ProductShotInputManifest | null>(key, null)

        // One-time migrate from v1 -> current workspace when v2 missing.
        if (!m) {
          const old = await kvGetJson<ProductShotInputManifest | null>(PS_INPUT_MANIFEST_KEY_V1, null)
          if (old && typeof old === 'object') {
            await kvSetJson(key, old)
            await kvRemove(PS_INPUT_MANIFEST_KEY_V1)
            m = old
          }
        }
        if (!alive) return

        const mem = memManifestByWs[workspaceId] || null
        const memTs = Number(mem?.updatedAt || 0)
        const diskTs = Number((m as any)?.updatedAt || 0)
        const use = (mem && memTs >= diskTs) ? mem : (m || null)
        const useObj: ProductShotInputManifest = (use && typeof use === 'object')
          ? (use as any)
          : { productAngles: [], slots: {}, updatedAt: Date.now() }

        const angles: QuickAppInputImage[] = (useObj.productAngles || [])
          .filter((x: any) => x && x.id && x.localPath)
          .slice(0, 24)
          .map((x: any) => ({
            id: String(x.id),
            name: String(x.name || 'image'),
            dataUrl: String(x.localPath),
            base64: '',
            localPath: String(x.localPath),
            createdAt: Number(x.createdAt || Date.now())
          }))

        const nextImages: Record<string, QuickAppInputImage | null> = {}
        for (const s of slots) nextImages[s.key] = null
        for (const s of slots) {
          const it = (useObj.slots || ({} as any))?.[s.key] as InputManifestItem | null
          if (it && it.id && it.localPath) {
            nextImages[s.key] = {
              id: String(it.id),
              name: String(it.name || 'image'),
              dataUrl: String(it.localPath),
              base64: '',
              localPath: String(it.localPath),
              createdAt: Number(it.createdAt || Date.now())
            }
          }
        }

        setProductAngles(angles)
        setImages(nextImages)

        memManifestByWs[workspaceId] = useObj
      } catch {
        // ignore
      } finally {
        if (alive) setInputHydratedWs(workspaceId)
      }
    })()
    return () => {
      alive = false
    }
  }, [slots, workspaceId])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const key = psSessionKey(workspaceId)
        let s = await kvGetJsonMigrate<ProductShotSession | null>(key, null)

        // One-time migrate from v1 -> current workspace when v2 missing.
        if (!s) {
          const old = await kvGetJson<ProductShotSession | null>(PS_SESSION_KEY_V1, null)
          if (old && typeof old === 'object') {
            await kvSetJson(key, old)
            await kvRemove(PS_SESSION_KEY_V1)
            s = old
          }
        }
        if (!alive) return

        const mem = memSessionByWs[workspaceId] || null
        const memTs = Number(mem?.updatedAt || 0)
        const diskTs = Number((s as any)?.updatedAt || 0)
        const use = (mem && memTs >= diskTs) ? mem : (s || null)

        const initFromSet = (): ProductShotSession => {
          const setObj = String(activePromptSetId || '').trim() ? activePromptSetObj : null
          return {
            agent1Template: String(setObj?.agent1Template || initialTextForRole('agent_1')),
            agent2Template: String(setObj?.agent2Template || initialTextForRole('agent_2')),
            agent3Template: String(setObj?.agent3Template || initialTextForRole('agent_3')),
            agent1Output: '',
            agent2Output: '',
            finalPrompt: '',
            outImages: [],
            outMetaByUrl: {},
            agent1Model: String(setObj?.agent1Model || promptModel || ''),
            agent2Model: String(setObj?.agent2Model || promptModel || ''),
            genModel: String(setObj?.genModel || imageModel || ''),
            genRatio: String((setObj?.genRatio && isAllowedRatio(String(setObj.genRatio))) ? setObj.genRatio : '1:1'),
            genRes: String((setObj?.genRes && isAllowedRes(String(setObj.genRes))) ? setObj.genRes : '1K'),
            taskBatchCount: 1,
            genieTemplateSource: 'editor',
            genieBaseSetId: 'follow-active',
            genieUseImages: false,
            genieFlags: DEFAULT_GENIE_FLAGS,
            genieProductAngleCount: 0,
            genieUserIdea: '',
            updatedAt: Date.now()
          }
        }

        const useObj: ProductShotSession = (use && typeof use === 'object') ? (use as any) : initFromSet()

        if (typeof useObj?.agent1Template === 'string') setAgent1Template(useObj.agent1Template)
        if (typeof useObj?.agent2Template === 'string') setAgent2Template(useObj.agent2Template)
        if (typeof useObj?.agent3Template === 'string') setAgent3Template(useObj.agent3Template)
        if (typeof useObj?.agent1Output === 'string') setAgent1Output(useObj.agent1Output)
        if (typeof useObj?.agent2Output === 'string') setAgent2Output(useObj.agent2Output)
        if (typeof useObj?.finalPrompt === 'string') setFinalPrompt(useObj.finalPrompt)
        if (Array.isArray(useObj?.outImages)) setOutImages(useObj.outImages.map(String).filter(Boolean).slice(0, 60))
        if (useObj?.outMetaByUrl && typeof useObj.outMetaByUrl === 'object') {
          setOutMetaByUrl(useObj.outMetaByUrl as any)
        }
        if (typeof useObj?.agent1Model === 'string') setAgent1Model(useObj.agent1Model)
        if (typeof useObj?.agent2Model === 'string') setAgent2Model(useObj.agent2Model)
        if (typeof useObj?.genModel === 'string') setGenModel(useObj.genModel)

        if (typeof useObj?.genRatio === 'string') {
          const r = String(useObj.genRatio)
          if (['Auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9'].includes(r)) setGenRatio(r as any)
        }
        if (typeof useObj?.genRes === 'string') {
          const rr = String(useObj.genRes)
          if (['1K', '2K', '4K'].includes(rr)) setGenRes(rr as any)
        }

        if (typeof (useObj as any)?.taskBatchCount === 'number') {
          setTaskBatchCount(clampInt((useObj as any).taskBatchCount, 1, 20))
        }

        if (typeof (useObj as any)?.genieTemplateSource === 'string') {
          const v = String((useObj as any).genieTemplateSource)
          if (v === 'set' || v === 'editor') setGenieTemplateSource(v as any)
        }
        if (typeof (useObj as any)?.genieBaseSetId === 'string') {
          const v = String((useObj as any).genieBaseSetId || '').trim()
          setGenieBaseSetId(v || 'follow-active')
        }
        if (typeof (useObj as any)?.genieUseImages === 'boolean') {
          setGenieUseImages(Boolean((useObj as any).genieUseImages))
        }
        if ((useObj as any)?.genieFlags && typeof (useObj as any).genieFlags === 'object') {
          setGenieFlags(prev => ({ ...prev, ...((useObj as any).genieFlags || {}) }))
        }
        if (typeof (useObj as any)?.genieProductAngleCount === 'number') {
          setGenieProductAngleCount(clampInt((useObj as any).genieProductAngleCount, 0, 2))
        }
        if (typeof (useObj as any)?.genieUserIdea === 'string') {
          setGenieUserIdea(String((useObj as any).genieUserIdea || ''))
        }

        memSessionByWs[workspaceId] = useObj
      } catch {
        // ignore
      } finally {
        if (alive) setSessionHydratedWs(workspaceId)
      }
    })()
    return () => {
      alive = false
    }
  }, [workspaceId, activePromptSetId, activePromptSetObj, promptModel, imageModel])

  const buildManifest = (): ProductShotInputManifest => {
    const pa: InputManifestItem[] = []
    for (const img of (productAngles || []).slice(0, 24)) {
      const lp = imageLocalPath(img)
      if (!lp) continue
      pa.push({
        id: normalizeId(img),
        name: String(img?.name || 'image'),
        localPath: lp,
        createdAt: Number(img?.createdAt || Date.now())
      })
    }
    const sl: Record<string, InputManifestItem | null> = {}
    for (const s of slots) {
      const img = images?.[s.key] || null
      const lp = imageLocalPath(img)
      if (!img || !lp) {
        sl[s.key] = null
      } else {
        sl[s.key] = {
          id: normalizeId(img),
          name: String(img?.name || 'image'),
          localPath: lp,
          createdAt: Number(img?.createdAt || Date.now())
        }
      }
    }
    return { productAngles: pa, slots: sl, updatedAt: Date.now() }
  }

  const buildSession = (): ProductShotSession => ({
    agent1Template: String(agent1Template || ''),
    agent2Template: String(agent2Template || ''),
    agent3Template: String(agent3Template || ''),
    agent1Output: String(agent1Output || ''),
    agent2Output: String(agent2Output || ''),
    finalPrompt: String(finalPrompt || ''),
    outImages: (outImages || []).map(String).filter(Boolean).slice(0, 60),
    outMetaByUrl: (() => {
      const urls = (outImages || []).map(String).filter(Boolean).slice(0, 60)
      const out: any = {}
      for (const u of urls) {
        const meta = (outMetaByUrl as any)?.[u]
        if (meta && typeof meta === 'object') out[u] = meta
      }
      return out
    })(),
    agent1Model: String(agent1Model || ''),
    agent2Model: String(agent2Model || ''),
    genModel: String(genModel || ''),
    genRatio: String(genRatio || ''),
    genRes: String(genRes || ''),

    taskBatchCount: clampInt(taskBatchCount, 1, 20),

    genieTemplateSource,
    genieBaseSetId: String(genieBaseSetId || 'follow-active'),
    genieUseImages,
    genieFlags,
    genieProductAngleCount: clampInt(genieProductAngleCount, 0, 2),
    genieUserIdea: String(genieUserIdea || ''),
    updatedAt: Date.now()
  })

  // persist manifest (cached local paths only)
  useEffect(() => {
    if (!inputHydrated) return
    window.clearTimeout(persistingRef.current.manifest)
    persistingRef.current.manifest = window.setTimeout(() => {
      const m = buildManifest()
      memManifestByWs[workspaceId] = m
      void kvSetJson(psInputKey(workspaceId), m)
    }, 420)
    return () => window.clearTimeout(persistingRef.current.manifest)
  }, [workspaceId, inputHydrated, productAngles, images, slots])

  // persist session (texts + selected models)
  useEffect(() => {
    if (!sessionHydrated) return
    window.clearTimeout(persistingRef.current.session)
    persistingRef.current.session = window.setTimeout(() => {
      const s = buildSession()
      memSessionByWs[workspaceId] = s
      void kvSetJson(psSessionKey(workspaceId), s)
    }, 420)
    return () => window.clearTimeout(persistingRef.current.session)
  }, [workspaceId, sessionHydrated, agent1Template, agent2Template, agent3Template, agent1Output, agent2Output, finalPrompt, outImages, outMetaByUrl, agent1Model, agent2Model, genModel, genRatio, genRes, taskBatchCount, genieTemplateSource, genieBaseSetId, genieUseImages, genieFlags, genieProductAngleCount, genieUserIdea])

  // best-effort flush on unmount
  useEffect(() => {
    return () => {
      try {
        if (inputHydrated) {
          const m = buildManifest()
          memManifestByWs[workspaceId] = m
          void kvSetJson(psInputKey(workspaceId), m)
        }
        if (sessionHydrated) {
          const s = buildSession()
          memSessionByWs[workspaceId] = s
          void kvSetJson(psSessionKey(workspaceId), s)
        }
      } catch {
        // ignore
      }
    }
  }, [workspaceId, inputHydrated, sessionHydrated, productAngles, images, slots, agent1Template, agent2Template, agent3Template, agent1Output, agent2Output, finalPrompt, outImages, outMetaByUrl, agent1Model, agent2Model, genModel, genRatio, genRes, taskBatchCount, genieTemplateSource, genieBaseSetId, genieUseImages, genieFlags, genieProductAngleCount, genieUserIdea])

  const sentItemsAgent1: SentItem[] = useMemo(() => {
    const items: SentItem[] = []
    for (const [i, img] of productAngles.slice(0, MAX_LLM_PRODUCT_ANGLES).entries()) {
      items.push({ label: `产品不同角度图 ${i + 1}`, img })
    }
    if (images['wear_ref']) items.push({ label: '佩戴参考', img: images['wear_ref'] as QuickAppInputImage })
    if (images['model']) items.push({ label: '我们的模特', img: images['model'] as QuickAppInputImage })
    return items
  }, [productAngles, images])

  const sentItemsAgent2: SentItem[] = useMemo(() => {
    const items: SentItem[] = []
    for (const [i, img] of productAngles.slice(0, MAX_LLM_PRODUCT_ANGLES).entries()) {
      items.push({ label: `产品不同角度图 ${i + 1}`, img })
    }
    const orderKeys = ['model', 'outfit', 'scene', 'pose', 'wear_ref'] as const
    const labels: Record<string, string> = {
      model: '我们的模特',
      outfit: '服装参考',
      scene: '场景图',
      pose: '参考姿态图',
      wear_ref: '佩戴参考'
    }
    for (const k of orderKeys) {
      const img = (images as any)[k] as QuickAppInputImage | null
      if (img) items.push({ label: labels[k], img })
    }
    return items
  }, [productAngles, images])

  const sentItemsGen: SentItem[] = useMemo(() => {
    const items: SentItem[] = []
    for (const [i, img] of productAngles.slice(0, MAX_GEN_PRODUCT_ANGLES).entries()) {
      items.push({ label: `产品不同角度图 ${i + 1}`, img })
    }
    const orderKeys = ['model', 'outfit', 'scene', 'pose', 'wear_ref'] as const
    const labels: Record<string, string> = {
      model: '我们的模特',
      outfit: '服装参考',
      scene: '场景图',
      pose: '参考姿态图',
      wear_ref: '佩戴参考'
    }
    for (const k of orderKeys) {
      const img = (images as any)[k] as QuickAppInputImage | null
      if (img) items.push({ label: labels[k], img })
    }
    return items
  }, [productAngles, images])

  const sentSizeAgent1 = useMemo(() => sentItemsAgent1.reduce((sum, it) => sum + (it.img.bytes || 0), 0), [sentItemsAgent1])
  const sentSizeAgent2 = useMemo(() => sentItemsAgent2.reduce((sum, it) => sum + (it.img.bytes || 0), 0), [sentItemsAgent2])
  const sentSizeGen = useMemo(() => sentItemsGen.reduce((sum, it) => sum + (it.img.bytes || 0), 0), [sentItemsGen])

  const cacheInputImage = async (img: QuickAppInputImage, filePrefix: string) => {
    const api = (window as any).nexaAPI
    const id = normalizeId(img)
    const createdAt = Number(img?.createdAt || Date.now())

    const existing = imageLocalPath(img)
    if (existing) {
      return { ...img, id, createdAt, localPath: existing, dataUrl: existing }
    }

    const src = String(img.sourceDataUrl && isDataUrl(img.sourceDataUrl) ? img.sourceDataUrl : img.dataUrl)
    if (!api?.downloadImage || !isDataUrl(src)) {
      return { ...img, id, createdAt }
    }

    try {
      const saved = await api.downloadImage({ url: src, saveDir: CACHE_SAVE_DIR, fileName: `${filePrefix}_${id}` })
      const localPath = String(saved?.localPath || '')
      if (saved?.success && isCachedLocalPath(localPath)) {
        return { ...img, id, createdAt, localPath, dataUrl: localPath, sourceDataUrl: src }
      }
    } catch {
      // ignore
    }
    return { ...img, id, createdAt }
  }

  const removeCachedFile = async (img: QuickAppInputImage | null | undefined) => {
    const api = (window as any).nexaAPI
    const lp = imageLocalPath(img)
    if (!api?.removeInputImageCacheFile || !lp) return
    try {
      await api.removeInputImageCacheFile({ localPath: lp })
    } catch {
      // ignore
    }
  }

  const onProductAnglesChange = (nextRaw: QuickAppInputImage[]) => {
    const next = (nextRaw || []).map(x => ({ ...x, id: normalizeId(x), createdAt: Number(x.createdAt || Date.now()) }))
    const removed = (productAngles || []).filter(p => !next.some(n => String(n.id) === String(p.id)))
    setProductAngles(next)
    // best-effort cleanup removed cached files
    void Promise.all(removed.map(removeCachedFile))

    // cache new images (async)
    void (async () => {
      for (const img of next) {
        if (imageLocalPath(img)) continue
        const cached = await cacheInputImage(img, 'qa_ps_angle')
        const lp = imageLocalPath(cached)
        if (!lp) continue
        setProductAngles(prev => prev.map(p => String(p.id) === String(cached.id) ? cached : p))
      }
    })()
  }

  const onSlotChange = (key: string, nextImg: QuickAppInputImage | null) => {
    const prev = images?.[key] || null
    if (!nextImg) {
      setImages(p => ({ ...p, [key]: null }))
      void removeCachedFile(prev)
      return
    }

    const withId = { ...nextImg, id: normalizeId(nextImg), createdAt: Number(nextImg.createdAt || Date.now()) }
    setImages(p => ({ ...p, [key]: withId }))

    void (async () => {
      const cached = await cacheInputImage(withId, `qa_ps_${key}`)
      const lp = imageLocalPath(cached)
      if (!lp) return
      setImages(p => ({ ...p, [key]: cached }))
    })()
  }

  const runAgent1 = async () => {
    if (missingRequired) {
      uiToast('info', '请先上传至少一张“产品不同角度图”')
      return
    }
    if (!canUseLLM) {
      uiToast('info', '请先在设置中配置“提示词模型/Key”')
      return
    }
    setBusy('agent1')
    try {
      const parts: any[] = []
      parts.push({ type: 'text', text: '以下是输入图片（每张图片前我都会用文字标注用途）。请严格按照系统提示完成输出。' })

      const ensured = await Promise.all((sentItemsAgent1 || []).map(async (it) => ({
        label: it.label,
        img: await ensureQuickAppImageData(it.img)
      })))

      for (const it of ensured) {
        parts.push({ type: 'text', text: `【${it.label}】` })
        parts.push({ type: 'image_url', image_url: { url: String(it.img.sourceDataUrl || it.img.dataUrl || '') } })
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: String(agent1Template || '') },
        { role: 'user', content: parts }
      ]

      const text = await chatCompletionsText({
        baseUrl,
        apiKey: promptApiKey,
        model: effectiveAgent1Model || promptModel,
        messages,
        temperature: 0.4,
        maxTokens: 2000
      })
      setAgent1Output(text)
      uiToast('success', '已生成产品分析')
    } catch (e: any) {
      uiToast('error', e?.message || '生成失败')
    } finally {
      setBusy(null)
    }
  }

  const runAgent2 = async () => {
    if (missingRequired) {
      uiToast('info', '请先上传至少一张“产品不同角度图”')
      return
    }
    if (!canUseLLM) {
      uiToast('info', '请先在设置中配置“提示词模型/Key”')
      return
    }
    if (!String(agent1Output || '').trim()) {
      uiToast('info', '请先运行角色1生成“产品详细信息提示词”')
      return
    }

    setBusy('agent2')
    try {
      const intro = joinNonEmpty([
        '以下是来自角色1的产品详细信息提示词（请作为重要参考）：',
        agent1Output,
        '',
        '请结合输入图片生成【首图拍摄动作】，严格按系统格式输出。'
      ], '\n')

      const parts: any[] = []
      parts.push({ type: 'text', text: intro })

      const ensured = await Promise.all((sentItemsAgent2 || []).map(async (it) => ({
        label: it.label,
        img: await ensureQuickAppImageData(it.img)
      })))

      for (const it of ensured) {
        parts.push({ type: 'text', text: `【${it.label}】` })
        parts.push({ type: 'image_url', image_url: { url: String(it.img.sourceDataUrl || it.img.dataUrl || '') } })
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: String(agent2Template || '') },
        { role: 'user', content: parts }
      ]

      const text = await chatCompletionsText({
        baseUrl,
        apiKey: promptApiKey,
        model: effectiveAgent2Model || promptModel,
        messages,
        temperature: 0.6,
        maxTokens: 2000
      })
      setAgent2Output(text)
      uiToast('success', '已生成首图拍摄动作')
    } catch (e: any) {
      uiToast('error', e?.message || '生成失败')
    } finally {
      setBusy(null)
    }
  }

  const mergeFinal = async () => {
    setBusy('merge')
    try {
      const merged = assembleFinalPrompt({ agent3Template, agent2Output, agent1Output })
      setFinalPrompt(merged)
      uiToast('success', '已合并生成最终提示词')
    } finally {
      setBusy(null)
    }
  }

  const runGenerate = async () => {
    if (missingRequired) {
      uiToast('info', '请先上传至少一张“产品不同角度图”')
      return
    }
    if (!canGenImage) {
      uiToast('info', '请先在设置中配置“生图模型/Key”')
      return
    }
    const prompt = String(finalPrompt || '').trim()
    if (!prompt) {
      uiToast('info', '请先合并生成最终提示词')
      return
    }

    setBusy('gen')
    try {
      const ensured = await Promise.all((sentItemsGen || []).map(async (it) => await ensureQuickAppImageData(it.img)))
      const base64s: string[] = ensured.map(x => String(x.base64 || '').trim()).filter(Boolean)

      const ratioToUse = genRatio === 'Auto' ? '1:1' : genRatio
      const targetSize = getSizeFromRatioAndRes(ratioToUse, genRes)

      let lastReq: any = null
      let lastResp: any = null

      const urls = await generateImage({
        baseUrl,
        apiKey: imageApiKey,
        model: effectiveGenModel || imageModel,
        prompt,
        n: 1,
        size: targetSize,
        aspectRatio: ratioToUse,
        imageSize: genRes,
        image: base64s.length > 0 ? base64s : undefined,
        saveDir,
        onRequest: (req) => {
          lastReq = req
        },
        onResponse: (resp) => {
          lastResp = resp
        }
      })

      const now = Date.now()
      const modelUsed = String(effectiveGenModel || imageModel || '')
      const ratioUsed = String(ratioToUse || '1:1')
      const resUsed = String(genRes || '1K')
      const sizeUsed = String(targetSize || '')

      if (urls && urls.length) {
        setOutMetaByUrl((prev) => {
          const next: any = { ...(prev || {}) }
          for (const u of urls.map(String).filter(Boolean)) {
            if (!next[u]) next[u] = { createdAt: now, model: modelUsed, ratio: ratioUsed, res: resUsed, targetSize: sizeUsed }
          }
          return next
        })

        if (lastReq || lastResp) {
          for (const u of urls.map(String).filter(Boolean)) {
            debugRef.current[u] = { request: lastReq || undefined, response: lastResp || undefined }
          }
          memDebugByWs[workspaceId] = debugRef.current
          setDebugTick(t => t + 1)
        }
      }
      setOutImages((prev) => {
        const merged = [...(urls || []).map(String).filter(Boolean), ...(prev || [])]
        const out: string[] = []
        const seen = new Set<string>()
        for (const u of merged) {
          const s = String(u || '').trim()
          if (!s) continue
          if (seen.has(s)) continue
          seen.add(s)
          out.push(s)
          if (out.length >= 60) break
        }
        return out
      })
      uiToast('success', '已生成图片')
    } catch (e: any) {
      uiToast('error', e?.message || '生成失败')
    } finally {
      setBusy(null)
    }
  }

  const presetSelect = (role: AgentRole, value: string, setter: (t: string) => void) => {
    const id = value || null
    setActivePreset(role, id)
    if (!id) return
    const p = presets.find(x => x.id === id)
    if (p) setter(p.text)
  }

  const saveNewPreset = async (role: AgentRole, text: string) => {
    const title = await uiPrompt('请输入模板名称', { title: '保存为预设', placeholder: '例如：帽子-产品分析' })
    if (!title) return
    const t = String(text || '').trim()
    if (!t) {
      uiToast('info', '模板内容为空')
      return
    }
    addPreset(role, title, t)
    uiToast('success', '已保存预设')
  }

  const overwritePreset = async (role: AgentRole, id: string | null, text: string) => {
    if (!id) {
      uiToast('info', '请先选择一个预设')
      return
    }
    const ok = await uiConfirm('覆盖保存当前预设？', '覆盖保存')
    if (!ok) return
    updatePreset(id, { text: String(text || '') })
    uiToast('success', '已覆盖保存')
  }

  const deletePreset = async (role: AgentRole, id: string | null) => {
    if (!id) {
      uiToast('info', '请先选择一个预设')
      return
    }
    const ok = await uiConfirm('确定删除该预设？', '删除预设')
    if (!ok) return
    removePreset(id)
    setActivePreset(role, null)
    uiToast('success', '已删除')
  }

  return (
    <div className="qa-run ps-run">
      <div className="qa-run-head">
        <Link to="/apps/product_shot" className="qa-back"><ArrowLeft size={18} /> 返回</Link>
        <div className="qa-run-title">
          <div className="n">产品图增强（脚本流程）</div>
          <div className="d">角色1分析产品细节，角色2写拍摄动作，角色3合并生成最终中文提示词</div>
        </div>
      </div>

      <div className="ps-body">
        <div className="qa-panel">
          <div className="qa-panel-title">输入素材</div>
          <div className="qa-field">
            <div className="qa-label">产品不同角度图（必填）</div>
            <MultiImageDrop
              value={productAngles}
              onChange={onProductAnglesChange}
              disabled={Boolean(busy)}
              max={12}
              placeholder="上传产品不同角度图"
            />
          </div>

          {slots.map(s => (
            <div key={s.key} className="qa-field">
              <div className="qa-label">{s.label}</div>
              <ImageDrop
                value={images[s.key] || null}
                onChange={(next) => onSlotChange(s.key, next)}
                disabled={Boolean(busy)}
              />
            </div>
          ))}
        </div>

        <div className="qa-panel">
          <div className="qa-panel-titlebar">
            <div className="qa-panel-title">角色模板</div>
            <button
              className="ps-mini"
              type="button"
              onClick={() => setGenieOpen(true)}
              disabled={Boolean(busy)}
              title="提示词精灵：根据你的想法生成一套三角色模板"
            >
              <Bot size={14} /> 提示词精灵
            </button>
          </div>

          <div className="ps-setbar">
            <div className="ps-setbar-k">模板组</div>
            <div className="ps-setbar-v">
              <select
                className="ps-select"
                value={activePromptSetId || ''}
                onChange={async (e) => {
                  const id = String(e.target.value || '').trim()
                  if (!id) {
                    setActivePromptSetId('')
                    setActiveSet('product_shot', null)
                    lastAppliedSetRef.current = null
                    return
                  }
                  const s = setsForProductShot.find(x => x.id === id)
                  if (s) await applyPromptSet(s)
                }}
                disabled={Boolean(busy)}
              >
                <option value="">选择模板组...</option>
                {setsForProductShot.map(s => (
                  <option key={s.id} value={s.id}>{s.category ? `${s.category} / ${s.name}` : s.name}</option>
                ))}
              </select>

              <button className="ps-btn" type="button" onClick={() => void saveAsPromptSet()} disabled={Boolean(busy)} title="保存当前三段模板与生图参数到提示词库">保存到库</button>
              <button className="ps-btn" type="button" onClick={() => void overwritePromptSet()} disabled={Boolean(busy)} title="覆盖保存当前选中的模板组">覆盖</button>
              <button className="ps-btn danger" type="button" onClick={() => void deletePromptSet()} disabled={Boolean(busy)} title="删除当前模板组">删除</button>
              <button
                className="ps-btn"
                type="button"
                onClick={() => navigate(`/apps/prompts?back=${encodeURIComponent('/apps/product_shot?view=studio')}`)}
                disabled={Boolean(busy)}
                title="打开提示词库"
              >
                管理
              </button>
            </div>
          </div>

          <div className="ps-role">
            <div className="ps-role-head">
              <div className="ps-role-title">角色1：产品分析师</div>
              <div className="ps-role-actions">
                 <button className="ps-iconbtn" type="button" onClick={() => void editText('角色1模板：产品分析师', agent1Template, setAgent1Template)} title="展开编辑">
                   <Maximize2 size={16} />
                 </button>
              </div>
            </div>
            <div className="ps-inline">
              <div className="ps-inline-k">模型</div>
              <div className="ps-inline-v">
                <ModelPicker
                  value={effectiveAgent1Model}
                  placeholder={promptModel ? `跟随默认（${promptModel}）` : '跟随默认（未选择）'}
                  commonModels={promptPinned}
                  allModels={allModels}
                  onChange={setAgent1Model}
                  disabled={Boolean(busy)}
                />
                <button
                  className="ps-mini"
                  type="button"
                  onClick={() => setShowAgent1Sent(v => !v)}
                  disabled={Boolean(busy)}
                  title="查看实际发送给 AI 的参考图（压缩后）"
                >
                  <Images size={14} /> 发送参考图 {sentItemsAgent1.length}{sentSizeAgent1 ? `（${formatBytes(sentSizeAgent1)}）` : ''}
                </button>
              </div>
            </div>
            {showAgent1Sent ? (
              <SentImagesPanel title={`角色1 发送参考图（最多 ${MAX_LLM_PRODUCT_ANGLES} 张产品角度图）`} items={sentItemsAgent1} />
            ) : null}
            <textarea className="ps-textarea" value={agent1Template} onChange={(e) => setAgent1Template(e.target.value)} spellCheck={false} />
            <button className="qa-primary" type="button" onClick={() => void runAgent1()} disabled={Boolean(busy)}>
              <Play size={16} /> {busy === 'agent1' ? '分析中...' : '运行角色1（产品分析）'}
            </button>
          </div>

          <div className="ps-role" style={{ marginTop: 12 }}>
            <div className="ps-role-head">
              <div className="ps-role-title">角色2：摄影导演</div>
              <div className="ps-role-actions">
                 <button className="ps-iconbtn" type="button" onClick={() => void editText('角色2模板：摄影导演', agent2Template, setAgent2Template)} title="展开编辑">
                   <Maximize2 size={16} />
                 </button>
              </div>
            </div>
            <div className="ps-inline">
              <div className="ps-inline-k">模型</div>
              <div className="ps-inline-v">
                <ModelPicker
                  value={effectiveAgent2Model}
                  placeholder={promptModel ? `跟随默认（${promptModel}）` : '跟随默认（未选择）'}
                  commonModels={promptPinned}
                  allModels={allModels}
                  onChange={setAgent2Model}
                  disabled={Boolean(busy)}
                />
                <button
                  className="ps-mini"
                  type="button"
                  onClick={() => setShowAgent2Sent(v => !v)}
                  disabled={Boolean(busy)}
                  title="查看实际发送给 AI 的参考图（压缩后）"
                >
                  <Images size={14} /> 发送参考图 {sentItemsAgent2.length}{sentSizeAgent2 ? `（${formatBytes(sentSizeAgent2)}）` : ''}
                </button>
              </div>
            </div>
            {showAgent2Sent ? (
              <SentImagesPanel title={`角色2 发送参考图（最多 ${MAX_LLM_PRODUCT_ANGLES} 张产品角度图）`} items={sentItemsAgent2} />
            ) : null}
            <textarea className="ps-textarea" value={agent2Template} onChange={(e) => setAgent2Template(e.target.value)} spellCheck={false} />
            <button className="qa-primary" type="button" onClick={() => void runAgent2()} disabled={Boolean(busy)}>
              <Play size={16} /> {busy === 'agent2' ? '生成中...' : '运行角色2（首图拍摄动作）'}
            </button>
          </div>

          <div className="ps-role" style={{ marginTop: 12 }}>
            <div className="ps-role-head">
              <div className="ps-role-title">角色3：生图执行者（拼装模板）</div>
              <div className="ps-role-actions">
                 <button className="ps-iconbtn" type="button" onClick={() => void editText('角色3模板：生图执行者', agent3Template, setAgent3Template)} title="展开编辑">
                   <Maximize2 size={16} />
                 </button>
              </div>
            </div>
            <div className="ps-inline">
              <div className="ps-inline-k">生图模型</div>
              <div className="ps-inline-v">
                <ModelPicker
                  value={effectiveGenModel}
                  placeholder={imageModel ? `跟随默认（${imageModel}）` : '跟随默认（未选择）'}
                  commonModels={imagePinned}
                  allModels={allModels}
                  onChange={setGenModel}
                  disabled={Boolean(busy)}
                />
                <button
                  className="ps-mini"
                  type="button"
                  onClick={() => setShowGenSent(v => !v)}
                  disabled={Boolean(busy)}
                  title="查看实际发送给生图接口的参考图（压缩后）"
                >
                  <Images size={14} /> 发送参考图 {sentItemsGen.length}{sentSizeGen ? `（${formatBytes(sentSizeGen)}）` : ''}
                </button>

                <button
                  className="ps-mini"
                  type="button"
                  onClick={() => setGenParamsOpen(v => !v)}
                  disabled={Boolean(busy)}
                  title="展开设置比例与分辨率"
                >
                  <Settings2 size={14} /> 参数
                </button>
              </div>
            </div>
            {genParamsOpen ? (
              <div className="ps-genparams">
                <div className="ps-genparams-row">
                  <div className="k">比例</div>
                  <div className="v">
                    <select className="ps-select" value={genRatio} onChange={(e) => setGenRatio(e.target.value as any)}>
                      <option value="Auto">Auto（1:1）</option>
                      <option value="1:1">1:1</option>
                      <option value="3:4">3:4</option>
                      <option value="4:3">4:3</option>
                      <option value="9:16">9:16</option>
                      <option value="16:9">16:9</option>
                      <option value="2:3">2:3</option>
                      <option value="3:2">3:2</option>
                      <option value="21:9">21:9</option>
                    </select>
                  </div>
                </div>
                <div className="ps-genparams-row">
                  <div className="k">分辨率</div>
                  <div className="v">
                    <select className="ps-select" value={genRes} onChange={(e) => setGenRes(e.target.value as any)}>
                      <option value="1K">1K</option>
                      <option value="2K">2K</option>
                      <option value="4K">4K</option>
                    </select>
                    <div className="ps-genparams-hint">实际像素（非 comfly）：{getSizeFromRatioAndRes(genRatio === 'Auto' ? '1:1' : genRatio, genRes)}</div>
                  </div>
                </div>
              </div>
            ) : null}
            {showGenSent ? (
              <SentImagesPanel title={`生图 发送参考图（最多 ${MAX_GEN_PRODUCT_ANGLES} 张产品角度图）`} items={sentItemsGen} />
            ) : null}
            <textarea className="ps-textarea" value={agent3Template} onChange={(e) => setAgent3Template(e.target.value)} spellCheck={false} />
            <button className="qa-primary" type="button" onClick={() => void mergeFinal()} disabled={Boolean(busy)}>
              <Sparkles size={16} /> {busy === 'merge' ? '合并中...' : '合并生成最终提示词'}
            </button>
          </div>
        </div>

        <div className="qa-panel">
          <div className="qa-panel-title">输出与生成</div>

          <div className="ps-out">
            <div className="ps-out-head">
              <div className="ps-out-title">角色1输出：产品详细信息提示词</div>
              <div className="ps-out-actions">
                <button className="ps-iconbtn" type="button" onClick={() => copyText(agent1Output)} title="复制"><Copy size={16} /></button>
                 <button className="ps-iconbtn" type="button" onClick={() => void editText('角色1输出：产品详细信息提示词', agent1Output, setAgent1Output)} title="展开编辑"><Maximize2 size={16} /></button>
              </div>
            </div>
            <textarea className="ps-outarea" value={agent1Output} onChange={(e) => setAgent1Output(e.target.value)} placeholder="运行角色1后输出会显示在这里..." spellCheck={false} />
          </div>

          <div className="ps-out" style={{ marginTop: 12 }}>
            <div className="ps-out-head">
              <div className="ps-out-title">角色2输出：首图拍摄动作（可修改）</div>
              <div className="ps-out-actions">
                <button className="ps-iconbtn" type="button" onClick={() => copyText(agent2Output)} title="复制"><Copy size={16} /></button>
                 <button className="ps-iconbtn" type="button" onClick={() => void editText('角色2输出：首图拍摄动作', agent2Output, setAgent2Output)} title="展开编辑"><Maximize2 size={16} /></button>
              </div>
            </div>
            <textarea className="ps-outarea" value={agent2Output} onChange={(e) => setAgent2Output(e.target.value)} placeholder="运行角色2后输出会显示在这里..." spellCheck={false} />
          </div>

          <div className="ps-out" style={{ marginTop: 12 }}>
            <div className="ps-out-head">
              <div className="ps-out-title">最终生图提示词（中文，可修改）</div>
              <div className="ps-out-actions">
                <button className="ps-iconbtn" type="button" onClick={() => copyText(finalPrompt)} title="复制"><Copy size={16} /></button>
                 <button className="ps-iconbtn" type="button" onClick={() => void editText('最终生图提示词（中文）', finalPrompt, setFinalPrompt)} title="展开编辑"><Maximize2 size={16} /></button>
                <button className="ps-runbtn" type="button" onClick={() => void runGenerate()} disabled={Boolean(busy)}>
                  <Play size={16} /> {busy === 'gen' ? '生图中...' : '开始生图'}
                </button>

                <div className="ps-batch-control" title="发布任务次数">
                  <button className="ps-batch-btn" type="button" onClick={decTaskBatch} disabled={Boolean(busy) || taskBatchCount <= 1} aria-label="减少发布次数">
                    <Minus size={14} />
                  </button>
                  <span className="ps-batch-value">{taskBatchCount}</span>
                  <button className="ps-batch-btn" type="button" onClick={incTaskBatch} disabled={Boolean(busy) || taskBatchCount >= 20} aria-label="增加发布次数">
                    <Plus size={14} />
                  </button>
                </div>
                <button className="ps-runbtn ghost" type="button" onClick={() => void createTask()} disabled={Boolean(busy)} title={`创建任务（x${taskBatchCount}）并后台自动跑全流程`}>
                  <Sparkles size={16} /> {busy === 'task' ? '创建中...' : '开始任务'}
                </button>
              </div>
            </div>
            <textarea className="ps-outarea" value={finalPrompt} onChange={(e) => setFinalPrompt(e.target.value)} placeholder="点击“合并生成最终提示词”后会显示在这里..." spellCheck={false} />
            {!provider ? (
              <div className="qa-hint">请先在设置里配置 API 网站</div>
            ) : null}
            {provider && (!promptApiKey || !promptModel) ? (
              <div className="qa-hint">提示词模型未配置：请在设置中选择提示词模型并配置 prompt Key</div>
            ) : null}
            {provider && (!imageApiKey || !imageModel) ? (
              <div className="qa-hint">生图模型未配置：请在设置中选择生图模型并配置 image Key</div>
            ) : null}
          </div>

          <div className="ps-out" style={{ marginTop: 12 }}>
            <div className="ps-out-head">
              <div className="ps-out-title">生成结果</div>
              <div className="ps-out-sub">（点击图片可在新窗口查看/保存：后续再加）</div>
            </div>
            {outImages.length === 0 ? (
              <div className="qa-empty">
                <div className="t">还没有结果</div>
                <div className="d">合并提示词后点击“开始生图”。</div>
              </div>
            ) : (
              <div className="ps-result-grid">
                {outImages.map((u, i) => (
                  <div key={`${u}_${i}`} className="ps-result-item">
                    <img
                      src={u}
                      alt={`result_${i}`}
                      draggable={false}
                      onLoad={(e) => {
                        const img = e.currentTarget
                        const actual = `${img.naturalWidth}x${img.naturalHeight}`
                        setOutMetaByUrl((prev) => {
                          const next: any = { ...(prev || {}) }
                          const cur = next[u]
                          if (cur && cur.actualSize === actual) return prev
                          next[u] = { ...(cur || { createdAt: Date.now(), model: String(effectiveGenModel || imageModel || ''), ratio: String(genRatio === 'Auto' ? '1:1' : genRatio), res: String(genRes), targetSize: getSizeFromRatioAndRes(genRatio === 'Auto' ? '1:1' : genRatio, genRes) }), actualSize: actual }
                          return next
                        })
                      }}
                      onDoubleClick={() => {
                        setPreviewUrl(u)
                        setPreviewMsg('')
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ProductShotPromptGenie
        open={genieOpen}
        onClose={() => setGenieOpen(false)}
        disabled={Boolean(busy)}
        providerId={effectiveProviderId ? effectiveProviderId : null}
        baseUrl={baseUrl}
        apiKey={promptApiKey}
        model={String(effectiveAgent2Model || promptModel || '').trim()}
        templateSource={genieTemplateSource}
        onTemplateSourceChange={setGenieTemplateSource}
        baseSetId={genieBaseSetId}
        onBaseSetIdChange={setGenieBaseSetId}
        useImages={genieUseImages}
        onUseImagesChange={setGenieUseImages}
        flags={genieFlags}
        onFlagsChange={(patch) => setGenieFlags(prev => ({ ...prev, ...(patch as any) }))}
        productAngleCount={genieProductAngleCount}
        onProductAngleCountChange={(v) => setGenieProductAngleCount(clampInt(v, 0, 2))}
        userIdea={genieUserIdea}
        onUserIdeaChange={setGenieUserIdea}
        editorTemplates={{ agent1Template, agent2Template, agent3Template }}
        activeSet={activePromptSetObj}
        productAngles={productAngles}
        slots={images as any}
        onApplyAll={(t) => {
          setAgent1Template(String(t.agent1Template || ''))
          setAgent2Template(String(t.agent2Template || ''))
          setAgent3Template(String(t.agent3Template || ''))
        }}
      />

      {/* Preview modal (same behavior as ImageGen) */}
      <div className={`ps-preview-modal ${previewUrl ? 'show' : ''}`} onMouseDown={() => setPreviewUrl(null)}>
        {previewUrl ? (
          <div className="ps-preview-card" onMouseDown={(e) => e.stopPropagation()}>
            <button className="ps-preview-close" type="button" onClick={() => setPreviewUrl(null)} aria-label="关闭">
              <X size={22} />
            </button>
            <div className="ps-preview-media">
              <img
                src={previewUrl}
                alt="Preview"
                className="ps-preview-img"
                onLoad={(e) => {
                  const img = e.currentTarget
                  const actual = `${img.naturalWidth}x${img.naturalHeight}`
                  const url = String(previewUrl)
                  setOutMetaByUrl((prev) => {
                    const next: any = { ...(prev || {}) }
                    const cur = next[url]
                    if (cur && cur.actualSize === actual) return prev
                    next[url] = { ...(cur || { createdAt: Date.now(), model: String(effectiveGenModel || imageModel || ''), ratio: String(genRatio === 'Auto' ? '1:1' : genRatio), res: String(genRes), targetSize: getSizeFromRatioAndRes(genRatio === 'Auto' ? '1:1' : genRatio, genRes) }), actualSize: actual }
                    return next
                  })
                }}
              />
            </div>
            <div className="ps-preview-side">
              <div className="ps-preview-title">图片操作</div>
              <div className="ps-preview-actions">
                <button
                  type="button"
                  className="ps-preview-btn"
                  onClick={async () => {
                    const url = String(previewUrl)
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
                  className="ps-preview-btn"
                  onClick={async () => {
                    const url = String(previewUrl)
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
                  className="ps-preview-btn"
                  onClick={async () => {
                    const req = (previewDebug as any)?.request
                    if (!req || !req.url) {
                      setPreviewMsg('无请求信息（可能是旧结果或未记录）')
                      return
                    }
                    const text = formatRequestDebugForCopy(req)
                    try {
                      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                      await navigator.clipboard.writeText(text)
                      setPreviewMsg('已复制请求代码（已脱敏）')
                    } catch {
                      uiTextViewer(text, { title: '复制失败，请手动复制（已脱敏）', size: 'lg' })
                      setPreviewMsg('复制失败：已弹出手动复制框')
                    }
                  }}
                  title="复制本次调用 API 的请求代码（已脱敏）"
                >
                  复制请求
                </button>

                <button
                  type="button"
                  className="ps-preview-btn primary"
                  onClick={async () => {
                    if (busy) return
                    setPreviewMsg('已提交重新制作任务')
                    await runGenerate()
                  }}
                  title="用当前提示词/参数重新制作 1 张"
                >
                  重新制作
                </button>
              </div>

              <div className="ps-preview-info">
                <div className="ps-preview-info-title">信息</div>
                <div className="ps-preview-kv">
                  <div className="k">文件</div>
                  <div className="v" title={previewAbsPath || previewUrl || ''}>{previewFileName || (previewAbsPath ? getFileNameFromPath(String(previewAbsPath)) : '-') || '-'}</div>

                  <div className="k">模型</div>
                  <div className="v">{String((previewMeta as any)?.model || effectiveGenModel || imageModel || '-')}</div>

                  <div className="k">期望比例</div>
                  <div className="v">{String((previewMeta as any)?.ratio || (genRatio === 'Auto' ? '1:1' : genRatio) || '-')}</div>

                  <div className="k">分辨率</div>
                  <div className="v">{String((previewMeta as any)?.res || genRes || '-')}</div>

                  <div className="k">期望尺寸</div>
                  <div className="v">{String((previewMeta as any)?.targetSize || '-') || '-'}</div>

                  <div className="k">实际尺寸</div>
                  <div className="v">{String((previewMeta as any)?.actualSize || '-') || '-'}</div>
                </div>
              </div>

              <div className="ps-preview-debug" aria-label="接口返回调试信息">
                <div className="ps-preview-debug-head">
                  <div className="t">接口返回</div>
                  <button
                    type="button"
                    className="ps-preview-debug-btn"
                    onClick={async () => {
                      const t = String((previewDebug as any)?.response?.dataPreview || '')
                      if (!t.trim()) {
                        setPreviewMsg('暂无可复制的返回内容')
                        return
                      }
                      try {
                        if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                        await navigator.clipboard.writeText(t)
                        setPreviewMsg('已复制接口返回')
                      } catch {
                        uiTextViewer(t, { title: '复制失败，请手动复制', size: 'lg' })
                        setPreviewMsg('复制失败：已弹出手动复制框')
                      }
                    }}
                    title="复制接口返回内容（已脱敏）"
                  >
                    复制返回
                  </button>
                </div>
                <textarea
                  className="ps-preview-debug-box"
                  readOnly
                  value={String((previewDebug as any)?.response?.dataPreview || '')}
                />
              </div>

              {previewMsg ? (
                <div className="ps-preview-msg">{previewMsg}</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
