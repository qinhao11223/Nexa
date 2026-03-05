import { app, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { open, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { sniffImage } from './utils/sniffImage'
import { sniffVideo } from './utils/sniffVideo'
import { initUpdater } from './updater'

// 注册自定义协议的权限（需要在 app ready 之前）
protocol.registerSchemesAsPrivileged([
  { scheme: 'nexa', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
])

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Nexa',
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

  if (process.env.VITE_DEV_SERVER_URL) {
    // 开发环境：加载 Vite 提供的本地服务
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // mainWindow.webContents.openDevTools()
  } else {
    // 生产环境：加载打包后的 HTML 文件
    // Vite build output is dist/index.html (see vite.config.ts outDir)
    mainWindow.loadFile(join(__dirname, '../index.html'))
  }
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

  createWindow()
})

// Windows 系统下，关闭所有窗口时退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
