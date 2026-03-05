import { app, shell } from 'electron'
import { join, resolve, isAbsolute } from 'path'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { existsSync } from 'fs'

export type PersistConfig = {
  setupCompleted: boolean
  dataRoot: string
  imageOutputDirectory: string
  videoOutputDirectory: string
}

const CONFIG_FILE = 'nexa-config.json'

function defaultDataRoot() {
  // Easier for normal users to find/backup than AppData
  return join(app.getPath('documents'), 'Nexa')
}

function normalizeAbsPath(p: string) {
  const raw = String(p || '').trim()
  if (!raw) return ''
  return isAbsolute(raw) ? raw : resolve(raw)
}

function defaultConfig(): PersistConfig {
  const root = defaultDataRoot()
  return {
    setupCompleted: false,
    dataRoot: root,
    imageOutputDirectory: join(root, 'output', 'images'),
    videoOutputDirectory: join(root, 'output', 'videos')
  }
}

function configPath() {
  return join(app.getPath('userData'), CONFIG_FILE)
}

let cached: PersistConfig | null = null

async function ensureDir(p: string) {
  if (!p) return
  try {
    await mkdir(p, { recursive: true })
  } catch {
    // ignore
  }
}

async function ensureConfigDirs(cfg: PersistConfig) {
  await ensureDir(cfg.dataRoot)
  await ensureDir(join(cfg.dataRoot, 'state'))
  await ensureDir(cfg.imageOutputDirectory)
  await ensureDir(cfg.videoOutputDirectory)
}

export async function getPersistConfig(): Promise<PersistConfig> {
  if (cached) return cached
  const fp = configPath()
  const d = defaultConfig()
  try {
    if (!existsSync(fp)) {
      await ensureConfigDirs(d)
      await writeFile(fp, JSON.stringify(d, null, 2), 'utf8')
      cached = d
      return d
    }
    const raw = await readFile(fp, 'utf8')
    const parsed = JSON.parse(raw)
    const root = normalizeAbsPath(parsed?.dataRoot) || d.dataRoot
    const img = normalizeAbsPath(parsed?.imageOutputDirectory) || join(root, 'output', 'images')
    const vid = normalizeAbsPath(parsed?.videoOutputDirectory) || join(root, 'output', 'videos')
    const cfg: PersistConfig = {
      setupCompleted: Boolean(parsed?.setupCompleted),
      dataRoot: root,
      imageOutputDirectory: img,
      videoOutputDirectory: vid
    }
    await ensureConfigDirs(cfg)
    cached = cfg
    return cfg
  } catch {
    await ensureConfigDirs(d)
    cached = d
    return d
  }
}

export async function setPersistConfig(patch: Partial<PersistConfig>) {
  const prev = await getPersistConfig()
  const next: PersistConfig = { ...prev, ...patch }

  next.dataRoot = normalizeAbsPath(next.dataRoot) || prev.dataRoot
  next.imageOutputDirectory = normalizeAbsPath(next.imageOutputDirectory) || join(next.dataRoot, 'output', 'images')
  next.videoOutputDirectory = normalizeAbsPath(next.videoOutputDirectory) || join(next.dataRoot, 'output', 'videos')

  // migrate state file when dataRoot changes
  if (next.dataRoot !== prev.dataRoot) {
    const oldState = join(prev.dataRoot, 'state', 'persist.json')
    const newState = join(next.dataRoot, 'state', 'persist.json')
    try {
      await ensureDir(join(next.dataRoot, 'state'))
      if (existsSync(oldState) && !existsSync(newState)) {
        try {
          await rename(oldState, newState)
        } catch {
          const buf = await readFile(oldState)
          await writeFile(newState, buf)
        }
      }
    } catch {
      // ignore
    }
  }

  await ensureConfigDirs(next)
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
  cached = next
  return next
}

export async function openDataRootInExplorer() {
  const cfg = await getPersistConfig()
  void shell.openPath(cfg.dataRoot)
  return { ok: true, path: cfg.dataRoot }
}

export async function resolveUserPath(inputPath: string, kind: 'image' | 'video' | 'any' = 'any') {
  const cfg = await getPersistConfig()
  const raw = String(inputPath || '').trim()
  if (!raw) {
    if (kind === 'image') return cfg.imageOutputDirectory
    if (kind === 'video') return cfg.videoOutputDirectory
    return cfg.dataRoot
  }
  if (isAbsolute(raw)) return raw
  return join(cfg.dataRoot, raw)
}
