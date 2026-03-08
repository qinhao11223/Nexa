import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, Film, Plus, Minus, Sparkles, Trash2, Library as LibraryIcon, X } from 'lucide-react'
import type { VideoGenMode } from '../VideoGen'
import { useNavigate } from 'react-router-dom'
import { useSettingsStore } from '../../settings/store'
import { resolveApiKey } from '../../settings/utils/apiKeys'
import CompactModelPicker from '../../image_gen/components/CompactModelPicker'
import OptimizeSystemPromptEditor from '../../image_gen/components/OptimizeSystemPromptEditor'
import VideoDesktopGrid from '../components/desktop/VideoDesktopGrid'
import VideoPreviewModal from '../components/VideoPreviewModal'
import ConfirmModal from '../components/ConfirmModal'
import { useVideoGenStore } from '../store'
import { ReferenceImagesModal, type RefImage } from '../components/ReferenceImages'
import PromptLinkPanel from '../../image_gen/components/PromptLinkPanel'
import CreativeCollectionsPanel from '../../image_gen/components/CreativeCollectionsPanel'
import { takePendingPromptLink } from '../../creative_library/promptLink'
import { useCreativeLibraryStore } from '../../creative_library/store'
import { loadVideoUiPersisted, saveVideoUiPersisted } from '../utils/persistUi'
import { uiToast } from '../../ui/toastStore'
import { kvGetJsonMigrate, kvSetJson } from '../../../core/persist/kvClient'
import { useVideoPromptOpsStore } from '../promptOpsStore'
import { uiTextEditor } from '../../ui/dialogStore'

const MAX_INPUT_IMAGES = 20
const I2V_INPUT_MANIFEST_KEY = 'nexa-video-i2v-input-manifest:v1'

type InputManifestItem = { id: string, name: string, localPath: string, createdAt: number }

function makeRefId() {
  return `vref_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function likelyImageFile(f: File) {
  const t = String((f as any)?.type || '').toLowerCase()
  if (t.startsWith('image/')) return true
  const n = String(f?.name || '').toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].some(ext => n.endsWith(ext))
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(file)
  })
}

async function filesToRefImages(files: File[]): Promise<RefImage[]> {
  const out: RefImage[] = []
  for (const f of files) {
    if (!likelyImageFile(f)) continue
    const dataUrl = await readAsDataUrl(f)
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : ''
    if (!base64) continue
    out.push({ id: makeRefId(), dataUrl, base64, sourceDataUrl: dataUrl, name: f.name || 'image', createdAt: Date.now() })
  }
  return out
}

function isDataUrl(s: string) {
  return /^data:/i.test(String(s || ''))
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(blob)
  })
}

async function srcToDataUrl(src: string): Promise<string> {
  const s = String(src || '').trim()
  if (!s) throw new Error('missing src')
  if (isDataUrl(s)) return s
  const resp = await fetch(s)
  if (!resp.ok) throw new Error(`读取缓存图片失败：${resp.status}`)
  const blob = await resp.blob()
  return await blobToDataUrl(blob)
}

export default function ImageToVideo(props: { onSwitchMode: (mode: VideoGenMode) => void }) {
  const { onSwitchMode } = props

  const navigate = useNavigate()
  const setLibraryMode = useCreativeLibraryStore(s => s.setActiveMode)

  const { providers, activeProviderId, videoProviderId, updateProvider, videoOutputDirectory, videoAutoSaveEnabled } = useSettingsStore()
  const providerId = videoProviderId || activeProviderId
  const activeProvider = providers.find(p => p.id === providerId)

  const tasks = useVideoGenStore(s => s.tasks)
  const clearTasksByMode = useVideoGenStore(s => s.clearTasksByMode)
  const deleteTask = useVideoGenStore(s => s.deleteTask)
  const deleteTasks = useVideoGenStore(s => s.deleteTasks)
  const enqueueBatch = useVideoGenStore(s => s.enqueueBatch)

  const i2vTasks = useMemo(() => tasks.filter(t => t.mode === 'i2v'), [tasks])

  const availableModels = activeProvider?.models || []
  const currentVideoModel = activeProvider?.selectedVideoModel || ''
  const currentPromptModel = activeProvider?.selectedPromptModel || ''
  const currentTranslateModel = (activeProvider as any)?.selectedTranslateModel || currentPromptModel
  const pinnedVideoModels = activeProvider?.pinnedVideoModels || []
  const pinnedPromptModels = activeProvider?.pinnedPromptModels || []

  const defaults = useMemo(() => ({
    prompt: '',
    durationSec: 5,
    aspectRatio: '16:9' as const,
    batchCount: 1,
    enhancePrompt: false,
    enableUpsample: false
  }), [])

  const [prompt, setPrompt] = useState(defaults.prompt)
  const [durationSec, setDurationSec] = useState(defaults.durationSec)
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>(defaults.aspectRatio)
  const [batchCount, setBatchCount] = useState(defaults.batchCount)

  const [optimizePreference, setOptimizePreference] = useState('')
  const [injectOptimizeCustomText, setInjectOptimizeCustomText] = useState('')
  const busyOp = useVideoPromptOpsStore(s => s.byMode.i2v.busy)
  const lastResult = useVideoPromptOpsStore(s => s.byMode.i2v.lastResult)
  const startOptimize = useVideoPromptOpsStore(s => s.optimize)
  const startTranslate = useVideoPromptOpsStore(s => s.translate)
  const hydrateHistory = useVideoPromptOpsStore(s => s.hydrateHistory)
  const lastAppliedAtRef = useRef(0)

  useEffect(() => {
    hydrateHistory('i2v')
  }, [hydrateHistory])

  const isVeoModel = useMemo(() => /^\s*veo/i.test(currentVideoModel), [currentVideoModel])
  const hasCjk = useMemo(() => /[\u4e00-\u9fff]/.test(prompt), [prompt])
  const [enhancePrompt, setEnhancePrompt] = useState(defaults.enhancePrompt)
  const [enableUpsample, setEnableUpsample] = useState(defaults.enableUpsample)

  const [veoOptionsOpen, setVeoOptionsOpen] = useState(false)

  const [uiHydrated, setUiHydrated] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const s = await loadVideoUiPersisted('i2v', defaults)
        if (!alive) return
        setPrompt(s.prompt)
        setDurationSec(s.durationSec)
        setAspectRatio(s.aspectRatio)
        setBatchCount(s.batchCount)
        setEnhancePrompt(s.enhancePrompt)
        setEnableUpsample(s.enableUpsample)
      } finally {
        if (alive) setUiHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [defaults])

  // persist UI (i2v) - excludes reference images
  useEffect(() => {
    if (!uiHydrated) return
    const t = window.setTimeout(() => {
      void saveVideoUiPersisted('i2v', { prompt, durationSec, aspectRatio, batchCount, enhancePrompt, enableUpsample })
    }, 360)
    return () => window.clearTimeout(t)
  }, [uiHydrated, prompt, durationSec, aspectRatio, batchCount, enhancePrompt, enableUpsample])

  // Apply prompt updates from background ops (survive navigation)
  useEffect(() => {
    if (!lastResult) return
    const at = Number(lastResult.at || 0)
    if (!Number.isFinite(at) || at <= 0) return
    if (at <= lastAppliedAtRef.current) return
    lastAppliedAtRef.current = at
    setPrompt(String(lastResult.text || ''))
  }, [lastResult])

  const [inputImages, setInputImages] = useState<RefImage[]>([])
  const [isGalleryOpen, setIsGalleryOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [inputHydrated, setInputHydrated] = useState(false)

  // hydrate cached input images (persisted manifest)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const items = await kvGetJsonMigrate<InputManifestItem[]>(I2V_INPUT_MANIFEST_KEY, [])
        if (!alive) return
        const next: RefImage[] = (items || [])
          .filter(x => x && x.id && x.localPath)
          .slice(0, MAX_INPUT_IMAGES)
          .map(x => ({
            id: String(x.id),
            name: String(x.name || 'image'),
            dataUrl: String(x.localPath),
            localPath: String(x.localPath),
            createdAt: Number(x.createdAt || Date.now())
          }))
        setInputImages(next)
      } catch {
        // ignore
      } finally {
        if (alive) setInputHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // persist manifest (only local cached items)
  useEffect(() => {
    if (!inputHydrated) return
    const items: InputManifestItem[] = inputImages
      .map(x => ({
        id: String(x.id || ''),
        name: String(x.name || 'image'),
        localPath: String(x.localPath || x.dataUrl || ''),
        createdAt: Number(x.createdAt || Date.now())
      }))
      .filter(x => x.id && x.localPath && /^nexa:\/\//i.test(x.localPath))
      .slice(0, MAX_INPUT_IMAGES)
    void kvSetJson(I2V_INPUT_MANIFEST_KEY, items)
  }, [inputHydrated, inputImages])

  const pickFile = () => {
    fileInputRef.current?.click()
  }

  const ensureImageData = async (img: RefImage): Promise<RefImage> => {
    if (img.base64 && img.sourceDataUrl && isDataUrl(img.sourceDataUrl)) return img

    const previewSrc = String(img.localPath || img.dataUrl || '')
    const dataUrl = img.sourceDataUrl && isDataUrl(img.sourceDataUrl)
      ? img.sourceDataUrl
      : await srcToDataUrl(previewSrc)
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : ''
    return {
      ...img,
      sourceDataUrl: dataUrl,
      base64: base64 || img.base64
    }
  }

  const removeCachedFile = async (img: RefImage) => {
    const api = (window as any).nexaAPI
    const localPath = String(img.localPath || '')
    if (!api?.removeInputImageCacheFile || !localPath) return
    try {
      await api.removeInputImageCacheFile({ localPath })
    } catch {
      // ignore
    }
  }

  const clearAllInputImages = async () => {
    const list = [...inputImages]
    setInputImages([])
    // best-effort delete cached files
    await Promise.all(list.map(removeCachedFile))
    try {
      await kvSetJson(I2V_INPUT_MANIFEST_KEY, [])
    } catch {
      // ignore
    }
  }

  const addFiles = async (fileList: FileList | File[] | null | undefined) => {
    const files = Array.from(fileList || [])
    if (!files.length) return

    const remain = Math.max(0, MAX_INPUT_IMAGES - inputImages.length)
    if (remain <= 0) {
      uiToast('info', `最多上传 ${MAX_INPUT_IMAGES} 张参考图`)
      return
    }

    const picked = files.filter(likelyImageFile).slice(0, remain)
    if (!picked.length) {
      uiToast('info', '未识别到可用图片文件')
      return
    }

    try {
      const api = (window as any).nexaAPI
      const refs = await filesToRefImages(picked)
      if (!refs.length) {
        uiToast('error', '读取图片失败')
        return
      }

      const out: RefImage[] = []
      for (const r of refs) {
        const src = String(r.sourceDataUrl || r.dataUrl || '')
        if (api?.downloadImage && isDataUrl(src)) {
          try {
            const saved = await api.downloadImage({ url: src, saveDir: 'cache/input-images/i2v', fileName: `i2v_ref_${r.id}` })
            const localPath = String(saved?.localPath || '')
            if (saved?.success && localPath) {
              out.push({ ...r, dataUrl: localPath, localPath })
              continue
            }
          } catch {
            // ignore
          }
        }

        // Fallback: keep in-memory only (not persisted)
        out.push(r)
      }

      setInputImages(prev => [...prev, ...out].slice(0, MAX_INPUT_IMAGES))
    } catch (err: any) {
      uiToast('error', err?.message || '读取图片失败')
    }
  }

  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null)
  const previewTask = useMemo(() => i2vTasks.find(t => t.id === previewTaskId) || null, [i2vTasks, previewTaskId])

  const [confirmClearOpen, setConfirmClearOpen] = useState(false)

  // 从创意库返回后，一次性写入 Prompt / 优化偏好
  useEffect(() => {
    const pending = takePendingPromptLink('i2v')
    if (!pending) return
    if (pending.target === 'prompt') {
      setPrompt(pending.text)
    } else {
      setInjectOptimizeCustomText(pending.text)
    }
  }, [])

  const handleOptimize = () => {
    if (!prompt.trim()) return
    if (!activeProvider) {
      uiToast('info', '请先在设置中选择或配置 API 网站')
      return
    }
    const promptApiKey = resolveApiKey(activeProvider, 'prompt')
    if (!promptApiKey) {
      uiToast('error', '请先在设置中配置“优化 Key”')
      return
    }
    if (!currentPromptModel) {
      uiToast('info', '请先选择用于“优化”的提示词模型')
      return
    }

    startOptimize({
      mode: 'i2v',
      baseUrl: activeProvider.baseUrl,
      apiKey: promptApiKey,
      model: currentPromptModel,
      prompt,
      preference: optimizePreference,
      refImages: inputImages,
      fallbackUi: defaults
    })
  }

  const handleTranslate = () => {
    if (!prompt.trim()) return
    if (!activeProvider) {
      uiToast('info', '请先在设置中选择或配置 API 网站')
      return
    }
    const translateApiKey = resolveApiKey(activeProvider, 'translate')
    if (!translateApiKey) {
      uiToast('error', '请先在设置中配置“翻译 Key”')
      return
    }
    if (!currentTranslateModel) {
      uiToast('info', '请先在设置中选择“提示词翻译模型”')
      return
    }

    startTranslate({
      mode: 'i2v',
      baseUrl: activeProvider.baseUrl,
      apiKey: translateApiKey,
      model: currentTranslateModel,
      prompt,
      preference: optimizePreference,
      fallbackUi: defaults
    })
  }

  const handleGenerate = async () => {
    if (!inputImages.length) {
      uiToast('info', '请先上传参考图片')
      return
    }
    if (!prompt.trim()) {
      uiToast('info', '请先输入提示词')
      return
    }
    if (!activeProvider || !providerId) {
      uiToast('info', '请先在设置中选择或配置 API 网站')
      return
    }
    if (!currentVideoModel) {
      uiToast('info', '请先选择生视频模型')
      return
    }

    const videoApiKey = resolveApiKey(activeProvider, 'video')
    if (!videoApiKey) {
      uiToast('error', '请先在设置中配置“视频 Key”')
      return
    }

    if (isVeoModel && hasCjk && !enhancePrompt) {
      uiToast('info', '当前 Veo 模型通常只支持英文提示词。请先把提示词翻译为英文，或开启“增强提示词（英文）”。')
      return
    }

    const ensured = await Promise.all(inputImages.map(ensureImageData))
    setInputImages(ensured)
    if (ensured.some(x => !String(x.base64 || '').trim())) {
      uiToast('error', '参考图读取失败，请重新上传')
      return
    }

    enqueueBatch({
      mode: 'i2v',
      providerId,
      baseUrl: activeProvider.baseUrl,
      apiKey: videoApiKey,
      model: currentVideoModel,
      prompt,
      durationSec,
      aspectRatio,
      batchCount,
      enhancePrompt,
      enableUpsample,
      inputImagesBase64: ensured.map(x => String(x.base64 || '')),
      inputImageNames: ensured.map(x => String(x.name || 'image')),
      autoSaveDir: videoAutoSaveEnabled ? videoOutputDirectory : undefined
    })
  }

  return (
    <div className="vg-layout">
      <div className="vg-left">
        <div className="vg-panel">
          <div className="vg-block-head">
            <div className="vg-block-title"><ImageIcon size={16} /> 参考图</div>
            <div className="vg-block-actions">
              <button
                type="button"
                className="vg-mini-btn"
                onClick={() => void clearAllInputImages()}
                disabled={inputImages.length === 0}
                title="清空"
              >
                清空
              </button>
              <button
                type="button"
                className="vg-mini-btn"
                onClick={() => {
                  if (inputImages.length === 0) {
                    pickFile()
                    return
                  }
                  setIsGalleryOpen(true)
                }}
                title={inputImages.length === 0 ? '上传图片' : '展开管理'}
              >
                展开
              </button>
            </div>
          </div>

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
              await addFiles(e.dataTransfer?.files || [])
            }}
            style={{
              borderColor: dragOver ? 'rgba(0, 229, 255, 0.55)' : undefined,
              color: dragOver ? '#00e5ff' : undefined
            }}
            title={`点击选择图片，或拖拽图片到此区域（最多 ${MAX_INPUT_IMAGES} 张）`}
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
                  <div key={img.id || `${img.name}_${idx}`} className="ig-upload-thumb" title={img.name}>
                    <img src={img.dataUrl} alt={img.name} />
                    <button
                      type="button"
                      className="ig-upload-remove"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeCachedFile(img)
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
                <span style={{ fontSize: '0.75rem', marginTop: 4 }}>可拖拽图片到此区域（最多 {MAX_INPUT_IMAGES} 张）</span>
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
                } finally {
                  e.target.value = ''
                }
              }}
            />
          </div>
        </div>

        <div className="vg-panel">
          <div className="vg-block-head">
            <div className="vg-block-title"><Film size={16} /> 参数配置（视频）</div>
          </div>

          <div className="vg-field">
            <div className="vg-label">时长</div>
            <div className="vg-pill-row">
              {[3, 5, 8, 10].map(s => (
                <button key={s} className={`vg-pill ${durationSec === s ? 'active' : ''}`} onClick={() => setDurationSec(s)} type="button">{s}s</button>
              ))}
            </div>
          </div>

          <div className="vg-field">
            <div className="vg-label">画幅</div>
            <div className="vg-pill-row">
              {(['16:9', '9:16'] as const).map(r => (
                <button key={r} className={`vg-pill ${aspectRatio === r ? 'active' : ''}`} onClick={() => setAspectRatio(r)} type="button">{r}</button>
              ))}
            </div>
          </div>

          {/* 清晰度不在这里设置：由模型决定（如 *-4k） */}
        </div>

        <div className="vg-panel">
          <div className="vg-block-head">
            <div className="vg-block-title">提示词</div>
            <div className="vg-block-actions">
              <button
                type="button"
                className="vg-mini-btn"
                onClick={async () => {
                  const next = await uiTextEditor(String(prompt || ''), {
                    title: '编辑提示词',
                    message: '支持多行；应用后会覆盖当前提示词',
                    size: 'lg',
                    okText: '应用',
                    cancelText: '取消'
                  })
                  if (next == null) return
                  setPrompt(next)
                }}
                disabled={busyOp !== null}
                title="展开编辑"
              >
                展开
              </button>
              <button
                type="button"
                className="vg-mini-btn"
                onClick={() => setPrompt('')}
                disabled={busyOp !== null || !prompt.trim()}
                title="清空提示词"
              >
                清空
              </button>
              <button
                type="button"
                className="vg-mini-btn"
                onClick={handleOptimize}
                disabled={busyOp !== null || !prompt.trim()}
                title="用提示词模型优化"
              >
                {busyOp === 'optimize' ? '优化中...' : '优化'}
              </button>
              {isVeoModel && (
                <button
                  type="button"
                  className="vg-mini-btn"
                  onClick={handleTranslate}
                  disabled={busyOp !== null || !prompt.trim()}
                  title="翻译/改写为英文（Veo 常用）"
                >
                  {busyOp === 'translate' ? '翻译中...' : '英文'}
                </button>
              )}
            </div>
          </div>
          <textarea className="vg-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想从参考图演化出的视频..." />
          {isVeoModel && hasCjk && (
            <div className="vg-muted" style={{ marginTop: 8 }}>
              提示：Veo 通常只支持英文 prompt。可点右上“英文”一键翻译，或开启下方“增强提示词（英文）”。
            </div>
          )}
        </div>

        {isVeoModel && (
          <div className="vg-panel">
            <div className="vg-block-head">
              <div className="vg-block-title">Veo 选项</div>
              <button
                type="button"
                className="vg-mini-btn"
                onClick={() => setVeoOptionsOpen(v => !v)}
                aria-expanded={veoOptionsOpen}
              >
                {veoOptionsOpen ? '收起' : '展开'}
              </button>
            </div>

            {veoOptionsOpen ? (
              <>
                <div className="vg-field">
                  <div className="vg-label">增强提示词（英文）</div>
                  <div className="vg-pill-row">
                    <button type="button" className={`vg-pill ${enhancePrompt ? 'active' : ''}`} onClick={() => setEnhancePrompt(v => !v)}>
                      {enhancePrompt ? '开启' : '关闭'}
                    </button>
                  </div>
                  <div className="vg-muted" style={{ marginTop: 6 }}>
                    部分中转网关会在开启后把中文自动转成英文并增强描述。
                  </div>
                </div>
                <div className="vg-field">
                  <div className="vg-label">启用上采样</div>
                  <div className="vg-pill-row">
                    <button type="button" className={`vg-pill ${enableUpsample ? 'active' : ''}`} onClick={() => setEnableUpsample(v => !v)}>
                      {enableUpsample ? '开启' : '关闭'}
                    </button>
                  </div>
                  <div className="vg-muted" style={{ marginTop: 6 }}>
                    返回更高分辨率（如 1080p）。某些模型/接口可能不支持。
                  </div>
                </div>
              </>
            ) : null}
          </div>
        )}

        <OptimizeSystemPromptEditor
          providerId={providerId}
          scopeKey="video"
          onPreferenceChange={(v) => setOptimizePreference(v)}
          injectCustomText={injectOptimizeCustomText}
          onInjectedCustomTextConsumed={() => setInjectOptimizeCustomText('')}
        />

        <div className="vg-panel" style={{ marginTop: 'auto' }}>
          <CompactModelPicker
            label="生视频模型"
            value={currentVideoModel}
            placeholder="选择视频模型..."
            icon={<Film size={14} />}
            pinned={pinnedVideoModels}
            models={availableModels}
            onSelect={(m: string) => {
              if (!providerId) return
              updateProvider(providerId, { selectedVideoModel: m })
            }}
          />

          <CompactModelPicker
            label="提示词优化模型"
            value={currentPromptModel}
            placeholder="选择优化模型..."
            icon={<LibraryIcon size={14} />}
            pinned={pinnedPromptModels}
            models={availableModels}
            onSelect={(m: string) => {
              if (!providerId) return
              updateProvider(providerId, { selectedPromptModel: m })
            }}
          />
        </div>
      </div>

      <div className="vg-center">
        <div className="vg-top-tabs" role="tablist">
          <button className="vg-tab" type="button" onClick={() => onSwitchMode('t2v')}><Film size={16} /> 文字生视频</button>
          <button className="vg-tab active" type="button"><ImageIcon size={16} /> 图生视频</button>
        </div>

        <VideoDesktopGrid
          mode="i2v"
          tasks={i2vTasks}
          outputDirectory={videoOutputDirectory}
          onOpen={(id) => setPreviewTaskId(id)}
          onDeleteTasks={(ids) => deleteTasks(ids)}
        />

        <div className="vg-bottom-bar">
          <div className="vg-batch">
            <button type="button" className="vg-batch-btn" onClick={() => setBatchCount(v => Math.max(1, v - 1))}><Minus size={14} /></button>
            <div className="vg-batch-val">{batchCount}</div>
            <button type="button" className="vg-batch-btn" onClick={() => setBatchCount(v => Math.min(6, v + 1))}><Plus size={14} /></button>
          </div>

          <button
            type="button"
            className="vg-ghost"
            onClick={() => {
              if (!i2vTasks.length) return
              setConfirmClearOpen(true)
            }}
            disabled={!i2vTasks.length}
            title="清空视频任务"
          >
            <Trash2 size={16} /> 清空
          </button>

          <button type="button" className="vg-primary" onClick={() => void handleGenerate()} title={inputImages.length === 0 ? '请先上传参考图片' : (!prompt.trim() ? '请先输入提示词' : '')}>
            <Sparkles size={16} /> 开始
          </button>
        </div>
      </div>

      <div className="vg-right">
        <PromptLinkPanel
          mode="i2v"
          onOpenLibrary={() => {
            setLibraryMode('i2v')
            navigate('/library?mode=i2v', { state: { from: '/video?mode=i2v' } })
          }}
          onApplyPrompt={(text) => setPrompt(text)}
          onApplyOptimizeCustom={(text) => setInjectOptimizeCustomText(text)}
        />

        <CreativeCollectionsPanel
          mode="i2v"
          onOpenLibrary={() => {
            setLibraryMode('i2v')
            navigate('/library?mode=i2v', { state: { from: '/video?mode=i2v' } })
          }}
          onApplyPrompt={(text) => setPrompt(text)}
          onApplyOptimizeCustom={(text) => setInjectOptimizeCustomText(text)}
        />
      </div>

      <ReferenceImagesModal
        open={isGalleryOpen}
        value={inputImages}
        onChange={setInputImages}
        onClose={() => setIsGalleryOpen(false)}
        max={MAX_INPUT_IMAGES}
      />

      <VideoPreviewModal
        open={Boolean(previewTask)}
        task={previewTask}
        outputDirectory={videoOutputDirectory}
        onClose={() => setPreviewTaskId(null)}
        onDelete={(id) => {
          deleteTask(id)
          setPreviewTaskId(null)
        }}
      />

      <ConfirmModal
        open={confirmClearOpen}
        title="清空任务"
        message="确定要清空所有视频任务吗？此操作会删除当前模式下的任务列表。"
        confirmText="清空"
        onCancel={() => setConfirmClearOpen(false)}
        onConfirm={() => {
          clearTasksByMode('i2v')
          setConfirmClearOpen(false)
        }}
      />
    </div>
  )
}
