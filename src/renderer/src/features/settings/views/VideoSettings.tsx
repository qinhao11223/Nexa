import React from 'react'
import { useSettingsStore } from '../store'
import Toggle from '../components/Toggle'

export default function VideoSettings() {
  const {
    videoAutoSaveEnabled,
    setVideoAutoSaveEnabled,
    videoOutputDirectory,
    setVideoOutputDirectory
  } = useSettingsStore()

  const [msg, setMsg] = React.useState<string>('')

  const pickDir = async () => {
    try {
      if (!window.nexaAPI?.selectDirectory) {
        setMsg('当前环境不支持选择目录')
        return
      }
      const r = await window.nexaAPI.selectDirectory()
      if (!r.success) {
        setMsg(r.error || '选择目录失败')
        return
      }
      if (!r.dirPath) {
        setMsg('已取消')
        return
      }
      setVideoOutputDirectory(r.dirPath)
      setMsg('已更新目录')
    } catch (e: any) {
      setMsg(e?.message || '选择目录失败')
    }
  }

  return (
    <div className="st-form-container">
      <div className="st-header">
        <h1>视频设置</h1>
        <p>视频生成完成后自动导出到本地，优先用本地文件预览与保存</p>
      </div>

      <div className="st-group">
        <label className="st-label">视频自动导出</label>
        <div className="st-inline-row">
          <div className="st-inline-left">
            <div className="st-inline-title">自动保存生成视频</div>
            <div className="st-inline-desc">解决部分中转站远端视频无法预览/无法保存的问题；导出后自动切到本地播放。</div>
          </div>
          <Toggle
            checked={videoAutoSaveEnabled}
            onChange={setVideoAutoSaveEnabled}
            label="自动保存生成视频"
          />
        </div>

        <div className="st-inline-row" style={{ marginTop: 10 }}>
          <div className="st-inline-left">
            <div className="st-inline-title">自动导出目录</div>
            <div className="st-inline-desc">支持相对路径（例如 output/videos）或绝对路径（例如 D:\\Nexa\\videos）。</div>
          </div>
          <button type="button" className="st-refresh-btn" onClick={pickDir} disabled={!videoAutoSaveEnabled}>
            选择目录
          </button>
        </div>

        <div className="st-input-wrapper">
          <input
            type="text"
            className="st-input"
            value={videoOutputDirectory}
            onChange={(e) => setVideoOutputDirectory(e.target.value)}
            placeholder="例如: output/videos 或 D:\\Nexa\\videos"
            disabled={!videoAutoSaveEnabled}
          />
        </div>

        {msg ? (
          <div style={{ fontSize: '0.8rem', color: '#8e94a8', marginTop: '6px' }}>
            {msg}
          </div>
        ) : (
          <div style={{ fontSize: '0.8rem', color: '#8e94a8', marginTop: '6px' }}>
            生成成功的视频将自动下载并保存到此本地文件夹中。
          </div>
        )}
      </div>
    </div>
  )
}
