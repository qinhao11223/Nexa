import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fileJSONStorage } from '../../core/persist/fileStorage'
import type { RequestDebug, ResponseDebug } from '../../core/api/image'
import { createVideoGeneration, pollVideoGeneration } from '../../core/api/video'

export type VideoMode = 't2v' | 'i2v'
export type VideoTaskStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled'

export type VideoTask = {
  id: string
  createdAt: number
  mode: VideoMode

  providerId?: string | null
  baseUrl: string
  model: string

  prompt: string
  durationSec: number
  aspectRatio: string
  // 清晰度通常由模型决定；不再作为必填参数
  resolution?: string
  fps?: number
  seed?: number

  enhancePrompt?: boolean
  enableUpsample?: boolean

  inputImageNames?: string[]
  inputImageCount?: number

  // 远端任务 id（异步生成通常返回这个）
  remoteId?: string

  status: VideoTaskStatus
  progress?: number

  // 结果
  url?: string
  errorMsg?: string

  // 调试
  request?: RequestDebug
  response?: ResponseDebug
}

export type EnqueueVideoArgs = {
  mode: VideoMode
  providerId?: string | null
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  durationSec: number
  aspectRatio: string
  resolution?: string
  fps?: number
  seed?: number
  batchCount: number
  inputImagesBase64?: string[]
  inputImageNames?: string[]
  autoSaveDir?: string

  enhancePrompt?: boolean
  enableUpsample?: boolean
}

type VideoGenState = {
  tasks: VideoTask[]

  // 运行时调试信息：不持久化到 localStorage（避免撑爆）
  responseFullById: Record<string, string>

  addTasks: (tasks: VideoTask[]) => void
  patchTask: (id: string, patch: Partial<VideoTask>) => void
  setResponseFull: (id: string, text: string) => void
  deleteTask: (id: string) => void
  deleteTasks: (ids: string[]) => void
  clearTasks: () => void
  clearTasksByMode: (mode: VideoMode) => void

  enqueueBatch: (args: EnqueueVideoArgs) => void
  cancelTask: (id: string) => void
  pollOnce: (id: string) => Promise<void>
}

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
      if (body.length > 1200) body = body.slice(0, 1200) + '...'
      extra += `\n${body}`
    }
  }
  return `${base}${extra}`
}

const LS_KEY = 'nexa-video-tasks-v1'

export const useVideoGenStore = create<VideoGenState>()(
  persist(
    (set, get) => ({
      tasks: [],
      responseFullById: {},

      addTasks: (tasks) => set(state => ({ tasks: [...tasks, ...state.tasks] })),

      patchTask: (id, patch) => set(state => ({
        tasks: state.tasks.map(t => t.id === id ? { ...t, ...patch } : t)
      })),

      setResponseFull: (id, text) => set(state => ({
        responseFullById: { ...(state.responseFullById || {}), [String(id)]: String(text || '') }
      })),

      deleteTask: (id) => set(state => {
        const next = { ...(state.responseFullById || {}) }
        delete next[String(id)]
        return { tasks: state.tasks.filter(t => t.id !== id), responseFullById: next }
      }),

      deleteTasks: (ids) => set(state => {
        const list = (ids || []).map(String)
        const setIds = new Set(list)
        const next = { ...(state.responseFullById || {}) }
        for (const id of list) delete next[id]
        return { tasks: state.tasks.filter(t => !setIds.has(t.id)), responseFullById: next }
      }),

      clearTasks: () => set({ tasks: [], responseFullById: {} }),

      clearTasksByMode: (mode) => set(state => {
        const removed = state.tasks.filter(t => t.mode === mode).map(t => t.id)
        const next = { ...(state.responseFullById || {}) }
        for (const id of removed) delete next[String(id)]
        return { tasks: state.tasks.filter(t => t.mode !== mode), responseFullById: next }
      }),

      cancelTask: (id) => {
        const t = get().tasks.find(x => x.id === id)
        if (!t) return
        // 先做本地取消；未来如果网关支持取消接口，再补远端 cancel
        get().patchTask(id, { status: 'canceled', errorMsg: '已取消' })
      },

      pollOnce: async (id) => {
        const t = get().tasks.find(x => x.id === id)
        if (!t || !t.remoteId) return
        if (t.status !== 'running' && t.status !== 'queued') return

        try {
          const r = await pollVideoGeneration(t.baseUrl, (t.request?.headers?.Authorization || '').replace(/^Bearer\s+/i, '') || '', t.remoteId)
          // 注意：pollVideoGeneration 目前只走 Bearer；这里不从 request 里拆 key（避免泄露），实际 key 由 enqueue 逻辑闭包保存
          // 因此 pollOnce 目前只用于 store 内部（enqueue 里会直接调用，不走这里）。
          if (r.progress !== undefined) get().patchTask(id, { progress: r.progress })
          if (r.videoUrl) get().patchTask(id, { url: r.videoUrl })
          const st = String(r.status || '').toLowerCase()
          if (['succeeded', 'success', 'completed', 'done'].includes(st) && r.videoUrl) {
            get().patchTask(id, { status: 'success' })
          } else if (['failed', 'error', 'canceled'].includes(st)) {
            get().patchTask(id, { status: 'error', errorMsg: r.errorMessage || '生成失败' })
          } else {
            get().patchTask(id, { status: 'running' })
          }
        } catch (e: any) {
          get().patchTask(id, { status: 'error', errorMsg: formatErrorMessage(e) })
        }
      },

      enqueueBatch: (args) => {
        const now = Date.now()
        const count = Math.max(1, Math.min(6, args.batchCount || 1))

        const newTasks: VideoTask[] = Array.from({ length: count }).map((_, i) => ({
          id: `v_${now}_${i}`,
          createdAt: now,
          mode: args.mode,
          providerId: args.providerId,
          baseUrl: args.baseUrl,
          model: args.model,
          prompt: args.prompt,
          durationSec: args.durationSec,
          aspectRatio: args.aspectRatio,
          resolution: args.resolution,
          fps: args.fps,
          seed: args.seed,
          enhancePrompt: args.enhancePrompt,
          enableUpsample: args.enableUpsample,
          inputImageNames: args.inputImageNames,
          inputImageCount: Array.isArray(args.inputImageNames) ? args.inputImageNames.length : undefined,
          status: 'queued'
        }))

        set(state => ({ tasks: [...newTasks, ...state.tasks] }))

        // 每个 task 独立启动（不阻塞 UI）
        for (const task of newTasks) {
          ;(async () => {
            try {
              get().patchTask(task.id, { status: 'running', progress: 0 })

              let lastKey = args.apiKey
              const createRes = await createVideoGeneration({
                baseUrl: args.baseUrl,
                apiKey: args.apiKey,
                model: args.model,
                prompt: args.prompt,
                durationSec: args.durationSec,
                aspectRatio: args.aspectRatio,
                resolution: args.resolution,
                fps: args.fps,
                seed: args.seed,
                enhancePrompt: args.enhancePrompt,
                enableUpsample: args.enableUpsample,
                image: (args.mode === 'i2v' && Array.isArray(args.inputImagesBase64) && args.inputImagesBase64.length > 0)
                  ? args.inputImagesBase64
                  : undefined,
                onRequest: (req) => {
                  // 记录“脱敏请求”；另外保留 apiKey 供 poll 使用
                  get().patchTask(task.id, { request: req })
                },
                onResponse: (resp) => {
                  const anyResp = resp as any
                  const full = typeof anyResp?.dataFull === 'string' ? String(anyResp.dataFull) : ''
                  const { dataFull, ...rest } = (anyResp || {})
                  get().patchTask(task.id, { response: rest })
                  if (full.trim()) get().setResponseFull(task.id, full)
                }
              })

              get().patchTask(task.id, { remoteId: createRes.id })
              if (createRes.videoUrl) {
                get().patchTask(task.id, { url: createRes.videoUrl, status: 'success', progress: 100 })
              }

               // 轮询直到结束（最多 700 秒）：中转网关可能耗时较长
                const started = Date.now()
               const timeoutMs = 1000 * 700
               let lastRetryableError: string | null = null
                while (true) {
                const cur = get().tasks.find(x => x.id === task.id)
                if (!cur) return
                if (cur.status === 'canceled') return
                // 成功/失败：结束轮询，但仍允许继续做后处理（例如自动导出到本地）
                if (cur.status === 'success' || cur.status === 'error') break
                  if (Date.now() - started > timeoutMs) {
                  get().patchTask(task.id, {
                    status: 'error',
                    errorMsg: lastRetryableError
                      ? `生成超时（>700秒）\n\nlast error:\n${lastRetryableError}`
                      : '生成超时（>700秒）'
                  })
                  return
                }

                if (!cur.remoteId) {
                  await new Promise(r => setTimeout(r, 900))
                  continue
                }

                  try {
                    const polled = await pollVideoGeneration(args.baseUrl, lastKey, cur.remoteId, (resp) => {
                      const anyResp = resp as any
                      const full = typeof anyResp?.dataFull === 'string' ? String(anyResp.dataFull) : ''
                      const { dataFull, ...rest } = (anyResp || {})
                      get().patchTask(task.id, { response: rest })
                      if (full.trim()) get().setResponseFull(task.id, full)
                    })

                    lastRetryableError = null

                  if (polled.progress !== undefined) {
                    const p = polled.progress <= 1 ? Math.round(polled.progress * 100) : Math.round(polled.progress)
                    get().patchTask(task.id, { progress: Math.max(0, Math.min(100, p)) })
                  }

                  if (polled.videoUrl) {
                    get().patchTask(task.id, { url: polled.videoUrl })
                  }

                  const st = String(polled.status || '').toLowerCase()
                  if (['succeeded', 'success', 'completed', 'done'].includes(st) && polled.videoUrl) {
                    get().patchTask(task.id, { status: 'success', progress: 100 })
                    break
                  }
                  if (['failed', 'failure', 'fail', 'error', 'canceled', 'cancelled'].includes(st)) {
                    get().patchTask(task.id, { status: 'error', errorMsg: polled.errorMessage || '生成失败' })
                    break
                  }
                } catch (e: any) {
                  // 中转网关轮询时常见：偶发 5xx/超时/限流。
                  // 这些属于临时错误，不应直接终止任务，继续等直到成功/失败或超时。
                  const status = e?.response?.status
                  const retryable = !status || status === 429 || status >= 500
                  if (!retryable) {
                    get().patchTask(task.id, { status: 'error', errorMsg: formatErrorMessage(e) })
                    break
                  }

                  lastRetryableError = formatErrorMessage(e)
                }

                await new Promise(r => setTimeout(r, 3800))
              }

              // 自动保存：成功后下载到本地
              if (args.autoSaveDir) {
                const cur = get().tasks.find(x => x.id === task.id)
                if (cur && cur.status === 'success' && cur.url && window.nexaAPI?.downloadVideo) {
                  if (/^nexa:\/\//i.test(cur.url)) return
                  const fileName = `nexa_video_${Date.now()}_${Math.floor(Math.random() * 1000)}`
                  const dl = await window.nexaAPI.downloadVideo({ url: cur.url, saveDir: args.autoSaveDir, fileName })
                  if (dl.success && dl.localPath) {
                    get().patchTask(task.id, { url: dl.localPath })
                  }
                }
              }
            } catch (e: any) {
              get().patchTask(task.id, { status: 'error', errorMsg: formatErrorMessage(e) })
            }
          })()
        }
      }
    }),
    {
      name: LS_KEY,
      storage: fileJSONStorage,
      version: 1,
      // 只持久化 tasks：运行时调试（responseFullById）不写入 localStorage
      partialize: (state) => ({ tasks: state.tasks })
    }
  )
)
