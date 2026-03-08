import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { fileJSONStorage } from '../../../core/persist/fileStorage'

export type TaskStep = 'agent1' | 'agent2' | 'merge' | 'gen'
export type StepState = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'cancelled'

export type StepInfo = {
  state: StepState
  startedAt?: number
  finishedAt?: number
  error?: string
}

export type TaskInputImage = {
  id: string
  name: string
  localPath: string // nexa://local?path=...
  createdAt: number
}

export type ProductShotTask = {
  id: string
  title: string
  createdAt: number
  updatedAt: number

  // group
  promptSetId?: string
  promptSetLabel?: string // "分类/名称" snapshot

  // provider
  providerId: string

  // inputs
  productAngles: TaskInputImage[]
  slots: Record<string, TaskInputImage | null>

  // templates
  agent1Template: string
  agent2Template: string
  agent3Template: string

  // models
  agent1Model?: string
  agent2Model?: string
  genModel?: string

  // gen params
  genRatio: string
  genRes: string

  // outputs
  agent1Output: string
  agent2Output: string
  finalPrompt: string
  outImages: string[]

  // debug
  requestDebug?: any
  responseDebug?: any

  steps: Record<TaskStep, StepInfo>
  currentStep: TaskStep | 'done'
}

type TaskState = {
  tasks: ProductShotTask[]
  concurrency: number

  setConcurrency: (n: number) => void
  addTask: (task: Omit<ProductShotTask, 'id' | 'createdAt' | 'updatedAt'>) => ProductShotTask
  updateTask: (id: string, patch: Partial<ProductShotTask>) => void
  removeTask: (id: string) => void
  clearAll: () => void

  markStep: (id: string, step: TaskStep, patch: Partial<StepInfo>) => void
  setCurrentStep: (id: string, step: ProductShotTask['currentStep']) => void
}

function makeId() {
  return `qa_task_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function clamp(n: number, min: number, max: number) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, v))
}

const defaultSteps = (): Record<TaskStep, StepInfo> => ({
  agent1: { state: 'idle' },
  agent2: { state: 'idle' },
  merge: { state: 'idle' },
  gen: { state: 'idle' }
})

export const useProductShotTaskStore = create<TaskState>()(
  persist(
    (set, get) => ({
      tasks: [],
      concurrency: 2,

      setConcurrency: (n) => set({ concurrency: clamp(n, 1, 4) }),

      addTask: (taskInput) => {
        const now = Date.now()
        const created: ProductShotTask = {
          id: makeId(),
          title: String(taskInput.title || '未命名任务').trim() || '未命名任务',
          createdAt: now,
          updatedAt: now,

          promptSetId: String(taskInput.promptSetId || '').trim() || undefined,
          promptSetLabel: String(taskInput.promptSetLabel || '').trim() || undefined,

          providerId: String(taskInput.providerId || '').trim(),

          productAngles: Array.isArray(taskInput.productAngles) ? taskInput.productAngles.slice(0, 12) : [],
          slots: (taskInput.slots && typeof taskInput.slots === 'object') ? taskInput.slots : {},

          agent1Template: String(taskInput.agent1Template || ''),
          agent2Template: String(taskInput.agent2Template || ''),
          agent3Template: String(taskInput.agent3Template || ''),

          agent1Model: String(taskInput.agent1Model || '').trim() || undefined,
          agent2Model: String(taskInput.agent2Model || '').trim() || undefined,
          genModel: String(taskInput.genModel || '').trim() || undefined,

          genRatio: String(taskInput.genRatio || '1:1'),
          genRes: String(taskInput.genRes || '1K'),

          agent1Output: String(taskInput.agent1Output || ''),
          agent2Output: String(taskInput.agent2Output || ''),
          finalPrompt: String(taskInput.finalPrompt || ''),
          outImages: Array.isArray(taskInput.outImages) ? taskInput.outImages.map(String).filter(Boolean).slice(0, 60) : [],

          requestDebug: taskInput.requestDebug,
          responseDebug: taskInput.responseDebug,

          steps: taskInput.steps ? taskInput.steps : defaultSteps(),
          currentStep: taskInput.currentStep || 'agent1'
        }

        // initialize step states based on existing outputs
        if (created.agent1Output.trim()) created.steps.agent1 = { state: 'success', finishedAt: now }
        else created.steps.agent1 = { state: 'queued' }
        if (created.agent2Output.trim()) created.steps.agent2 = { state: 'success', finishedAt: now }
        else created.steps.agent2 = { state: 'queued' }
        if (created.finalPrompt.trim()) created.steps.merge = { state: 'success', finishedAt: now }
        else created.steps.merge = { state: 'queued' }
        created.steps.gen = { state: 'queued' }

        set((state) => ({
          tasks: [created, ...(state.tasks || [])]
        }))
        return created
      },

      updateTask: (id, patch) => set((state) => ({
        tasks: (state.tasks || []).map(t => t.id !== id ? t : { ...t, ...patch, updatedAt: Date.now() })
      })),

      removeTask: (id) => set((state) => ({
        tasks: (state.tasks || []).filter(t => t.id !== id)
      })),

      clearAll: () => set({ tasks: [] }),

      markStep: (id, step, patch) => set((state) => ({
        tasks: (state.tasks || []).map(t => {
          if (t.id !== id) return t
          const nextSteps: any = { ...(t.steps || defaultSteps()) }
          nextSteps[step] = { ...(nextSteps[step] || { state: 'idle' }), ...patch }
          return { ...t, steps: nextSteps, updatedAt: Date.now() }
        })
      })),

      setCurrentStep: (id, step) => set((state) => ({
        tasks: (state.tasks || []).map(t => t.id !== id ? t : { ...t, currentStep: step, updatedAt: Date.now() })
      }))
    }),
    {
      name: 'nexa-qa-product-shot-tasks-v1',
      storage: fileJSONStorage,
      version: 1,
      migrate: (persisted: any) => {
        try {
          if (!persisted || typeof persisted !== 'object') return persisted
          if (!Array.isArray(persisted.tasks)) persisted.tasks = []
          if (typeof persisted.concurrency !== 'number') persisted.concurrency = 2
          return persisted
        } catch {
          return persisted
        }
      }
    }
  )
)

export function getTaskById(id: string): ProductShotTask | null {
  const tasks = useProductShotTaskStore.getState().tasks || []
  return tasks.find(t => t.id === id) || null
}
