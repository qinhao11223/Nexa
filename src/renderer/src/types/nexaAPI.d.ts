// 渲染进程可用的 Electron 预加载 API 类型声明
// 说明：这里仅做类型提示；真实实现位于 src/preload/index.ts 与 src/main/ipc/index.ts

export {}

declare global {
  interface Window {
    nexaAPI?: {
      getSystemInfo: () => Promise<{ platform: string, arch: string }>
      getAppVersion: () => Promise<{ success: boolean, version: string, name: string }>
      minimizeWindow: () => void

      // 下载图片到本地（由主进程完成文件写入）
      downloadImage: (args: { url: string, saveDir: string, fileName: string }) => Promise<{ success: boolean, localPath?: string, error?: string }>

      // 下载视频到本地
      downloadVideo: (args: { url: string, saveDir: string, fileName: string }) => Promise<{ success: boolean, localPath?: string, error?: string }>

      // 在资源管理器中定位文件
      showItemInFolder: (args: { filePath: string }) => Promise<{ success: boolean }>

      // 选择目录（用于导出）
      selectDirectory: () => Promise<{ success: boolean, dirPath?: string | null, error?: string }>

      // 导出多张图片到目录（支持本地复制/远端下载）
      exportImagesToDir: (args: { items: { url: string, fileName: string }[], saveDir: string }) => Promise<{ success: boolean, saved?: string[], failed?: { fileName: string, error: string }[], error?: string }>

      // 导出多段视频到目录
      exportVideosToDir: (args: { items: { url: string, fileName: string }[], saveDir: string }) => Promise<{ success: boolean, saved?: string[], failed?: { fileName: string, error: string }[], error?: string }>

      // 将图片复制到系统剪贴板（由主进程完成，可靠性更高）
      copyImageToClipboard: (args: { url: string }) => Promise<{ success: boolean, error?: string }>

      // 节点库：扫描 custom_nodes
      listCustomNodes: () => Promise<{ success: boolean, root: string, nodes: Array<{ manifest: any, manifestPath: string }>, warning?: string }>

      // 打开 custom_nodes 文件夹
      openCustomNodesFolder: () => Promise<{ success: boolean, root: string, error?: string }>

      callPython: (args: any) => Promise<any>
      onMessage: (channel: string, callback: (...args: any[]) => void) => void

      // Auto updater
      updaterSetChannel: (channel: 'stable' | 'beta') => Promise<{ success: boolean, channel?: 'stable' | 'beta' }>
      updaterCheck: () => Promise<{ success: boolean, error?: string }>
      updaterDownload: () => Promise<{ success: boolean, error?: string }>
      updaterQuitAndInstall: () => Promise<{ success: boolean, error?: string }>
      updaterOpenReleases: () => Promise<{ ok: boolean, url?: string }>
      onUpdaterEvent: (callback: (evt: any) => void) => void
    }
  }
}
