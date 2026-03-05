import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface ApiProvider {
  id: string
  name: string
  baseUrl: string
  // 兼容旧版本：保留单 key 字段
  apiKey: string

  // 多 Key：用于中转站不同分组/渠道（便宜/优质）
  apiKeys?: Array<{
    id: string
    name: string
    group?: string
    apiKey: string
  }>

  // 各功能使用哪个 key（不填则回退到第一个 key / apiKey）
  keyUsage?: {
    imageKeyId?: string
    promptKeyId?: string
    translateKeyId?: string
    videoKeyId?: string
    modelsKeyId?: string
  }
  models: string[] // 获取到的可用模型列表
  selectedImageModel: string
  selectedPromptModel: string

  // 翻译：独立的提示词翻译模型（例如 Veo 仅支持英文时）
  selectedTranslateModel?: string

   // 视频：单独存“生视频模型”（与图片/提示词模型分开）
   selectedVideoModel?: string

   // 常用模型预设（每类最多 4 个）
   pinnedVideoModels?: string[]

    // 翻译常用模型预设（最多 4 个）
    pinnedTranslateModels?: string[]

  // 常用模型预设（每类最多 4 个，用于在生图页快速切换，避免每次都搜索）
  pinnedImageModels?: string[]
  pinnedPromptModels?: string[]
}

interface SettingsState {
  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void

  // 是否自动保存生成的图片到本地
  // true：生成完成后自动下载到 outputDirectory
  // false：仅展示远端 url（用户仍可在预览里手动“保存”）
  autoSaveEnabled: boolean
  setAutoSaveEnabled: (enabled: boolean) => void
  
  // 图片保存目录 (默认指向项目根目录下的 output 文件夹)
  outputDirectory: string
  setOutputDirectory: (dir: string) => void

  // 是否自动保存生成的视频到本地
  videoAutoSaveEnabled: boolean
  setVideoAutoSaveEnabled: (enabled: boolean) => void

  // 视频保存目录（独立于图片）
  videoOutputDirectory: string
  setVideoOutputDirectory: (dir: string) => void

  // 多 API 提供商管理
  providers: ApiProvider[]
  activeProviderId: string | null

  // 自动更新通道
  updateChannel: 'stable' | 'beta'
  setUpdateChannel: (channel: 'stable' | 'beta') => void

  // 各主要功能使用哪个 API 网站（有的网站不支持图片/视频）
  // 为空时回退到 activeProviderId
  imageProviderId: string | null
  videoProviderId: string | null
  canvasProviderId: string | null
  
  // Actions
  addProvider: (name: string, baseUrl: string) => void
  removeProvider: (id: string) => void
  updateProvider: (id: string, updates: Partial<ApiProvider>) => void
  setActiveProvider: (id: string) => void

  setImageProvider: (id: string | null) => void
  setVideoProvider: (id: string | null) => void
  setCanvasProvider: (id: string | null) => void

  // 常用模型操作
  togglePinnedModel: (providerId: string, type: 'image' | 'prompt' | 'video' | 'translate', model: string) => void
}

// 默认预设配置，根据要求保持为空，让用户自己加
const defaultProviders: ApiProvider[] = []

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      setTheme: (theme) => set({ theme }),

      autoSaveEnabled: true,
      setAutoSaveEnabled: (enabled) => set({ autoSaveEnabled: enabled }),

      // 默认输出目录：使用相对路径 output（项目移动到其它盘符也不会失效）
      // 主进程会将相对路径解析到当前工作目录下
      outputDirectory: 'output',
      setOutputDirectory: (dir) => set({ outputDirectory: dir }),

      videoAutoSaveEnabled: true,
      setVideoAutoSaveEnabled: (enabled) => set({ videoAutoSaveEnabled: enabled }),

      videoOutputDirectory: 'output/videos',
      setVideoOutputDirectory: (dir) => set({ videoOutputDirectory: dir }),

      providers: defaultProviders,
      activeProviderId: null, // 默认没有任何选中

      updateChannel: 'stable',
      setUpdateChannel: (channel) => set({ updateChannel: channel }),

      imageProviderId: null,
      videoProviderId: null,
      canvasProviderId: null,

      addProvider: (name, baseUrl) => set((state) => {
        const defaultKeyId = `key_${Date.now()}_default`
        const newProvider: ApiProvider = {
          id: `provider_${Date.now()}`, // 生成唯一ID
          name,
          baseUrl,
          apiKey: '',
          apiKeys: [{ id: defaultKeyId, name: '默认', group: 'default', apiKey: '' }],
          keyUsage: {
            imageKeyId: defaultKeyId,
            promptKeyId: defaultKeyId,
            translateKeyId: defaultKeyId,
            videoKeyId: defaultKeyId,
            modelsKeyId: defaultKeyId
          },
          models: [],
          selectedImageModel: '',
          selectedPromptModel: '',
          selectedTranslateModel: '',
          selectedVideoModel: '',
          pinnedImageModels: [],
          pinnedPromptModels: [],
          pinnedVideoModels: [],
          pinnedTranslateModels: []
        }
        return { 
          providers: [...state.providers, newProvider],
          activeProviderId: newProvider.id, // 添加后默认选中这个新的
          // 若尚未配置用途网站，则默认跟随新建的
          imageProviderId: state.imageProviderId || newProvider.id,
          videoProviderId: state.videoProviderId || newProvider.id,
          canvasProviderId: state.canvasProviderId || newProvider.id
        }
      }),

      removeProvider: (id) => set((state) => {
        const newProviders = state.providers.filter(p => p.id !== id)
        const fallbackId = newProviders.length > 0 ? newProviders[0].id : null
        return {
          providers: newProviders,
          // 如果删除的是当前选中的，就把选中状态切给剩下的第一个，如果没有则为 null
          activeProviderId: state.activeProviderId === id ? fallbackId : state.activeProviderId,
          imageProviderId: state.imageProviderId === id ? fallbackId : state.imageProviderId,
          videoProviderId: state.videoProviderId === id ? fallbackId : state.videoProviderId,
          canvasProviderId: state.canvasProviderId === id ? fallbackId : state.canvasProviderId
        }
      }),

      updateProvider: (id, updates) => set((state) => ({
        providers: state.providers.map(p => 
          p.id === id ? { ...p, ...updates } : p
        )
      })),

      setActiveProvider: (id) => set({ activeProviderId: id }),

      setImageProvider: (id) => set({ imageProviderId: id }),
      setVideoProvider: (id) => set({ videoProviderId: id }),
      setCanvasProvider: (id) => set({ canvasProviderId: id }),

      togglePinnedModel: (providerId, type, model) => set((state) => {
        const maxPinned = 4
        const key = type === 'image'
          ? 'pinnedImageModels'
          : (type === 'video'
            ? 'pinnedVideoModels'
            : (type === 'translate'
              ? 'pinnedTranslateModels'
              : 'pinnedPromptModels'))

        return {
          providers: state.providers.map(p => {
            if (p.id !== providerId) return p

            const current = Array.isArray((p as any)[key]) ? ([...(p as any)[key]] as string[]) : ([] as string[])
            const exists = current.includes(model)
            if (exists) {
              return { ...p, [key]: current.filter(m => m !== model) }
            }

            // 超过上限时不再添加
            if (current.length >= maxPinned) {
              return p
            }

            return { ...p, [key]: [model, ...current] }
          })
        }
      })
    }),
    {
      name: 'nexa-settings-v2', // 更换本地存储 key，这会让旧的错误数据失效，达到纯净的“默认为空”状态
       version: 8,
      migrate: (persistedState: any) => {
        // 迁移：早期版本把 outputDirectory 写死在 C 盘用户目录里，项目转移到其它盘符后会导致保存/预览异常
        // 这里仅对“看起来像旧默认值”的路径做定向修复，避免覆盖用户自己配置的其它绝对路径
        if (persistedState && typeof persistedState === 'object') {
          const out = persistedState.outputDirectory
          if (typeof out === 'string') {
            const normalized = out.toLowerCase().replace(/\//g, '\\')
            const looksLikeOldDefault = normalized.includes('\\users\\') && normalized.endsWith('\\nexa\\output')
            if (looksLikeOldDefault) {
              persistedState.outputDirectory = 'output'
            }
          }

          // 迁移：为旧 provider 补齐 pinned 字段
           if (Array.isArray(persistedState.providers)) {
             persistedState.providers = persistedState.providers.map((p: any) => {
               if (!p || typeof p !== 'object') return p

               // 多 key 迁移：把旧 apiKey 放到 apiKeys[0]
               if (!Array.isArray(p.apiKeys) || p.apiKeys.length === 0) {
                 const defaultKeyId = `key_${Date.now()}_default`
                 p.apiKeys = [{ id: defaultKeyId, name: '默认', group: 'default', apiKey: String(p.apiKey || '') }]
               }
               if (!p.keyUsage || typeof p.keyUsage !== 'object') {
                 const firstId = String(p.apiKeys?.[0]?.id || '')
                 p.keyUsage = {
                   imageKeyId: firstId,
                   promptKeyId: firstId,
                   translateKeyId: firstId,
                   videoKeyId: firstId,
                   modelsKeyId: firstId
                 }
               }

               if (!Array.isArray(p.pinnedImageModels)) p.pinnedImageModels = []
               if (!Array.isArray(p.pinnedPromptModels)) p.pinnedPromptModels = []
               if (!Array.isArray(p.pinnedVideoModels)) p.pinnedVideoModels = []
               if (!Array.isArray(p.pinnedTranslateModels)) p.pinnedTranslateModels = []
               if (typeof p.selectedVideoModel !== 'string') p.selectedVideoModel = ''
               if (typeof p.selectedTranslateModel !== 'string') p.selectedTranslateModel = ''
               return p
             })
           }

           // 迁移：补齐自动保存开关
           if (typeof persistedState.autoSaveEnabled !== 'boolean') {
             persistedState.autoSaveEnabled = true
           }

           // 迁移：补齐视频自动保存与目录
           if (typeof persistedState.videoAutoSaveEnabled !== 'boolean') {
             // 尊重旧的“图片自动保存”开关偏好
             persistedState.videoAutoSaveEnabled = typeof persistedState.autoSaveEnabled === 'boolean'
               ? persistedState.autoSaveEnabled
               : true
           }
            if (typeof persistedState.videoOutputDirectory !== 'string' || !persistedState.videoOutputDirectory.trim()) {
             const base = typeof persistedState.outputDirectory === 'string' && persistedState.outputDirectory.trim()
               ? String(persistedState.outputDirectory).replace(/[\\/]+$/g, '')
               : 'output'
              persistedState.videoOutputDirectory = `${base}/videos`
            }

            // 迁移：各主要功能独立 API 网站选择（默认跟随 activeProviderId）
            const activeId = typeof persistedState.activeProviderId === 'string' ? persistedState.activeProviderId : null
            if (typeof persistedState.imageProviderId !== 'string') persistedState.imageProviderId = activeId
            if (typeof persistedState.videoProviderId !== 'string') persistedState.videoProviderId = activeId
            if (typeof persistedState.canvasProviderId !== 'string') persistedState.canvasProviderId = activeId

            if (persistedState.updateChannel !== 'stable' && persistedState.updateChannel !== 'beta') {
              persistedState.updateChannel = 'stable'
            }
          }
          return persistedState
        }
    }
  )
)
