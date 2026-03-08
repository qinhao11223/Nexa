import { chatCompletionsText, type ChatMessage } from '../../../core/api/chatCompletions'
import { generateImage } from '../../../core/api/image'
import { useSettingsStore } from '../../settings/store'
import { resolveApiKey } from '../../settings/utils/apiKeys'
import { srcToDataUrl } from './utils'
import { useProductShotTaskStore, type ProductShotTask, type TaskInputImage, type TaskStep } from './store'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function joinNonEmpty(parts: Array<string | null | undefined>, sep = '\n\n') {
  return parts.map(s => String(s || '').trim()).filter(Boolean).join(sep)
}

function assembleFinalPrompt(agent3Template: string, agent2Output: string, agent1Output: string): string {
  const a3 = String(agent3Template || '').trim()
  const a2 = String(agent2Output || '').trim()
  const a1 = String(agent1Output || '').trim()

  return joinNonEmpty([
    a3,
    a2 ? `### **【首图拍摄动作】**\n\n${a2}` : '',
    a1 ? `产品详细信息提示词：\n\n${a1}` : ''
  ])
}

async function ensureImageDataUrl(img: TaskInputImage): Promise<string> {
  const src = String(img?.localPath || '').trim()
  if (!src) throw new Error('missing localPath')
  return await srcToDataUrl(src)
}

async function ensureImageBase64(img: TaskInputImage): Promise<string> {
  const dataUrl = await ensureImageDataUrl(img)
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : ''
  if (!base64) throw new Error('missing base64')
  return base64
}

function taskDeskSaveDir(task: ProductShotTask): string {
  const label = String(task.promptSetLabel || '未分组').trim() || '未分组'
  const safe = label
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return `desk/product-shot/${safe}/${task.id}`
}

function buildAgent1Parts(task: ProductShotTask, dataUrls: Record<string, string>): any[] {
  const parts: any[] = []
  parts.push({ type: 'text', text: '以下是输入图片（每张图片前我都会用文字标注用途）。请严格按照系统提示完成输出。' })

  const push = (label: string, key: string) => {
    const url = dataUrls[key]
    if (!url) return
    parts.push({ type: 'text', text: `【${label}】` })
    parts.push({ type: 'image_url', image_url: { url } })
  }

  task.productAngles.slice(0, 6).forEach((img, i) => push(`产品不同角度图 ${i + 1}`, `angle:${img.id}`))
  if (task.slots?.wear_ref) push('佩戴参考（可选）', `slot:wear_ref:${task.slots.wear_ref.id}`)
  if (task.slots?.model) push('我们的模特（可选）', `slot:model:${task.slots.model.id}`)
  return parts
}

function buildAgent2Parts(task: ProductShotTask, dataUrls: Record<string, string>): any[] {
  const parts: any[] = []
  parts.push({ type: 'text', text: '以下是输入图片（每张图片前我都会用文字标注用途）。请严格按照系统提示完成输出。' })

  const push = (label: string, key: string) => {
    const url = dataUrls[key]
    if (!url) return
    parts.push({ type: 'text', text: `【${label}】` })
    parts.push({ type: 'image_url', image_url: { url } })
  }

  task.productAngles.slice(0, 6).forEach((img, i) => push(`产品不同角度图 ${i + 1}`, `angle:${img.id}`))
  const order: Array<[string, string]> = [
    ['model', '我们的模特（可选）'],
    ['outfit', '服装参考（可选）'],
    ['scene', '场景图（可选）'],
    ['pose', '参考姿态图（可选）'],
    ['wear_ref', '佩戴参考（可选）']
  ]
  for (const [k, label] of order) {
    const img = (task.slots as any)?.[k] as TaskInputImage | null
    if (img) push(label, `slot:${k}:${img.id}`)
  }
  return parts
}

async function runStep(taskId: string, step: TaskStep, fn: () => Promise<void>) {
  const store = useProductShotTaskStore.getState()
  store.markStep(taskId, step, { state: 'running', startedAt: Date.now(), error: undefined })
  store.setCurrentStep(taskId, step)
  try {
    await fn()
    useProductShotTaskStore.getState().markStep(taskId, step, { state: 'success', finishedAt: Date.now() })
  } catch (e: any) {
    useProductShotTaskStore.getState().markStep(taskId, step, { state: 'error', finishedAt: Date.now(), error: String(e?.message || e) })
    throw e
  }
}

export async function runProductShotTask(taskId: string) {
  const store = useProductShotTaskStore.getState()
  const task = store.tasks.find(t => t.id === taskId)
  if (!task) return

  const settings = useSettingsStore.getState() as any
  const providers = settings.providers || []
  const provider = providers.find((p: any) => p.id === task.providerId) || null
  if (!provider) throw new Error('provider not found')

  const baseUrl = String((provider as any).baseUrl || '').trim()
  const promptApiKey = resolveApiKey(provider as any, 'prompt')
  const imageApiKey = resolveApiKey(provider as any, 'image')
  const promptModel = String((provider as any).selectedPromptModel || '').trim()
  const imageModel = String((provider as any).selectedImageModel || '').trim()

  if (!baseUrl) throw new Error('missing baseUrl')

  // Prepare image data URLs for LLM steps (only for referenced images)
  const dataUrls: Record<string, string> = {}
  const fillDataUrl = async (key: string, img: TaskInputImage) => {
    dataUrls[key] = await ensureImageDataUrl(img)
  }
  for (const img of task.productAngles.slice(0, 6)) await fillDataUrl(`angle:${img.id}`, img)
  for (const [k, v] of Object.entries(task.slots || {})) {
    if (!v) continue
    await fillDataUrl(`slot:${k}:${v.id}`, v)
  }

  // Step 1
  if (!task.agent1Output.trim()) {
    await runStep(taskId, 'agent1', async () => {
      if (!promptApiKey || !(task.agent1Model || promptModel)) throw new Error('提示词模型/Key 未配置')
      const messages: ChatMessage[] = [
        { role: 'system', content: String(task.agent1Template || '') },
        { role: 'user', content: buildAgent1Parts(task, dataUrls) }
      ]
      const text = await chatCompletionsText({
        baseUrl,
        apiKey: promptApiKey,
        model: String(task.agent1Model || promptModel),
        messages,
        temperature: 0.4,
        maxTokens: 2000
      })
      useProductShotTaskStore.getState().updateTask(taskId, { agent1Output: String(text || '').trim() })
    })
  } else {
    store.markStep(taskId, 'agent1', { state: 'success', finishedAt: Date.now() })
  }

  // Refresh task
  let t = useProductShotTaskStore.getState().tasks.find(x => x.id === taskId)!

  // Step 2
  if (!t.agent2Output.trim()) {
    await runStep(taskId, 'agent2', async () => {
      if (!promptApiKey || !(t.agent2Model || promptModel)) throw new Error('提示词模型/Key 未配置')
      const messages: ChatMessage[] = [
        { role: 'system', content: String(t.agent2Template || '') },
        { role: 'user', content: buildAgent2Parts(t, dataUrls) }
      ]
      const text = await chatCompletionsText({
        baseUrl,
        apiKey: promptApiKey,
        model: String(t.agent2Model || promptModel),
        messages,
        temperature: 0.5,
        maxTokens: 2000
      })
      useProductShotTaskStore.getState().updateTask(taskId, { agent2Output: String(text || '').trim() })
    })
  } else {
    store.markStep(taskId, 'agent2', { state: 'success', finishedAt: Date.now() })
  }

  // Step 3 merge
  t = useProductShotTaskStore.getState().tasks.find(x => x.id === taskId)!
  if (!t.finalPrompt.trim()) {
    await runStep(taskId, 'merge', async () => {
      const merged = assembleFinalPrompt(t.agent3Template, t.agent2Output, t.agent1Output)
      useProductShotTaskStore.getState().updateTask(taskId, { finalPrompt: String(merged || '').trim() })
    })
  } else {
    store.markStep(taskId, 'merge', { state: 'success', finishedAt: Date.now() })
  }

  // Step 4 gen
  t = useProductShotTaskStore.getState().tasks.find(x => x.id === taskId)!
  await runStep(taskId, 'gen', async () => {
    if (!imageApiKey || !(t.genModel || imageModel)) throw new Error('生图模型/Key 未配置')
    const prompt = String(t.finalPrompt || '').trim()
    if (!prompt) throw new Error('final prompt empty')

    const base64s: string[] = []
    for (const img of t.productAngles.slice(0, 8)) base64s.push(await ensureImageBase64(img))
    for (const v of Object.values(t.slots || {})) {
      if (!v) continue
      base64s.push(await ensureImageBase64(v))
    }

    let req: any = null
    let resp: any = null
    const urls = await generateImage({
      baseUrl,
      apiKey: imageApiKey,
      model: String(t.genModel || imageModel),
      prompt,
      n: 1,
      aspectRatio: String(t.genRatio || '1:1'),
      imageSize: String(t.genRes || '1K'),
      size: undefined,
      image: base64s,
      saveDir: taskDeskSaveDir(t),
      onRequest: (r: any) => { req = r },
      onResponse: (r: any) => { resp = r }
    })
    useProductShotTaskStore.getState().updateTask(taskId, {
      outImages: (urls || []).map(String).filter(Boolean).slice(0, 60),
      requestDebug: req || undefined,
      responseDebug: resp || undefined
    })
  })

  useProductShotTaskStore.getState().setCurrentStep(taskId, 'done')
}

// Scheduler
const running = new Set<string>()

export async function schedulerTick() {
  const st = useProductShotTaskStore.getState()
  const max = Math.max(1, Math.min(4, Number(st.concurrency) || 1))
  if (running.size >= max) return

  const candidates = (st.tasks || [])
    .filter(t => t.currentStep !== 'done')
    .filter(t => {
      const gen = t.steps?.gen?.state
      return gen === 'queued' || gen === 'idle'
    })
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)

  for (const t of candidates) {
    if (running.size >= max) break
    if (running.has(t.id)) continue
    running.add(t.id)
    ;(async () => {
      try {
        await runProductShotTask(t.id)
      } catch {
        // errors already recorded per step
      } finally {
        running.delete(t.id)
      }
    })()
    await sleep(60)
  }
}

export function getRunningTaskIds() {
  return Array.from(running)
}
