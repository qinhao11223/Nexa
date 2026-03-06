import { app, BrowserWindow, protocol, net, screen } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { open, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { sniffImage } from './utils/sniffImage'
import { sniffVideo } from './utils/sniffVideo'
import { initUpdater } from './updater'
import { kvGetItem, kvSetItem } from './persist/kv'

// 注册自定义协议的权限（需要在 app ready 之前）
protocol.registerSchemesAsPrivileged([
  { scheme: 'nexa', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])

let mainWindow: BrowserWindow | null = null

const WINDOW_STATE_KEY = 'window:main'
const DEFAULT_BOUNDS = { width: 1200, height: 800 }
const MIN_BOUNDS = { width: 860, height: 640 }

type WindowState = {
  bounds: { x: number, y: number, width: number, height: number }
  isMaximized?: boolean
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function isFiniteNum(x: any): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function coerceBounds(raw: any): WindowState['bounds'] | null {
  const b = raw && typeof raw === 'object' ? raw : null
  if (!b) return null
  const x = Number(b.x)
  const y = Number(b.y)
  const width = Number(b.width)
  const height = Number(b.height)
  if (![x, y, width, height].every(isFiniteNum)) return null
  if (width < 100 || height < 100) return null
  return { x, y, width, height }
}

function isMostlyVisible(bounds: WindowState['bounds']) {
  const displays = screen.getAllDisplays()
  for (const d of displays) {
    const wa = d.workArea
    const ix0 = Math.max(bounds.x, wa.x)
    const iy0 = Math.max(bounds.y, wa.y)
    const ix1 = Math.min(bounds.x + bounds.width, wa.x + wa.width)
    const iy1 = Math.min(bounds.y + bounds.height, wa.y + wa.height)
    const iw = Math.max(0, ix1 - ix0)
    const ih = Math.max(0, iy1 - iy0)
    // At least a reasonable portion of the window is inside some display.
    if (iw >= 160 && ih >= 120) return true
  }
  return false
}

function normalizeBounds(bounds: WindowState['bounds']) {
  const primary = screen.getPrimaryDisplay().workArea
  const maxW = Math.max(MIN_BOUNDS.width, primary.width)
  const maxH = Math.max(MIN_BOUNDS.height, primary.height)

  const width = clamp(bounds.width, MIN_BOUNDS.width, maxW)
  const height = clamp(bounds.height, MIN_BOUNDS.height, maxH)

  let x = bounds.x
  let y = bounds.y

  if (!isMostlyVisible({ x, y, width, height })) {
    x = Math.round(primary.x + (primary.width - width) / 2)
    y = Math.round(primary.y + (primary.height - height) / 2)
  }

  return { x, y, width, height }
}

async function loadWindowState(): Promise<WindowState | null> {
  try {
    const raw = await kvGetItem(WINDOW_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const bounds = coerceBounds(parsed?.bounds)
    if (!bounds) return null
    return { bounds, isMaximized: Boolean(parsed?.isMaximized) }
  } catch {
    return null
  }
}

async function saveWindowState(win: BrowserWindow) {
  try {
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    const payload: WindowState = {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      isMaximized
    }
    await kvSetItem(WINDOW_STATE_KEY, JSON.stringify(payload))
  } catch {
    // ignore
  }
}

function makeDebounced(fn: () => void, waitMs: number) {
  let t: NodeJS.Timeout | null = null
  return () => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      fn()
    }, waitMs)
  }
}

async function createWindow() {
  const saved = await loadWindowState()
  const start = saved?.bounds
    ? normalizeBounds(saved.bounds)
    : normalizeBounds({
      x: 0,
      y: 0,
      width: DEFAULT_BOUNDS.width,
      height: DEFAULT_BOUNDS.height
    })

  mainWindow = new BrowserWindow({
    x: start.x,
    y: start.y,
    width: start.width,
    height: start.height,
    title: 'Nexa',
    show: false,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true, // 隐藏默认的 Windows 菜单栏 (File, Edit 等)
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true // 保持开启，使用自定义协议绕过限制
    }
  })

  // 彻底移除默认菜单
  mainWindow.removeMenu()

  // 注册所有 IPC 事件监听 (处理前端发来的系统级请求)
  registerIpcHandlers(mainWindow)

  // 自动更新（仅生产环境可用；事件会推送给渲染进程）
  initUpdater(mainWindow)

  if (saved?.isMaximized) {
    try {
      mainWindow.maximize()
    } catch {
      // ignore
    }
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    // 开发环境：加载 Vite 提供的本地服务
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // mainWindow.webContents.openDevTools()
  } else {
    // 生产环境：加载打包后的 HTML 文件
    // Vite build output is dist/index.html (see vite.config.ts outDir)
    mainWindow.loadFile(join(__dirname, '../index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    mainWindow.show()
  })

  const debouncedSave = makeDebounced(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    void saveWindowState(mainWindow)
  }, 320)

  mainWindow.on('resize', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) return
    if (mainWindow.isMaximized()) return
    debouncedSave()
  })
  mainWindow.on('move', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) return
    if (mainWindow.isMaximized()) return
    debouncedSave()
  })
  mainWindow.on('maximize', () => debouncedSave())
  mainWindow.on('unmaximize', () => debouncedSave())
  mainWindow.on('close', () => {
    if (!mainWindow) return
    void saveWindowState(mainWindow)
  })
}

app.whenReady().then(() => {
  // 注册 nexa:// 协议，用于加载本地资源
  protocol.handle('nexa', async (request) => {
    // nexa://C:/Users/... 
    // 注意：request.url 可能会被浏览器标准化，例如把盘符转小写，并可能带上额外的斜杠
    try {
       // 统一解析 URL：新格式优先用 query（最稳定），旧格式兼容 pathname
       // - 新格式：nexa://local?path=C%3A%5CUsers%5C...%5Cxxx.jpg
       // - 旧格式：nexa:///C:/Users/... 或 nexa://C:/Users/...
       const u = new URL(request.url)

       let filePath: string | null = null

       if (u.hostname === 'local') {
         // searchParams.get() 返回的是“已解码”的字符串
         filePath = u.searchParams.get('path')
       }

       if (!filePath) {
         // 旧格式：尝试从 pathname 里拿到 C:/...（URL 会保证前面有一个 /）
         const p = (u.pathname || '').replace(/^\/+/, '')
         filePath = decodeURIComponent(p)
       }

       if (!filePath) {
         return new Response('Not Found', { status: 404 })
       }

        const st = await stat(filePath)
        if (!st.isFile()) {
          return new Response('Not Found', { status: 404 })
        }

        // 嗅探 mime：只读一小段，避免大视频整文件读入内存
        let mimeType = 'application/octet-stream'
        try {
          const fh = await open(filePath, 'r')
          try {
            const head = Buffer.alloc(Math.min(8192, Math.max(512, st.size || 0)))
            const r = await fh.read(head, 0, head.length, 0)
            const slice = r.bytesRead > 0 ? head.subarray(0, r.bytesRead) : head
            const sniffedImg = sniffImage(slice)
            const sniffedVid = sniffedImg ? null : sniffVideo(slice)
            mimeType = sniffedImg?.mime || sniffedVid?.mime || mimeType
          } finally {
            await fh.close()
          }
        } catch {
          // ignore
        }

        if (mimeType === 'application/octet-stream') {
          const lower = filePath.toLowerCase()
          if (lower.endsWith('.png')) mimeType = 'image/png'
          else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mimeType = 'image/jpeg'
          else if (lower.endsWith('.webp')) mimeType = 'image/webp'
          else if (lower.endsWith('.gif')) mimeType = 'image/gif'
          else if (lower.endsWith('.mp4')) mimeType = 'video/mp4'
          else if (lower.endsWith('.webm')) mimeType = 'video/webm'
          else if (lower.endsWith('.mov')) mimeType = 'video/quicktime'
        }

        const size = st.size
        const range = request.headers.get('range') || request.headers.get('Range')

        // 支持 Range：视频预览/拖动进度条常依赖 206 Partial Content
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
          if (m) {
            const rawStart = m[1]
            const rawEnd = m[2]
            let start = rawStart ? Number(rawStart) : NaN
            let end = rawEnd ? Number(rawEnd) : NaN

            // suffix range: bytes=-500
            if (!rawStart && rawEnd) {
              const suffix = Number(rawEnd)
              if (Number.isFinite(suffix) && suffix > 0) {
                start = Math.max(0, size - suffix)
                end = size - 1
              }
            }

            if (!Number.isFinite(start) || start < 0) start = 0
            if (!Number.isFinite(end) || end <= 0) end = size - 1
            if (end >= size) end = size - 1

            if (start > end || start >= size) {
              return new Response(null, {
                status: 416,
                headers: {
                  'content-range': `bytes */${size}`,
                  'cache-control': 'no-store'
                }
              })
            }

            const nodeStream = createReadStream(filePath, { start, end })
            const webStream = Readable.toWeb(nodeStream as any) as ReadableStream
            const chunkSize = end - start + 1
            return new Response(webStream, {
              status: 206,
              headers: {
                'content-type': mimeType,
                'content-length': String(chunkSize),
                'accept-ranges': 'bytes',
                'content-range': `bytes ${start}-${end}/${size}`,
                'cache-control': 'no-store'
              }
            })
          }
        }

        const nodeStream = createReadStream(filePath)
        const webStream = Readable.toWeb(nodeStream as any) as ReadableStream
        return new Response(webStream, {
          headers: {
            'content-type': mimeType,
            'content-length': String(size),
            'accept-ranges': 'bytes',
            'cache-control': 'no-store'
          }
        })
    } catch (error) {
      console.error('Failed to load local resource:', request.url, error)
      return new Response('Not Found', { status: 404 })
    }
  })

  void createWindow()
})

// Windows 系统下，关闭所有窗口时退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow()
  }
})
