import { ipcMain, BrowserWindow, shell, clipboard, nativeImage, dialog, app } from 'electron'
import { join, isAbsolute, resolve } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { copyFile } from 'fs/promises'
import { readFile } from 'fs/promises'
import { readdir, stat } from 'fs/promises'
import { sniffImage } from '../utils/sniffImage'
import { sniffVideo } from '../utils/sniffVideo'
import { checkForUpdates, downloadUpdate, openReleasesPage, quitAndInstall, setUpdateChannel, type UpdateChannel } from '../updater'

// 注册所有主进程与渲染进程的通信事件
export function registerIpcHandlers(window: BrowserWindow) {
  
  // 示例：前端想知道当前系统环境
  ipcMain.handle('get-system-info', () => {
    return { platform: process.platform, arch: process.arch }
  })

  ipcMain.handle('get-app-version', () => {
    return { success: true, version: app.getVersion(), name: app.getName() }
  })

  // --- Auto updater ---
  ipcMain.handle('updater:set-channel', async (_event, ch: UpdateChannel) => {
    const c: UpdateChannel = (ch === 'beta') ? 'beta' : 'stable'
    setUpdateChannel(c)
    return { success: true, channel: c }
  })

  ipcMain.handle('updater:check', async () => {
    const r = await checkForUpdates()
    return { success: r.ok, error: (r as any).error }
  })

  ipcMain.handle('updater:download', async () => {
    const r = await downloadUpdate()
    return { success: r.ok, error: (r as any).error }
  })

  ipcMain.handle('updater:quit-and-install', async () => {
    const r = quitAndInstall()
    return { success: r.ok, error: (r as any).error }
  })

  ipcMain.handle('updater:open-releases', async () => {
    return openReleasesPage()
  })

  // 下载远端图片并保存到本地
  ipcMain.handle('download-and-save-image', async (event, { url, saveDir, fileName }) => {
    try {
      // 兼容相对路径：例如 settings 默认值为 "output"
      const resolvedSaveDir = isAbsolute(saveDir) ? saveDir : resolve(saveDir)

      // 确保保存目录存在
      if (!existsSync(resolvedSaveDir)) {
        await mkdir(resolvedSaveDir, { recursive: true })
      }

      // 获取图片数据（支持 http(s) 与 data:image/...）
      let contentType = ''
      let buffer: Buffer

      if (typeof url === 'string' && url.startsWith('data:')) {
        // data URL: data:image/png;base64,....
        const m = /^data:([^;]+);base64,(.+)$/i.exec(url)
        if (!m) throw new Error('Invalid data url')
        contentType = String(m[1] || '').toLowerCase()
        buffer = Buffer.from(m[2], 'base64')
      } else {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`)
        // 注意：有些中转/CDN 会返回 application/octet-stream，但内容仍然是图片
        // 所以这里用“文件头嗅探”作为第一判断依据，避免误判导致保存失败
        contentType = (response.headers.get('content-type') || '').toLowerCase()
        const arrayBuffer = await response.arrayBuffer()
        buffer = Buffer.from(arrayBuffer)
      }

      const sniffed = sniffImage(buffer)
      const looksLikeImage = Boolean(sniffed) || contentType.startsWith('image/')
      if (!looksLikeImage) {
        // 不是图片：很可能是 HTML/JSON 错误页（例如鉴权失败/额度不足/跳转登录页）
        const preview = buffer.toString('utf8', 0, Math.min(buffer.length, 220))
        throw new Error(`Invalid image response: content-type=${contentType || 'unknown'}; body=${preview}`)
      }

      // 扩展名优先用嗅探结果（比 header 更可靠）
      const ext = sniffed?.ext
        || (contentType.includes('png')
          ? '.png'
          : (contentType.includes('jpeg') || contentType.includes('jpg'))
            ? '.jpg'
            : contentType.includes('webp')
              ? '.webp'
              : contentType.includes('gif')
                ? '.gif'
                : '.img')

      // 写入本地（如果传入的 fileName 自带扩展名，自动替换成正确 ext）
      const baseName = String(fileName || 'nexa_image').replace(/\.[^/.]+$/, '')
      const finalName = `${baseName}${ext}`
      const filePath = join(resolvedSaveDir, finalName)
      await writeFile(filePath, buffer)

      // 返回本地的绝对路径：使用 query 携带真实 Windows 路径，避免盘符/斜杠在 URL 标准化时被破坏
      // 例如：nexa://local?path=C%3A%5CUsers%5C...%5Cxxx.jpg
      return { success: true, localPath: `nexa://local?path=${encodeURIComponent(filePath)}` }
    } catch (error: any) {
      console.error('Download image error:', error)
      return { success: false, error: error.message }
    }
  })

  // 下载远端视频并保存到本地
  ipcMain.handle('download-and-save-video', async (event, { url, saveDir, fileName }) => {
    try {
      const resolvedSaveDir = isAbsolute(saveDir) ? saveDir : resolve(saveDir)
      if (!existsSync(resolvedSaveDir)) {
        await mkdir(resolvedSaveDir, { recursive: true })
      }

      if (!url || typeof url !== 'string') throw new Error('invalid url')

      const response = await fetch(url)
      if (!response.ok) throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`)
      const contentType = (response.headers.get('content-type') || '').toLowerCase()
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      const sniffed = sniffVideo(buffer)
      const looksLikeVideo = Boolean(sniffed) || contentType.startsWith('video/')
      if (!looksLikeVideo) {
        const preview = buffer.toString('utf8', 0, Math.min(buffer.length, 220))
        throw new Error(`Invalid video response: content-type=${contentType || 'unknown'}; body=${preview}`)
      }

      const ext = sniffed?.ext
        || (contentType.includes('webm')
          ? '.webm'
          : (contentType.includes('quicktime') || contentType.includes('mov'))
            ? '.mov'
            : '.mp4')

      const baseName = String(fileName || 'nexa_video').replace(/\.[^/.]+$/, '')
      const finalName = `${baseName}${ext}`
      const filePath = join(resolvedSaveDir, finalName)
      await writeFile(filePath, buffer)

      return { success: true, localPath: `nexa://local?path=${encodeURIComponent(filePath)}` }
    } catch (error: any) {
      console.error('Download video error:', error)
      return { success: false, error: error.message }
    }
  })

  // 导出多段视频到指定目录（远端下载/本地复制）
  ipcMain.handle('export-videos-to-dir', async (event, args: { items: { url: string, fileName: string }[], saveDir: string }) => {
    const { items, saveDir } = args || ({} as any)
    if (!Array.isArray(items) || !saveDir) {
      return { success: false, error: 'invalid args' }
    }

    try {
      const resolvedSaveDir = isAbsolute(saveDir) ? saveDir : resolve(saveDir)
      if (!existsSync(resolvedSaveDir)) {
        await mkdir(resolvedSaveDir, { recursive: true })
      }

      const saved: string[] = []
      const failed: { fileName: string, error: string }[] = []

      for (const it of items) {
        try {
          const url = String(it.url || '')
          const baseName = String(it.fileName || 'nexa_export').replace(/\.[^/.]+$/, '')

          // 本地 nexa://local?path=...
          if (url.startsWith('nexa://')) {
            const u = new URL(url)
            if (u.hostname === 'local') {
              const srcPath = u.searchParams.get('path')
              if (!srcPath) throw new Error('missing local path')
              const buf = await readFile(srcPath)
              const sniffed = sniffVideo(buf)
              const ext = sniffed?.ext || '.mp4'
              const dest = join(resolvedSaveDir, `${baseName}${ext}`)
              await copyFile(srcPath, dest)
              saved.push(dest)
              continue
            }
          }

          if (!/^https?:\/\//i.test(url)) {
            throw new Error('unsupported url')
          }

          const response = await fetch(url)
          if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`)
          const contentType = (response.headers.get('content-type') || '').toLowerCase()
          const arrayBuffer = await response.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          const sniffed = sniffVideo(buffer)
          const looksLikeVideo = Boolean(sniffed) || contentType.startsWith('video/')
          if (!looksLikeVideo) {
            const preview = buffer.toString('utf8', 0, Math.min(buffer.length, 220))
            throw new Error(`invalid video response: content-type=${contentType || 'unknown'}; body=${preview}`)
          }

          const ext = sniffed?.ext
            || (contentType.includes('webm')
              ? '.webm'
              : (contentType.includes('quicktime') || contentType.includes('mov'))
                ? '.mov'
                : '.mp4')

          const dest = join(resolvedSaveDir, `${baseName}${ext}`)
          await writeFile(dest, buffer)
          saved.push(dest)
        } catch (e: any) {
          failed.push({ fileName: String(it.fileName || 'nexa_export'), error: e?.message || 'export failed' })
        }
      }

      return { success: true, saved, failed }
    } catch (e: any) {
      return { success: false, error: e?.message || 'export failed' }
    }
  })

  // 在资源管理器中定位文件
  ipcMain.handle('show-item-in-folder', async (event, { filePath }) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { success: false }
      }
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (e) {
      return { success: false }
    }
  })

  // 选择目录：用于“导出/保存到本地”让用户自己选位置
  ipcMain.handle('select-directory', async () => {
    try {
      const r = await dialog.showOpenDialog(window, {
        title: '选择保存位置',
        properties: ['openDirectory', 'createDirectory']
      })
      if (r.canceled) return { success: true, dirPath: null }
      const p = r.filePaths && r.filePaths[0]
      return { success: true, dirPath: p || null }
    } catch (e: any) {
      return { success: false, error: e?.message || 'select directory failed' }
    }
  })

  // 导出多张图片到指定目录：支持远端下载 + 本地文件复制
  ipcMain.handle('export-images-to-dir', async (event, args: { items: { url: string, fileName: string }[], saveDir: string }) => {
    const { items, saveDir } = args || ({} as any)
    if (!Array.isArray(items) || !saveDir) {
      return { success: false, error: 'invalid args' }
    }

    try {
      const resolvedSaveDir = isAbsolute(saveDir) ? saveDir : resolve(saveDir)
      if (!existsSync(resolvedSaveDir)) {
        await mkdir(resolvedSaveDir, { recursive: true })
      }

      const saved: string[] = []
      const failed: { fileName: string, error: string }[] = []

      for (const it of items) {
        try {
          const url = String(it.url || '')
          const baseName = String(it.fileName || 'nexa_export').replace(/\.[^/.]+$/, '')

          // data url
          if (url.startsWith('data:')) {
            const m = /^data:([^;]+);base64,(.+)$/i.exec(url)
            if (!m) throw new Error('Invalid data url')
            const contentType = String(m[1] || '').toLowerCase()
            const buffer = Buffer.from(m[2], 'base64')
            const sniffed = sniffImage(buffer)
            const ext = sniffed?.ext
              || (contentType.includes('png')
                ? '.png'
                : (contentType.includes('jpeg') || contentType.includes('jpg'))
                  ? '.jpg'
                  : contentType.includes('webp')
                    ? '.webp'
                    : contentType.includes('gif')
                      ? '.gif'
                      : '.img')
            const dest = join(resolvedSaveDir, `${baseName}${ext}`)
            await writeFile(dest, buffer)
            saved.push(dest)
            continue
          }

          // 本地 nexa://local?path=...
          if (url.startsWith('nexa://')) {
            const u = new URL(url)
            if (u.hostname === 'local') {
              const srcPath = u.searchParams.get('path')
              if (!srcPath) throw new Error('missing local path')

              const buf = await readFile(srcPath)
              const sniffed = sniffImage(buf)
              const ext = sniffed?.ext || '.img'
              const dest = join(resolvedSaveDir, `${baseName}${ext}`)
              await copyFile(srcPath, dest)
              saved.push(dest)
              continue
            }
          }

          // 远端：http(s)
          if (!/^https?:\/\//i.test(url)) {
            throw new Error('unsupported url')
          }

          const response = await fetch(url)
          if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`)
          const contentType = (response.headers.get('content-type') || '').toLowerCase()
          const arrayBuffer = await response.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          const sniffed = sniffImage(buffer)
          const looksLikeImage = Boolean(sniffed) || contentType.startsWith('image/')
          if (!looksLikeImage) {
            const preview = buffer.toString('utf8', 0, Math.min(buffer.length, 220))
            throw new Error(`invalid image response: content-type=${contentType || 'unknown'}; body=${preview}`)
          }

          const ext = sniffed?.ext
            || (contentType.includes('png')
              ? '.png'
              : (contentType.includes('jpeg') || contentType.includes('jpg'))
                ? '.jpg'
                : contentType.includes('webp')
                  ? '.webp'
                  : contentType.includes('gif')
                    ? '.gif'
                    : '.img')

          const dest = join(resolvedSaveDir, `${baseName}${ext}`)
          await writeFile(dest, buffer)
          saved.push(dest)
        } catch (e: any) {
          failed.push({ fileName: String(it.fileName || 'nexa_export'), error: e?.message || 'export failed' })
        }
      }

      return { success: true, saved, failed }
    } catch (e: any) {
      return { success: false, error: e?.message || 'export failed' }
    }
  })

  // 复制图片到系统剪贴板
  ipcMain.handle('copy-image-to-clipboard', async (event, { url }) => {
    try {
      if (!url || typeof url !== 'string') {
        return { success: false, error: 'invalid url' }
      }

      // 统一获取图片 buffer
      let buffer: Buffer | null = null

      // 本地：nexa://local?path=...
      if (url.startsWith('nexa://')) {
        try {
          const u = new URL(url)
          if (u.hostname === 'local') {
            const p = u.searchParams.get('path')
            if (p) {
              buffer = await readFile(p)
            }
          }
        } catch {
          // 忽略，走后续 fallback
        }
      }

      // data url
      if (!buffer && typeof url === 'string' && url.startsWith('data:')) {
        const m = /^data:([^;]+);base64,(.+)$/i.exec(url)
        if (m) {
          buffer = Buffer.from(m[2], 'base64')
        }
      }

      // 远端：http(s)
      if (!buffer && /^https?:\/\//i.test(url)) {
        const resp = await fetch(url)
        if (!resp.ok) {
          return { success: false, error: `fetch failed: ${resp.status}` }
        }
        const ab = await resp.arrayBuffer()
        buffer = Buffer.from(ab)
      }

      if (!buffer) {
        return { success: false, error: 'unsupported url' }
      }

      const img = nativeImage.createFromBuffer(buffer)
      if (img.isEmpty()) {
        return { success: false, error: 'invalid image buffer' }
      }

      clipboard.writeImage(img)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e?.message || 'copy failed' }
    }
  })

  // 示例：窗口最小化
  ipcMain.on('window-minimize', () => {
    if (window.isMinimizable()) {
      window.minimize()
    }
  })

  // 示例：调用本地 Python 引擎 (预留给后期 AI 算法)
  ipcMain.handle('call-python-engine', async (event, args) => {
    // 后面可以在这里启动 python 进程处理复杂算法，目前直接返回模拟数据
    console.log('接收到前端调用 Python 的请求：', args)
    return { success: true, message: 'Python Engine connected' }
  })

  // 节点库：扫描 custom_nodes 目录下的 node.json
  ipcMain.handle('list-custom-nodes', async () => {
    const root = resolve('custom_nodes')

    try {
      if (!existsSync(root)) {
        await mkdir(root, { recursive: true })
      }
    } catch (e: any) {
      // 目录不可写时直接返回空
      return { success: true, root, nodes: [], warning: e?.message || 'cannot create custom_nodes' }
    }

    type Listed = { manifest: any; manifestPath: string }
    const out: Listed[] = []

    const maxDepth = 8
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur.depth > maxDepth) continue
      let entries: string[] = []
      try {
        entries = await readdir(cur.dir)
      } catch {
        continue
      }

      for (const name of entries) {
        const full = join(cur.dir, name)
        let st: any
        try {
          st = await stat(full)
        } catch {
          continue
        }

        if (st.isDirectory()) {
          // skip hidden-ish folders
          if (name.startsWith('.')) continue
          stack.push({ dir: full, depth: cur.depth + 1 })
          continue
        }

        if (!st.isFile()) continue
        if (name.toLowerCase() !== 'node.json') continue

        try {
          const text = await readFile(full, 'utf8')
          const parsed = JSON.parse(text)
          out.push({ manifest: parsed, manifestPath: full })
        } catch {
          // ignore bad json
        }
      }
    }

    return { success: true, root, nodes: out }
  })

  // 打开 custom_nodes 文件夹（供用户整理节点）
  ipcMain.handle('open-custom-nodes-folder', async () => {
    const root = resolve('custom_nodes')
    try {
      if (!existsSync(root)) {
        await mkdir(root, { recursive: true })
      }
      await shell.openPath(root)
      return { success: true, root }
    } catch (e: any) {
      return { success: false, error: e?.message || 'open folder failed', root }
    }
  })

}
