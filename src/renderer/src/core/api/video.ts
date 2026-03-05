import axios from 'axios'
import type { RequestDebug, ResponseDebug } from './image'

export type VideoCreateOptions = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string

  // 常见参数（不同网关命名可能不同；这里用最通用的字段名）
  durationSec?: number
  aspectRatio?: string // 例如 16:9 / 9:16
  // 注意：多数视频网关不支持用户自定义清晰度；清晰度通常由 model 决定。
  // 这里保留字段仅用于兼容旧代码/未来扩展，但默认不会发送到接口。
  resolution?: string
  // 注意：多数网关不需要 fps；如果后续确认支持再启用
  fps?: number
  seed?: number

  // veo 等：网关扩展字段
  enhancePrompt?: boolean
  enableUpsample?: boolean

  // i2v：参考图片（base64，不带 data: 前缀）
  image?: string[]

  onRequest?: (req: RequestDebug) => void
  onResponse?: (resp: ResponseDebug) => void
}

export type VideoCreateResult = {
  id: string
  status: string
  // 有些接口会直接给出结果 url
  videoUrl?: string
}

export type VideoPollResult = {
  status: string
  progress?: number
  videoUrl?: string
  errorMessage?: string
}

function joinUrl(base: string, path: string) {
  const b = String(base || '').replace(/\/+$/, '')
  const p = String(path || '').replace(/^\//, '')
  return `${b}/${p}`
}

function stripTrailingPath(baseUrl: string, suffix: string): string {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!suffix) return b
  const s = suffix.replace(/^\//, '')
  if (b.toLowerCase().endsWith('/' + s.toLowerCase())) {
    return b.slice(0, -(s.length + 1))
  }
  return b
}

function buildCreateUrls(baseUrl: string): string[] {
  // 兼容不同网关的路径差异：
  // - /v2/videos/generations (多数)
  // - /v1/video/generations  (部分网关 v1 用单数 video)
  // 同时兼容用户 baseUrl 可能已经包含 /v1 或 /v2，避免拼出 /v1/v1。
  const endpoint = String(baseUrl || '').trim().replace(/\/+$/, '')
  const endsWithV1 = /\/v1$/i.test(endpoint)
  const endsWithV2 = /\/v2$/i.test(endpoint)
  const root = stripTrailingPath(stripTrailingPath(endpoint, 'v1'), 'v2')

  const urls: string[] = []

  // 1) endpoint 本身已带版本：先尝试“该版本下”的直连路径
  if (endsWithV2) {
    urls.push(joinUrl(endpoint, 'videos/generations'))
    urls.push(joinUrl(endpoint, 'video/generations'))
  }

  // 2) 优先 root/v2
  urls.push(joinUrl(root, 'v2/videos/generations'))
  urls.push(joinUrl(root, 'v2/video/generations'))
  urls.push(joinUrl(root, 'videos/generations'))
  urls.push(joinUrl(root, 'video/generations'))

  // 3) v1 放最后（部分网关 v1 可能要求 multipart）
  if (endsWithV1) {
    urls.push(joinUrl(endpoint, 'video/generations'))
    urls.push(joinUrl(endpoint, 'videos/generations'))
  }
  urls.push(joinUrl(root, 'v1/video/generations'))
  urls.push(joinUrl(root, 'v1/videos/generations'))

  const out: string[] = []
  const s = new Set<string>()
  for (const u of urls) {
    const k = String(u)
    if (!k || s.has(k)) continue
    s.add(k)
    out.push(k)
  }
  return out
}

function buildPollUrls(baseUrl: string, id: string): string[] {
  const endpoint = String(baseUrl || '').trim().replace(/\/+$/, '')
  const safeId = encodeURIComponent(String(id))
  const endsWithV1 = /\/v1$/i.test(endpoint)
  const endsWithV2 = /\/v2$/i.test(endpoint)
  const root = stripTrailingPath(stripTrailingPath(endpoint, 'v1'), 'v2')

  const urls: string[] = []

  if (endsWithV2) {
    urls.push(joinUrl(endpoint, `videos/generations/${safeId}`))
    urls.push(joinUrl(endpoint, `video/generations/${safeId}`))
  }

  urls.push(joinUrl(root, `v2/videos/generations/${safeId}`))
  urls.push(joinUrl(root, `v2/video/generations/${safeId}`))
  urls.push(joinUrl(root, `videos/generations/${safeId}`))
  urls.push(joinUrl(root, `video/generations/${safeId}`))

  if (endsWithV1) {
    urls.push(joinUrl(endpoint, `video/generations/${safeId}`))
    urls.push(joinUrl(endpoint, `videos/generations/${safeId}`))
  }
  urls.push(joinUrl(root, `v1/video/generations/${safeId}`))
  urls.push(joinUrl(root, `v1/videos/generations/${safeId}`))

  const out: string[] = []
  const s = new Set<string>()
  for (const u of urls) {
    const k = String(u)
    if (!k || s.has(k)) continue
    s.add(k)
    out.push(k)
  }
  return out
}

function sanitizeForDebug(apiKey: string, url: string, headers: Record<string, string>, body?: any): { req: RequestDebug, urlMasked: string } {
  const key = String(apiKey || '')
  const keyEnc = encodeURIComponent(key)
  const maskStr = (s: string) => {
    let out = String(s || '')
    if (key) {
      out = out.split(key).join('<API_KEY>')
      out = out.split(keyEnc).join('<API_KEY>')
    }
    return out
  }

  const sanitizeBody = (v: any) => {
    try {
      const seen = new WeakSet<any>()
      const text = JSON.stringify(v ?? null, (k, val) => {
        if (typeof val === 'string') {
          if (val.length > 600) return val.slice(0, 160) + `...<len=${val.length}>`
          return val
        }
        if (Array.isArray(val) && val.length > 12) {
          return [...val.slice(0, 12), `...<len=${val.length}>`]
        }
        if (typeof val === 'object' && val) {
          if (seen.has(val)) return '[Circular]'
          seen.add(val)
        }
        return val
      }, 2)
      return JSON.parse(text)
    } catch {
      return v
    }
  }

  const maskedHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers || {})) maskedHeaders[k] = maskStr(String(v))

  return {
    req: {
      method: 'POST',
      url: maskStr(url),
      headers: maskedHeaders,
      body: sanitizeBody(body)
    },
    urlMasked: maskStr(url)
  }
}

function safeJsonPreview(v: any, maxLen: number): string {
  let text = ''
  try {
    const seen = new WeakSet<any>()
    text = JSON.stringify(v ?? null, (k, val) => {
      if (typeof val === 'string') {
        if (val.length > 800) return val.slice(0, 240) + `...<len=${val.length}>`
        return val
      }
      if (typeof val === 'object' && val) {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      return val
    }, 2)
  } catch {
    try {
      text = String(v)
    } catch {
      text = ''
    }
  }
  text = (text || '').trim()
  if (text.length > maxLen) text = text.slice(0, maxLen) + '...'
  return text
}

function sanitizeResponseForDebug(apiKey: string, url: string, status: number | undefined, data: any): ResponseDebug {
  const key = String(apiKey || '')
  const keyEnc = encodeURIComponent(key)
  const maskStr = (s: string) => {
    let out = String(s || '')
    if (key) {
      out = out.split(key).join('<API_KEY>')
      out = out.split(keyEnc).join('<API_KEY>')
    }
    return out
  }

  return {
    status,
    url: maskStr(url),
    dataPreview: maskStr(safeJsonPreview(data, 1600)),
    // 更完整的脱敏响应（用于预览弹窗内查看）；不要直接持久化大段内容
    dataFull: maskStr(safeJsonPreview(data, 48000))
  }
}

function pickId(data: any): string {
  return String(
    data?.id
    || data?.taskId
    || data?.task_id
    || data?.data?.id
    || data?.data?.taskId
    || data?.data?.task_id
    || ''
  ).trim()
}

function pickStatus(data: any): string {
  return String(
    data?.status
    || data?.state
    || data?.data?.status
    || data?.data?.state
    || ''
  ).trim() || 'unknown'
}

function pickProgress(data: any): number | undefined {
  const v = data?.progress ?? data?.percentage ?? data?.data?.progress
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.endsWith('%')) {
      const n = Number.parseFloat(s.slice(0, -1))
      if (Number.isFinite(n)) return n
      return undefined
    }
    const n = Number(s)
    if (Number.isFinite(n)) return n
    return undefined
  }
  const n = v
  if (typeof n === 'number' && Number.isFinite(n)) return n
  return undefined
}

function pickVideoUrl(data: any): string | undefined {
  const looksLikeVideoUrl = (s: string) => {
    const t = String(s || '').trim()
    if (!t) return false
    if (!(t.startsWith('http://') || t.startsWith('https://'))) return false
    // 常见后缀；有些网关是带 query 的 mp4
    const low = t.toLowerCase()
    if (low.includes('.mp4') || low.includes('.webm') || low.includes('.mov') || low.includes('.m3u8')) return true
    // 兜底：很多中转站不带扩展名，但路径里有 video/output
    if (low.includes('video') || low.includes('output')) return true
    return false
  }

  const maybeExtractFrom = (v: any): string | undefined => {
    if (!v) return undefined
    if (typeof v === 'string') return looksLikeVideoUrl(v) ? v.trim() : undefined
    if (Array.isArray(v)) {
      for (const x of v) {
        const hit = maybeExtractFrom(x)
        if (hit) return hit
      }
      return undefined
    }
    if (typeof v === 'object') {
      // 常见字段
      const direct = (v as any).url || (v as any).href || (v as any).output || (v as any).video_url || (v as any).videoUrl
      const hit = maybeExtractFrom(direct)
      if (hit) return hit
    }
    return undefined
  }

  const candidates: any[] = [
    data?.videoUrl,
    data?.video_url,
    data?.outputUrl,
    data?.output_url,
    data?.output,
    data?.result?.url,
    data?.result?.video?.url,
    data?.video?.url,
    data?.data?.url,
    data?.data?.videoUrl,
    data?.data?.video_url,
    data?.data?.result?.url,
    data?.data?.output,
    data?.data?.result?.output
  ]

  // 常见：data: [{ url }]
  if (Array.isArray(data?.data) && data.data[0]?.url) candidates.push(data.data[0].url)
  // 常见：data.output: [{ url }]
  if (Array.isArray(data?.data?.output) && data.data.output[0]?.url) candidates.push(data.data.output[0].url)

  for (const c of candidates) {
    const hit = maybeExtractFrom(c)
    if (hit) return hit
  }

  // 兜底：遍历整棵对象找第一个像视频的 url
  try {
    const seen = new WeakSet<any>()
    let walked = 0
    const maxNodes = 2000
    const walk = (node: any): string | undefined => {
      if (walked++ > maxNodes) return undefined
      if (!node) return undefined
      if (typeof node === 'string') return looksLikeVideoUrl(node) ? node.trim() : undefined
      if (typeof node !== 'object') return undefined
      if (seen.has(node)) return undefined
      seen.add(node)
      if (Array.isArray(node)) {
        for (const x of node) {
          const hit = walk(x)
          if (hit) return hit
        }
        return undefined
      }
      for (const k of Object.keys(node)) {
        const hit = walk((node as any)[k])
        if (hit) return hit
      }
      return undefined
    }
    const hit = walk(data)
    if (hit) return hit
  } catch {
    // ignore
  }

  return undefined
}

async function postJsonWithFallbacks(
  apiKey: string,
  urls: string[],
  body: any,
  onRequest?: (r: RequestDebug) => void,
  onResponse?: (r: ResponseDebug) => void
) {
  let lastErr: any = null
  for (const url of urls) {
    // 依次尝试：Bearer / query key / x-goog-api-key
    const headerVariants: Record<string, string>[] = [
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      { 'Content-Type': 'application/json' },
      { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }
    ]

    for (let i = 0; i < headerVariants.length; i++) {
      const headers = headerVariants[i]
      const finalUrl = i === 1 ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}` : url
      try {
        const { req } = sanitizeForDebug(apiKey, finalUrl, headers, body)
        onRequest && onRequest(req)
        const resp = await axios.post(finalUrl, body, { headers })
        onResponse && onResponse(sanitizeResponseForDebug(apiKey, finalUrl, resp?.status, resp?.data))
        return resp
      } catch (e: any) {
        lastErr = e
        const status = e?.response?.status
        const msg = String(
          e?.response?.data?.error?.message
          || e?.response?.data?.message
          || e?.response?.data?.error
          || e?.response?.data?.code
          || e?.message
          || ''
        ).toLowerCase()
        // 404/405：尝试下一个 url；401/403：尝试下一个鉴权方式
        if (status === 404 || status === 405 || status === 401 || status === 403) continue
        // 部分网关会对“不支持的 endpoint/body”返回 500（例如要求 multipart / 不支持 json），此时继续尝试其他路径
        if (status >= 500 && (
          msg.includes('invalid url')
          || msg.includes('multipart')
          || msg.includes('build_request_failed')
          || msg.includes('unsupported content type')
          || msg.includes('unsupport content type')
          || (msg.includes('content type') && msg.includes('application/json'))
        )) {
          continue
        }
        throw e
      }
    }
  }
  throw lastErr || new Error('request failed')
}

async function getJsonWithFallbacks(
  apiKey: string,
  urls: string[],
  onResponse?: (r: ResponseDebug) => void
) {
  let lastErr: any = null
  for (const url of urls) {
    const headerVariants: Record<string, string>[] = [
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      { 'Content-Type': 'application/json' },
      { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }
    ]

    for (let i = 0; i < headerVariants.length; i++) {
      const headers = headerVariants[i]
      const finalUrl = i === 1 ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}` : url
      try {
        const resp = await axios.get(finalUrl, { headers })
        onResponse && onResponse(sanitizeResponseForDebug(apiKey, finalUrl, resp?.status, resp?.data))
        return resp
      } catch (e: any) {
        lastErr = e
        const status = e?.response?.status
        if (status === 404 || status === 405 || status === 401 || status === 403) continue
        throw e
      }
    }
  }
  throw lastErr || new Error('request failed')
}

export async function createVideoGeneration(options: VideoCreateOptions): Promise<VideoCreateResult> {
  const endpoint = options.baseUrl.trim()

  const body: any = {
    model: options.model,
    prompt: options.prompt
  }
  if (typeof options.durationSec === 'number') body.duration = options.durationSec
  const isComponents = String(options.model || '').toLowerCase().includes('components')
  if (options.aspectRatio && !isComponents) body.aspect_ratio = options.aspectRatio
  // 不发送 resolution/image_size：清晰度通常由模型名（如 *-4k）决定
  // fps 默认不发送（避免接口不支持导致 400）
  if (typeof options.fps === 'number') body.fps = options.fps
  if (typeof options.seed === 'number') body.seed = options.seed

  // veo 扩展参数
  if (options.enhancePrompt === true) body.enhance_prompt = true
  if (options.enableUpsample === true && !isComponents) body.enable_upsample = true
  if (Array.isArray(options.image) && options.image.length > 0) body.image = options.image
  // 兼容部分实现使用 images 字段
  if (Array.isArray(options.image) && options.image.length > 0) body.images = options.image

  const urls = buildCreateUrls(endpoint)

  const resp = await postJsonWithFallbacks(options.apiKey, urls, body, options.onRequest, options.onResponse)
  const videoUrl = pickVideoUrl(resp?.data)
  const id = pickId(resp?.data)
  // 有些实现会同步返回 video url，但不返回任务 id：此时按同步成功处理
  if (!id && videoUrl) {
    return { id: `inline_${Date.now()}`, status: pickStatus(resp?.data) || 'succeeded', videoUrl }
  }
  if (!id) {
    const preview = safeJsonPreview(resp?.data, 1200)
    throw new Error(`视频生成接口未返回任务 id\n\nraw: ${preview}`)
  }
  return { id, status: pickStatus(resp?.data), videoUrl }
}

export async function pollVideoGeneration(baseUrl: string, apiKey: string, id: string, onResponse?: (r: ResponseDebug) => void): Promise<VideoPollResult> {
  const urls = buildPollUrls(baseUrl, id)

  // 与 create 一致：Bearer / query key / x-goog-api-key
  const headerVariants: Array<{ headers: Record<string, string>, urlMode: 'as-is' | 'with-key' }> = [
    { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, urlMode: 'as-is' },
    { headers: { 'Content-Type': 'application/json' }, urlMode: 'with-key' },
    { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, urlMode: 'as-is' }
  ]

  const normalizeStatus = (s: string) => String(s || '').trim().toLowerCase()
  const isTerminalSuccess = (st: string) => ['succeeded', 'success', 'completed', 'done'].includes(normalizeStatus(st))
  const isTerminalFail = (st: string) => ['failed', 'failure', 'fail', 'error', 'canceled', 'cancelled'].includes(normalizeStatus(st))

  let best: { score: number, result: VideoPollResult } | null = null
  let lastErr: any = null

  for (const url of urls) {
    for (const v of headerVariants) {
      const finalUrl = v.urlMode === 'with-key'
        ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`
        : url

      try {
        const resp = await axios.get(finalUrl, { headers: v.headers, validateStatus: () => true })
        onResponse && onResponse(sanitizeResponseForDebug(apiKey, finalUrl, resp?.status, resp?.data))

        const http = resp.status
        if ([404, 405, 401, 403].includes(http)) continue
        if (http >= 500) {
          // 5xx：可能是临时故障/也可能是 endpoint 不兼容，留给上层重试
          lastErr = new Error(`poll failed (HTTP ${http})`)
          continue
        }
        if (http >= 400) {
          // 4xx 但不是鉴权/路径错误：视为硬错误
          const msg = String(resp?.data?.error?.message || resp?.data?.message || '')
          throw new Error(msg || `poll failed (HTTP ${http})`)
        }

        const status = pickStatus(resp?.data)
        const videoUrl = pickVideoUrl(resp?.data)
        const progress = pickProgress(resp?.data)
        const errorMessage = resp?.data?.error?.message
          || resp?.data?.message
          || resp?.data?.fail_reason
          || resp?.data?.data?.fail_reason
          || resp?.data?.error

        const r: VideoPollResult = {
          status,
          progress,
          videoUrl,
          errorMessage: typeof errorMessage === 'string' ? errorMessage : undefined
        }

        // 直接命中：成功且有 url / 失败且有原因
        if (isTerminalSuccess(status) && videoUrl) return r
        if (isTerminalFail(status)) return r

        // 评分：优先选择含 url / 含 status / 含 progress 的响应（避免命中一个永远 IN_PROGRESS 的旧 endpoint）
        let score = 0
        if (videoUrl) score += 1000
        if (status && status !== 'unknown') score += 80
        if (progress !== undefined) score += 20
        if (typeof r.errorMessage === 'string' && r.errorMessage.trim()) score += 40
        if (best == null || score > best.score) best = { score, result: r }
      } catch (e: any) {
        lastErr = e
        // 继续尝试其他 url
        continue
      }
    }
  }

  if (best) return best.result
  throw lastErr || new Error('poll failed')
}
