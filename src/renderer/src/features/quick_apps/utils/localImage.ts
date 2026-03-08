import type { QuickAppInputImage } from '../types'

export function isDataUrl(s: string) {
  return /^data:/i.test(String(s || ''))
}

export function parseNexaLocalPath(localPath: string): string | null {
  const raw = String(localPath || '').trim()
  if (!/^nexa:\/\//i.test(raw)) return null
  try {
    const u = new URL(raw)
    if (u.hostname !== 'local') return null
    return u.searchParams.get('path')
  } catch {
    return null
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(blob)
  })
}

export async function srcToDataUrl(src: string): Promise<string> {
  const s = String(src || '').trim()
  if (!s) throw new Error('missing src')
  if (isDataUrl(s)) return s
  const resp = await fetch(s)
  if (!resp.ok) throw new Error(`读取缓存图片失败：${resp.status}`)
  const blob = await resp.blob()
  return await blobToDataUrl(blob)
}

export async function ensureQuickAppImageData(img: QuickAppInputImage): Promise<QuickAppInputImage> {
  if (!img) throw new Error('missing image')
  if (img.base64 && img.sourceDataUrl && isDataUrl(img.sourceDataUrl)) return img

  const src = (img.sourceDataUrl && isDataUrl(img.sourceDataUrl))
    ? img.sourceDataUrl
    : String(img.localPath || img.dataUrl || '')

  const dataUrl = await srcToDataUrl(src)
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : ''
  return {
    ...img,
    sourceDataUrl: dataUrl,
    base64: base64 || img.base64
  }
}
