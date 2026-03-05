import { join } from 'path'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { getPersistConfig } from './config'

type KvFile = {
  v: 1
  items: Record<string, string>
}

async function kvPath() {
  const cfg = await getPersistConfig()
  return join(cfg.dataRoot, 'state', 'persist.json')
}

async function load(): Promise<KvFile> {
  const fp = await kvPath()
  try {
    if (!existsSync(fp)) return { v: 1, items: {} }
    const raw = await readFile(fp, 'utf8')
    const parsed = JSON.parse(raw)
    const items = (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') ? parsed.items : {}
    return { v: 1, items: items as Record<string, string> }
  } catch {
    return { v: 1, items: {} }
  }
}

async function save(file: KvFile) {
  const fp = await kvPath()
  try {
    const cfg = await getPersistConfig()
    await mkdir(join(cfg.dataRoot, 'state'), { recursive: true })
  } catch {
    // ignore
  }

  const tmp = fp + '.tmp'
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  try {
    await rename(tmp, fp)
  } catch {
    // fallback
    await writeFile(fp, JSON.stringify(file, null, 2), 'utf8')
  }
}

export async function kvGetItem(key: string): Promise<string | null> {
  const k = String(key || '')
  if (!k) return null
  const f = await load()
  return Object.prototype.hasOwnProperty.call(f.items, k) ? String(f.items[k]) : null
}

export async function kvSetItem(key: string, value: string): Promise<void> {
  const k = String(key || '')
  if (!k) return
  const v = String(value ?? '')
  const f = await load()
  f.items[k] = v
  await save(f)
}

export async function kvRemoveItem(key: string): Promise<void> {
  const k = String(key || '')
  if (!k) return
  const f = await load()
  delete f.items[k]
  await save(f)
}
