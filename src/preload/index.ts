import { contextBridge, ipcRenderer } from 'electron'

// 暴露安全的系统级别 API 给前端 (渲染进程)，而不是直接给 nodeIntegration = true，防止安全风险
const api = {
  // 获取系统信息
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // 应用版本信息
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // 本地持久化（文件存储）
  getPersistConfig: () => ipcRenderer.invoke('persist:get-config'),
  setPersistConfig: (patch: any) => ipcRenderer.invoke('persist:set-config', patch),
  openDataRoot: () => ipcRenderer.invoke('persist:open-data-root'),
  persistGetItem: (key: string) => ipcRenderer.invoke('persist:kv-get', key),
  persistSetItem: (key: string, value: string) => ipcRenderer.invoke('persist:kv-set', key, value),
  persistRemoveItem: (key: string) => ipcRenderer.invoke('persist:kv-remove', key),

  // input image cache
  inputImageCacheStats: () => ipcRenderer.invoke('cache:input-images:stats'),
  clearInputImageCache: () => ipcRenderer.invoke('cache:input-images:clear'),
  removeInputImageCacheFile: (args: { localPath?: string, filePath?: string }) => ipcRenderer.invoke('cache:input-images:remove-file', args),

  // 窗口控制
  minimizeWindow: () => ipcRenderer.send('window-minimize'),

  // 下载图片
  downloadImage: (args: { url: string, saveDir: string, fileName: string }) => 
    ipcRenderer.invoke('download-and-save-image', args),

  // 下载视频
  downloadVideo: (args: { url: string, saveDir: string, fileName: string }) =>
    ipcRenderer.invoke('download-and-save-video', args),

  // 在资源管理器中定位文件
  showItemInFolder: (args: { filePath: string }) =>
    ipcRenderer.invoke('show-item-in-folder', args),

  // 选择目录
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // 导出多张图片到指定目录
  exportImagesToDir: (args: { items: { url: string, fileName: string }[], saveDir: string }) =>
    ipcRenderer.invoke('export-images-to-dir', args),

  // 导出多段视频到指定目录
  exportVideosToDir: (args: { items: { url: string, fileName: string }[], saveDir: string }) =>
    ipcRenderer.invoke('export-videos-to-dir', args),

  // 复制图片到剪贴板
  copyImageToClipboard: (args: { url: string }) =>
    ipcRenderer.invoke('copy-image-to-clipboard', args),

  // Python 引擎通信预留
  callPython: (args: any) => ipcRenderer.invoke('call-python-engine', args),

  // 节点库：扫描 custom_nodes
  listCustomNodes: () => ipcRenderer.invoke('list-custom-nodes'),

  // 打开 custom_nodes 文件夹
  openCustomNodesFolder: () => ipcRenderer.invoke('open-custom-nodes-folder'),

  // 提供通用的事件监听机制（例如后端主动推送消息）
  onMessage: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args))
  },

  // --- Auto updater ---
  updaterSetChannel: (channel: 'stable' | 'beta') => ipcRenderer.invoke('updater:set-channel', channel),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterQuitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  updaterOpenReleases: () => ipcRenderer.invoke('updater:open-releases'),
  onUpdaterEvent: (callback: (evt: any) => void) => {
    ipcRenderer.on('nexa-updater-event', (_event, evt) => callback(evt))
  }
}

// 通过 window.nexaAPI 在前端挂载这些功能
contextBridge.exposeInMainWorld('nexaAPI', api)

// 为了 TypeScript 类型提示，我们可以在前端额外声明这个 interface
