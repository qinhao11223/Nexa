import { BrowserWindow, shell, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'

export type UpdateChannel = 'stable' | 'beta'

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'update-available'; version: string; releaseNotes: string }
  | { type: 'update-not-available'; version: string }
  | { type: 'download-progress'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'error'; message: string }

let win: BrowserWindow | null = null
let initialized = false
let channel: UpdateChannel = 'stable'

function releaseNotesToText(notes: any): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    // electron-updater may provide array of { version, note } objects
    return notes
      .map(n => {
        if (!n) return ''
        if (typeof n === 'string') return n
        const v = (n.version ? `v${n.version}` : '').trim()
        const t = String(n.note || '').trim()
        return [v, t].filter(Boolean).join('\n')
      })
      .filter(Boolean)
      .join('\n\n')
  }
  try {
    return JSON.stringify(notes, null, 2)
  } catch {
    return String(notes)
  }
}

function send(evt: UpdaterEvent) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('nexa-updater-event', evt)
}

export function initUpdater(mainWindow: BrowserWindow) {
  win = mainWindow
  if (initialized) return
  initialized = true

  // Logging for production troubleshooting
  try {
    log.transports.file.level = 'info'
    ;(autoUpdater as any).logger = log
  } catch {
    // ignore
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    send({ type: 'checking' })
  })

  autoUpdater.on('update-available', (info: any) => {
    send({
      type: 'update-available',
      version: String(info?.version || ''),
      releaseNotes: releaseNotesToText(info?.releaseNotes)
    })
  })

  autoUpdater.on('update-not-available', (info: any) => {
    send({ type: 'update-not-available', version: String(info?.version || '') })
  })

  autoUpdater.on('download-progress', (p: any) => {
    send({
      type: 'download-progress',
      percent: Number(p?.percent || 0),
      bytesPerSecond: Number(p?.bytesPerSecond || 0),
      transferred: Number(p?.transferred || 0),
      total: Number(p?.total || 0)
    })
  })

  autoUpdater.on('update-downloaded', (info: any) => {
    send({ type: 'update-downloaded', version: String(info?.version || '') })
  })

  autoUpdater.on('error', (err: any) => {
    const msg = String(err?.message || err || 'updater error')
    send({ type: 'error', message: msg })
  })
}

export function setUpdateChannel(next: UpdateChannel) {
  channel = next
  autoUpdater.allowPrerelease = channel === 'beta'
}

export function getUpdateChannel(): UpdateChannel {
  return channel
}

export async function checkForUpdates() {
  if (!app.isPackaged) {
    return { ok: false, error: 'not packaged' }
  }
  try {
    const r = await autoUpdater.checkForUpdates()
    return { ok: true, updateInfo: (r as any)?.updateInfo }
  } catch (e: any) {
    const msg = String(e?.message || 'check failed')
    send({ type: 'error', message: msg })
    return { ok: false, error: msg }
  }
}

export async function downloadUpdate() {
  if (!app.isPackaged) {
    return { ok: false, error: 'not packaged' }
  }
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (e: any) {
    const msg = String(e?.message || 'download failed')
    send({ type: 'error', message: msg })
    return { ok: false, error: msg }
  }
}

export function quitAndInstall() {
  try {
    autoUpdater.quitAndInstall(true, true)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || 'quitAndInstall failed') }
  }
}

export function openReleasesPage() {
  const url = 'https://github.com/qinhao11223/Nexa/releases'
  void shell.openExternal(url)
  return { ok: true, url }
}
