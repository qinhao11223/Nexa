import axios from 'axios'

export interface GenerateImageOptions {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  n?: number
  size?: string // 例如 "1024x1024" (OpenAI 标准)，后续可以根据你们中转平台的自定义参数扩展
  saveDir?: string // 传入要保存的本地目录
  // 非 OpenAI 标准：部分网关（如 comfly）使用比例/档位，而不是像素尺寸
  aspectRatio?: string // 例如 "3:4" / "16:9"
  imageSize?: string   // 例如 "1K" / "2K" / "4K"

  // 图生图：参考图像（base64，通常不带 data: 前缀；多数网关支持数组形式）
  image?: string[]

  // 可选：用于调试/复制请求代码（注意：内部会脱敏 apiKey）
  onRequest?: (req: RequestDebug) => void

  // 可选：用于调试展示接口返回（内部会脱敏 apiKey，并截断）
  onResponse?: (resp: ResponseDebug) => void
}

export type RequestDebug = {
  method: 'POST'
  url: string
  headers: Record<string, string>
  body: any
}

export type ResponseDebug = {
  status?: number
  url: string
  // 截断后的响应文本（避免 base64/HTML 超长撑爆 localStorage）
  dataPreview: string
  // 可选：更完整的响应文本（仍会脱敏）；建议不要持久化到 localStorage
  dataFull?: string
}

function parseSize(size: string): { width: number, height: number } | null {
  // 解析类似 "1024x1024" 的尺寸字符串
  const m = /^\s*(\d{2,5})\s*x\s*(\d{2,5})\s*$/.exec(size)
  if (!m) return null
  const width = parseInt(m[1], 10)
  const height = parseInt(m[2], 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

// 说明：不同平台/模型对 size 支持差异很大。
// 这里针对已知限制（例如 OpenAI DALL·E 系列）做“最接近的合法映射”，
// 避免用户在 UI 里选 2K/4K 或更多比例时，平台直接忽略 size，导致看起来总是 1K 或 1:1。
function normalizeSizeForModel(model: string, requestedSize: string): string {
  const m = (model || '').toLowerCase()
  const parsed = parseSize(requestedSize)
  if (!parsed) return requestedSize

  if (m.includes('dall-e-3') || m.includes('dall·e-3') || m === 'dall-e-3') {
    // DALL·E 3 仅支持 3 个固定尺寸：1024x1024 / 1792x1024 / 1024x1792
    if (Math.abs(parsed.width - parsed.height) < 64) return '1024x1024'
    if (parsed.width > parsed.height) return '1792x1024'
    return '1024x1792'
  }

  if (m.includes('dall-e-2') || m.includes('dall·e-2') || m === 'dall-e-2') {
    // DALL·E 2 只支持方图：256/512/1024（这里统一给 1024）
    return '1024x1024'
  }

  return requestedSize
}

function isDalleModel(model: string): boolean {
  const m = (model || '').toLowerCase()
  return m.includes('dall-e-3') || m.includes('dall·e-3') || m === 'dall-e-3'
    || m.includes('dall-e-2') || m.includes('dall·e-2') || m === 'dall-e-2'
}

function isComflyBaseUrl(baseUrl: string): boolean {
  const s = (baseUrl || '').toLowerCase()
  if (s.includes('ai.comfly.chat')) return true
  // 兜底：某些用户会填 comfly.chat
  if (s.includes('comfly.chat')) return true
  return false
}

function joinUrl(base: string, path: string): string {
  let b = (base || '').trim()
  if (!b.endsWith('/')) b += '/'
  const p = (path || '').replace(/^\//, '')
  return b + p
}

function stripTrailingPath(baseUrl: string, suffix: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!suffix) return b
  const s = suffix.replace(/^\//, '')
  if (b.toLowerCase().endsWith('/' + s.toLowerCase())) {
    return b.slice(0, -(s.length + 1))
  }
  return b
}

async function postJsonWithFallbacks(
  urls: { url: string, headers: any }[],
  body: any,
  continueOnStatuses: number[] = [404, 405]
) {
  let lastErr: any = null
  const tried: { url: string, status?: number }[] = []
  for (const u of urls) {
    try {
      const resp = await axios.post(u.url, body, { headers: u.headers })
      return { resp, used: u }
    } catch (e: any) {
      lastErr = e
      const status = e?.response?.status
      tried.push({ url: u.url, status })
      // 404/405：大概率是 path 不对；401/403：可能是鉴权方式不对
      if (typeof status === 'number' && continueOnStatuses.includes(status)) continue
      // 其他错误（鉴权/额度/参数错误）：直接抛出，避免掩盖真实问题
      throw e
    }
  }

  // 如果全是 404/405，把尝试过的 url 带出来，方便用户快速修正 baseUrl
  const triedText = tried
    .slice(0, 10)
    .map(t => `${t.status || 'ERR'} ${t.url}`)
    .join('\n')
  if (lastErr && (lastErr?.response?.status === 404 || lastErr?.response?.status === 405)) {
    throw new Error(`comfly 接口路径未命中（${lastErr?.response?.status}）。已尝试：\n${triedText}`)
  }

  throw lastErr || new Error(`request failed. tried:\n${triedText}`)
}

function sanitizeRequestForDebug(apiKey: string, req: { url: string, headers: any, body: any }): RequestDebug {
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

  const headers: Record<string, string> = {}
  const h = req.headers || {}
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue
    headers[String(k)] = maskStr(String(v))
  }

  // 避免把超长 base64（图生图）塞进 localStorage：这里对 body 做截断副本
  const sanitizeBody = (body: any) => {
    try {
      const seen = new WeakSet<any>()
      const text = JSON.stringify(body ?? null, (k, val) => {
        if (typeof val === 'string') {
          const s = val
          if (s.length > 600) return s.slice(0, 160) + `...<len=${s.length}>`
          return s
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
      return body
    }
  }

  return {
    method: 'POST',
    url: maskStr(String(req.url || '')),
    headers,
    body: sanitizeBody(req.body)
  }
}

function safeJsonPreview(v: any, maxLen: number): string {
  let text = ''
  try {
    const seen = new WeakSet<any>()
    text = JSON.stringify(v ?? null, (k, val) => {
      if (typeof val === 'string') {
        const s = val
        if (s.length > 800) return s.slice(0, 240) + `...<len=${s.length}>`
        return s
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

function sanitizeResponseForDebug(apiKey: string, resp: { url: string, status?: number, data: any }): ResponseDebug {
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

  const dataPreview = maskStr(safeJsonPreview(resp.data, 1600))
  return {
    status: resp.status,
    url: maskStr(String(resp.url || '')),
    dataPreview
  }
}

function extractImageLikeOutputs(data: any): { dataUrls: string[], urls: string[] } {
  const dataUrls: string[] = []
  const urls: string[] = []

  const seen = new Set<any>()
  const maxNodes = 20000
  let walked = 0

  const pushDataUrl = (mimeType: string | undefined, base64: string) => {
    const mt = (mimeType || '').trim() || 'image/png'
    const b64 = (base64 || '').trim()
    if (!b64) return
    dataUrls.push(`data:${mt};base64,${b64}`)
  }

  const maybePushUrl = (u: any) => {
    if (typeof u !== 'string') return
    const s = u.trim()
    if (!s) return
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/')) {
      urls.push(s)
    }
  }

  const maybePushUrlsFromText = (text: string) => {
    const t = (text || '').trim()
    if (!t) return

    // 1) Markdown image: ![alt](https://...)
    const mdImg = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi
    let m: RegExpExecArray | null
    while ((m = mdImg.exec(t))) {
      maybePushUrl(m[1])
    }

    // 2) Markdown link: [text](https://...)
    const mdLink = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi
    while ((m = mdLink.exec(t))) {
      maybePushUrl(m[1])
    }

    // 3) Plain URLs
    const plain = /(https?:\/\/[^\s)\]}>"']+)/gi
    while ((m = plain.exec(t))) {
      maybePushUrl(m[1])
    }
  }

  const walk = (node: any, depth: number) => {
    if (node == null) return
    if (walked++ > maxNodes) return
    if (depth > 20) return
    if (typeof node !== 'object') {
      // 允许直接返回 data url
      if (typeof node === 'string') {
        maybePushUrl(node)
        maybePushUrlsFromText(node)
      }
      return
    }
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }

    // 常见：Gemini/comfly inlineData
    const inlineData = (node as any).inlineData || (node as any).inline_data
    if (inlineData && typeof inlineData === 'object') {
      const b64 = (inlineData as any).data
      const mimeType = (inlineData as any).mimeType || (inlineData as any).mime_type
      if (typeof b64 === 'string' && b64.trim()) {
        pushDataUrl(typeof mimeType === 'string' ? mimeType : undefined, b64)
      }
    }

    // 兼容 OpenAI images API：b64_json
    const b64Json = (node as any).b64_json
    if (typeof b64Json === 'string' && b64Json.trim()) {
      pushDataUrl('image/png', b64Json)
    }

    // 兼容 url 返回
    maybePushUrl((node as any).url)

    // 继续遍历
    for (const k of Object.keys(node)) {
      walk((node as any)[k], depth + 1)
    }
  }

  walk(data, 0)

  // 去重（保持顺序）
  const uniq = (arr: string[]) => {
    const out: string[] = []
    const s = new Set<string>()
    for (const x of arr) {
      if (s.has(x)) continue
      s.add(x)
      out.push(x)
    }
    return out
  }

  return { dataUrls: uniq(dataUrls), urls: uniq(urls) }
}

function extractTextLikeOutputs(data: any): string[] {
  const texts: string[] = []
  const seen = new Set<any>()
  const maxNodes = 20000
  let walked = 0

  const walk = (node: any, depth: number) => {
    if (node == null) return
    if (walked++ > maxNodes) return
    if (depth > 20) return
    if (typeof node === 'string') {
      const s = node.trim()
      // 过滤掉明显的 base64/data url
      if (!s) return
      if (s.startsWith('data:image/')) return
      if (s.length > 8) texts.push(s)
      return
    }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }

    // 常见字段：text
    const t = (node as any).text
    if (typeof t === 'string' && t.trim()) texts.push(t.trim())

    for (const k of Object.keys(node)) {
      walk((node as any)[k], depth + 1)
    }
  }

  walk(data, 0)

  // 去重（保持顺序）+ 限制长度
  const out: string[] = []
  const s = new Set<string>()
  for (const x of texts) {
    if (s.has(x)) continue
    s.add(x)
    out.push(x)
    if (out.length >= 6) break
  }
  return out
}

/**
 * 兼容 OpenAI /v1/images/generations 格式的生图接口
 */
export async function generateImage(options: GenerateImageOptions): Promise<string[]> {
  let endpoint = options.baseUrl.trim()
  if (!endpoint.endsWith('/')) {
    endpoint += '/'
  }

  // comfly：尝试按“OpenAI images/generations 风格”调用（与参考软件一致）
  // 说明：如果该网关支持 image_size + aspect_ratio，会比 generateContent 更容易稳定返回正确比例/分辨率。
  if (isComflyBaseUrl(endpoint) && (options.aspectRatio || options.imageSize)) {
    const aspectRatio = (options.aspectRatio || '').trim()
    const imageSize = (options.imageSize || '').trim()
    if (!aspectRatio || !imageSize) {
      throw new Error('comfly 生图需要 aspectRatio + imageSize')
    }

    const url = `${endpoint}images/generations`
    const body: any = {
      model: options.model,
      prompt: options.prompt,
      n: options.n || 1,
      response_format: 'url',
      image_size: imageSize,
      aspect_ratio: aspectRatio
    }

    if (Array.isArray(options.image) && options.image.length > 0) {
      body.image = options.image
    }

    const candidates: { url: string, headers: any }[] = [
      // 参考软件：Bearer
      {
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${options.apiKey}`
        }
      },
      // 兜底：部分实现允许 query key
      {
        url: `${url}?key=${encodeURIComponent(options.apiKey)}`,
        headers: { 'Content-Type': 'application/json' }
      },
      // 兜底：x-goog-api-key
      {
        url,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': options.apiKey
        }
      }
    ]

    // 先给一份默认请求，确保失败也能复制
    options.onRequest?.(sanitizeRequestForDebug(options.apiKey, { url: candidates[0].url, headers: candidates[0].headers, body }))

    // 404/405：路径不对；401/403：鉴权方式不对（尝试下一种）
    const { resp, used } = await postJsonWithFallbacks(candidates, body, [404, 405, 401, 403])
    options.onRequest?.(sanitizeRequestForDebug(options.apiKey, { url: used.url, headers: used.headers, body }))
    options.onResponse?.(sanitizeResponseForDebug(options.apiKey, { url: used.url, status: resp?.status, data: resp?.data }))

    // 解析：兼容 url / b64 / inlineData / markdown 文本
    const extracted = extractImageLikeOutputs(resp?.data)
    const images = extracted.dataUrls.length > 0 ? extracted.dataUrls : extracted.urls
    if (images.length > 0) return images

    // 仍然没拿到：把 raw 返回给用户排查
    let respPreview = ''
    try {
      respPreview = JSON.stringify(resp?.data)
    } catch {
      respPreview = ''
    }
    respPreview = (respPreview || '').trim()
    if (respPreview.length > 1200) respPreview = respPreview.slice(0, 1200) + '...'
    throw new Error(`接口返回格式异常（未找到图片数据/URL）${respPreview ? `\n\nraw: ${respPreview}` : ''}`)
  }

  // 映射分辨率。绝大部分标准兼容接口支持的是像素尺寸
  // 如果调用方传了 size (如 "1024x1792")，则直接使用；否则默认 1024x1024
  let mappedSize = options.size || '1024x1024'
  mappedSize = normalizeSizeForModel(options.model, mappedSize)
  const parsed = parseSize(mappedSize)
  const width = parsed?.width ?? 1024
  const height = parsed?.height ?? 1024

  const maxRetries = 2
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 尺寸策略：
      // - DALL·E：严格按 OpenAI 协议用 size（固定枚举），否则会 400
      // - 非 DALL·E（例如 SD/ComfyUI 网关）：优先只传 width/height，避免某些中转看到 size 后启用“自动放大/重定标”导致实际像素偏离
      const baseBody: any = {
        model: options.model,
        prompt: options.prompt,
        n: options.n || 1
      }

      if (Array.isArray(options.image) && options.image.length > 0) {
        baseBody.image = options.image
      }

      const preferExactWh = !isDalleModel(options.model)
      const bodyWhOnly: any = { ...baseBody, width, height }
      const bodyWithSize: any = { ...baseBody, size: mappedSize, width, height }

      let response
      try {
        options.onRequest?.(sanitizeRequestForDebug(options.apiKey, {
          url: `${endpoint}images/generations`,
          headers: {
            'Authorization': `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: preferExactWh ? bodyWhOnly : bodyWithSize
        }))

        response = await axios.post(
          `${endpoint}images/generations`,
          preferExactWh ? bodyWhOnly : bodyWithSize,
          {
            headers: {
              'Authorization': `Bearer ${options.apiKey}`,
              'Content-Type': 'application/json'
            }
          }
        )

        options.onResponse?.(sanitizeResponseForDebug(options.apiKey, { url: `${endpoint}images/generations`, status: response?.status, data: response?.data }))
      } catch (e: any) {
        // fallback：部分网关要求必须带 size（即便它最终会忽略/映射）
        const status = e?.response?.status
        const msg = String(e?.response?.data?.error?.message || e?.message || '')
        const looksLikeSizeRequired = status === 400 && /\bsize\b/i.test(msg)
        if (preferExactWh && looksLikeSizeRequired) {
          options.onRequest?.(sanitizeRequestForDebug(options.apiKey, {
            url: `${endpoint}images/generations`,
            headers: {
              'Authorization': `Bearer ${options.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: bodyWithSize
          }))

          response = await axios.post(
            `${endpoint}images/generations`,
            bodyWithSize,
            {
              headers: {
                'Authorization': `Bearer ${options.apiKey}`,
                'Content-Type': 'application/json'
              }
            }
          )

          options.onResponse?.(sanitizeResponseForDebug(options.apiKey, { url: `${endpoint}images/generations`, status: response?.status, data: response?.data }))
        } else {
          throw e
        }
      }

      // 解析：兼容 url / b64_json / inlineData / markdown 文本
      const extracted = extractImageLikeOutputs(response?.data)
      const images = extracted.dataUrls.length > 0 ? extracted.dataUrls : extracted.urls

      if (images.length > 0) {
        // 如果提供了本地保存目录，并且环境支持 electron 下载
        if (options.saveDir && window.nexaAPI) {
          const localUrls = await Promise.all(images.map(async (url: string) => {
            const fileName = `nexa_${Date.now()}_${Math.floor(Math.random() * 1000)}`
            const result = await window.nexaAPI!.downloadImage({
              url,
              saveDir: options.saveDir!,
              fileName
            })
            return (result.success && result.localPath) ? result.localPath : url
          }))
          return localUrls
        }

        return images
      }

      throw new Error('接口返回格式异常（未找到图片数据/URL）')
    } catch (error: any) {
      const status = error?.response?.status
      const isRetryable = status === 429 || status === 408 || (status >= 500 && status < 600)

      if (attempt < maxRetries && isRetryable) {
        // 退避重试，减少“系统繁忙/队列已满”的概率
        await sleep(600 * (attempt + 1))
        continue
      }

      if (error.response && error.response.data && error.response.data.error) {
        throw new Error(error.response.data.error.message || '生图接口请求失败')
      }
      throw error
    }
  }

  throw new Error('生图请求失败，请稍后重试')
}
