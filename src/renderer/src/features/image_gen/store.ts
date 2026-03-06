import { create } from 'zustand'
import { generateImage, RequestDebug, ResponseDebug } from '../../core/api/image'
import { kvGetJsonMigrate, kvRemove, kvSetJson } from '../../core/persist/kvClient'

// 图片生成任务全局存储（修复：生成中切换页面导致任务丢失）
// 设计目标：
// - 生成请求与状态更新不依赖某个页面组件是否挂载
// - 成功/失败结果可跨页面保留；刷新按钮可从 localStorage 重新加载

export interface ImageTask {
  id: string
  createdAt?: number
  mode: 't2i' | 'i2i'
  status: 'loading' | 'success' | 'error'
  url?: string
  errorMsg?: string
  ratio: string
  prompt: string
  optimizePreference?: string
  targetSize?: string
  actualSize?: string

  // 调试：用于复制“请求代码”（内部已脱敏 apiKey）
  request?: RequestDebug

  // 调试：用于在预览里展示“接口返回”（内部已脱敏并截断）
  response?: ResponseDebug

  // 图生图：输入图片信息（仅用于展示/排查，不存大体积 base64）
  inputImageName?: string
  inputImageNames?: string[]
  inputImageCount?: number
}

type GenerateArgs = {
  mode: 't2i' | 'i2i'
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  ratio: string
  targetSize: string
  imageSize: string
  optimizePreference?: string
  batchCount: number
  inputImagesBase64?: string[]
  inputImageNames?: string[]
  // 自动保存开关：关闭时不触发主进程下载，只展示远端 url
  saveDir?: string
}

type GenerateOneArgs = {
  mode: 't2i' | 'i2i'
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  ratio: string
  targetSize: string
  imageSize: string
  optimizePreference?: string
  inputImagesBase64?: string[]
  inputImageNames?: string[]
  saveDir?: string
}

type ImageGenState = {
  tasks: ImageTask[]
  hydrateFromStorage: () => void
  refreshFromStorage: () => void
  patchTask: (id: string, patch: Partial<ImageTask>) => void
  deleteTask: (id: string) => void
  clearTasks: () => void
  clearTasksByMode: (mode: 't2i' | 'i2i') => void
  enqueueGenerateBatch: (args: GenerateArgs) => void
  enqueueGenerateOne: (args: GenerateOneArgs) => void
}

const LS_KEY = 'nexa-image-tasks'
const LOADING_STALE_MS = 1000 * 60 * 20 // 20 分钟：防止重启后永远 loading

function formatErrorMessage(e: any): string {
  const base = String(e?.message || '生成失败')
  const status = e?.response?.status
  const data = e?.response?.data

  let extra = ''
  if (status) extra += ` (HTTP ${status})`

  if (data !== undefined) {
    let body = ''
    try {
      body = typeof data === 'string' ? data : JSON.stringify(data)
    } catch {
      body = ''
    }
    body = (body || '').trim()
    if (body) {
      // 避免把整段 HTML/超长报错塞进 localStorage
      if (body.length > 1200) body = body.slice(0, 1200) + '...'
      extra += `\n${body}`
    }
  }

  return `${base}${extra}`
}

function normalizeTasks(list: ImageTask[]): ImageTask[] {
  const now = Date.now()
  return (list || []).map(t => {
    // 兼容旧版本保存的 nexa://C:/...（Chromium 会把 C: 当成 host 导致盘符丢失），统一修正为 nexa:///C:/...
    let url = t.url
    if (url && url.startsWith('nexa://') && !url.startsWith('nexa:///')) {
      url = url.replace(/^nexa:\/\/([A-Za-z]:\/)/, 'nexa:///$1')
    }

    const createdAt = t.createdAt || now
    const mode = (t as any).mode === 'i2i' ? 'i2i' : 't2i'
    const optimizePreference = t.optimizePreference || ''

    const inputImageNames = Array.isArray((t as any).inputImageNames) ? (t as any).inputImageNames.map(String) : undefined
    const inputImageCount = typeof (t as any).inputImageCount === 'number'
      ? (t as any).inputImageCount
      : (inputImageNames ? inputImageNames.length : undefined)

    // 如果是历史遗留的 loading（例如应用重启/刷新），标记为 error，避免永远卡住
    if (t.status === 'loading' && now - createdAt > LOADING_STALE_MS) {
      return {
        ...t,
        url,
        createdAt,
        mode,
        optimizePreference,
        inputImageNames,
        inputImageCount,
        status: 'error',
        errorMsg: t.errorMsg || '任务已中断（可能是切换页面/刷新/重启导致）'
      }
    }

    return { ...t, url, createdAt, mode, optimizePreference, inputImageNames, inputImageCount }
  })
}

async function loadFromStorage(): Promise<ImageTask[]> {
  const parsed = await kvGetJsonMigrate<ImageTask[]>(LS_KEY, [])
  return normalizeTasks(Array.isArray(parsed) ? parsed : [])
}

async function saveToStorage(tasks: ImageTask[]) {
  await kvSetJson(LS_KEY, tasks)
}

export const useImageGenStore = create<ImageGenState>((set, get) => ({
  tasks: [],

  hydrateFromStorage: () => {
    void (async () => {
      const tasks = await loadFromStorage()
      set({ tasks })
    })()
  },

  refreshFromStorage: () => {
    // 刷新：重新读取持久化并做兼容修复
    void (async () => {
      const tasks = await loadFromStorage()
      set({ tasks })
    })()
  },

  patchTask: (id, patch) => {
    set(state => {
      const next = state.tasks.map(t => (t.id === id ? { ...t, ...patch } : t))
      void saveToStorage(next)
      return { tasks: next }
    })
  },

  deleteTask: (id) => {
    set(state => {
      const next = state.tasks.filter(t => t.id !== id)
      void saveToStorage(next)
      return { tasks: next }
    })
  },

  clearTasks: () => {
    set({ tasks: [] })
    void kvRemove(LS_KEY)
  },

  clearTasksByMode: (mode) => {
    set(state => {
      const next = state.tasks.filter(t => t.mode !== mode)
      void saveToStorage(next)
      return { tasks: next }
    })
  },

  enqueueGenerateBatch: (args) => {
    const now = Date.now()
      const newTasks: ImageTask[] = Array.from({ length: Math.max(1, Math.min(10, args.batchCount || 1)) }).map((_, i) => ({
        id: `${now}_${i}`,
        createdAt: now,
        mode: args.mode,
        status: 'loading',
        ratio: args.ratio,
        prompt: args.prompt,
        targetSize: args.targetSize,
        optimizePreference: args.optimizePreference || '',
        inputImageName: (args.inputImageNames && args.inputImageNames[0]) || undefined,
        inputImageNames: args.inputImageNames,
        inputImageCount: Array.isArray(args.inputImageNames) ? args.inputImageNames.length : undefined
      }))

    set(state => {
      const next = [...newTasks, ...state.tasks]
      void saveToStorage(next)
      return { tasks: next }
    })

    // 并发发送请求（请求在 store 内启动，页面卸载后仍会继续并更新 store）
    newTasks.forEach(async (task) => {
      try {
          const urls = await generateImage({
            baseUrl: args.baseUrl,
            apiKey: args.apiKey,
            model: args.model,
            prompt: args.prompt,
            n: 1,
            size: args.targetSize
            ,aspectRatio: (args.ratio === 'Auto' ? '1:1' : args.ratio)
            ,imageSize: args.imageSize
            ,image: (Array.isArray(args.inputImagesBase64) && args.inputImagesBase64.length > 0) ? args.inputImagesBase64 : undefined
            ,onRequest: (req) => {
              get().patchTask(task.id, { request: req })
            }
            ,onResponse: (resp) => {
              get().patchTask(task.id, { response: resp })
            }
          })

        if (urls.length > 0) {
          // 先用远端 url 立即展示，避免等待下载导致“显示很慢”
          const remoteUrl = urls[0]
          get().patchTask(task.id, { status: 'success', url: remoteUrl })

          // 自动保存：后台下载，成功后把 url 换成本地 nexa://local
          if (args.saveDir && window.nexaAPI?.downloadImage) {
            const fileName = `nexa_${Date.now()}_${Math.floor(Math.random() * 1000)}`
            try {
              const dl = await window.nexaAPI.downloadImage({ url: remoteUrl, saveDir: args.saveDir, fileName })
              if (dl.success && dl.localPath) {
                get().patchTask(task.id, { url: dl.localPath })
              }
            } catch {
              // 忽略下载失败，保留远端 url
            }
          }
        } else {
          get().patchTask(task.id, { status: 'error', errorMsg: 'no images returned' })
        }
      } catch (e: any) {
        get().patchTask(task.id, { status: 'error', errorMsg: formatErrorMessage(e) })
      }
    })
  },

  enqueueGenerateOne: (args) => {
    const now = Date.now()
    const task: ImageTask = {
      id: `${now}_remake`,
      createdAt: now,
      mode: args.mode,
      status: 'loading',
      ratio: args.ratio,
      prompt: args.prompt,
      targetSize: args.targetSize,
      optimizePreference: args.optimizePreference || '',
      inputImageName: (args.inputImageNames && args.inputImageNames[0]) || undefined,
      inputImageNames: args.inputImageNames,
      inputImageCount: Array.isArray(args.inputImageNames) ? args.inputImageNames.length : undefined
    }

    set(state => {
      const next = [task, ...state.tasks]
      void saveToStorage(next)
      return { tasks: next }
    })

    ;(async () => {
      try {
        const urls = await generateImage({
          baseUrl: args.baseUrl,
          apiKey: args.apiKey,
          model: args.model,
          prompt: args.prompt,
          n: 1,
          size: args.targetSize
          ,aspectRatio: (args.ratio === 'Auto' ? '1:1' : args.ratio)
          ,imageSize: args.imageSize
          ,image: (Array.isArray(args.inputImagesBase64) && args.inputImagesBase64.length > 0) ? args.inputImagesBase64 : undefined
          ,onRequest: (req) => {
            get().patchTask(task.id, { request: req })
          }
          ,onResponse: (resp) => {
            get().patchTask(task.id, { response: resp })
          }
        })

        if (urls.length > 0) {
          const remoteUrl = urls[0]
          get().patchTask(task.id, { status: 'success', url: remoteUrl })

          if (args.saveDir && window.nexaAPI?.downloadImage) {
            const fileName = `nexa_${Date.now()}_${Math.floor(Math.random() * 1000)}`
            try {
              const dl = await window.nexaAPI.downloadImage({ url: remoteUrl, saveDir: args.saveDir, fileName })
              if (dl.success && dl.localPath) {
                get().patchTask(task.id, { url: dl.localPath })
              }
            } catch {
              // 忽略
            }
          }
        } else {
          get().patchTask(task.id, { status: 'error', errorMsg: 'no images returned' })
        }
      } catch (e: any) {
        get().patchTask(task.id, { status: 'error', errorMsg: formatErrorMessage(e) })
      }
    })()
  }
}))
