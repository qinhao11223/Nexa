import React, { useState } from 'react'
import ApiSettings from './views/ApiSettings'
import CanvasSettings from './views/CanvasSettings'
import VideoSettings from './views/VideoSettings'
import { useSettingsStore } from './store'
import './styles/settings.css'
import Toggle from './components/Toggle'
import { uiToast } from '../ui/toastStore'

export default function SettingsView() {
  const [activeTab, setActiveTab] = useState<'api' | 'canvas' | 'video' | 'general' | 'about'>('api')
  const { outputDirectory, setOutputDirectory, autoSaveEnabled, setAutoSaveEnabled, theme, setTheme, updateChannel, setUpdateChannel } = useSettingsStore()

  const [appVersion, setAppVersion] = React.useState<string>('')
  const [persistCfg, setPersistCfg] = React.useState<any>(null)

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const api = (window as any).nexaAPI
        if (!api?.getPersistConfig) return
        const r = await api.getPersistConfig()
        if (!alive) return
        if (r?.success) setPersistCfg(r.config)
      } catch {
        // ignore
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const api = (window as any).nexaAPI
        if (!api?.getAppVersion) return
        const r = await api.getAppVersion()
        if (!alive) return
        if (r?.success) setAppVersion(String(r.version || ''))
      } catch {
        // ignore
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="st-layout">
      
      {/* 1. 设置左侧边栏 */}
      <div className="st-sidebar">
        <div className="st-sidebar-header">
          设置
        </div>
        
        <div 
          className={`st-nav-item ${activeTab === 'api' ? 'active' : ''}`}
          onClick={() => setActiveTab('api')}
        >
          API 设置
        </div>

        <div 
          className={`st-nav-item ${activeTab === 'canvas' ? 'active' : ''}`}
          onClick={() => setActiveTab('canvas')}
        >
          画布
        </div>

        <div 
          className={`st-nav-item ${activeTab === 'video' ? 'active' : ''}`}
          onClick={() => setActiveTab('video')}
        >
          视频
        </div>
        <div 
          className={`st-nav-item ${activeTab === 'general' ? 'active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          通用
        </div>
        <div 
          className={`st-nav-item ${activeTab === 'about' ? 'active' : ''}`}
          onClick={() => setActiveTab('about')}
        >
          关于
        </div>
      </div>

      {/* 2. 设置右侧核心内容区 */}
      <div className="st-content">
        {activeTab === 'api' && <ApiSettings />}

        {activeTab === 'canvas' && <CanvasSettings />}

        {activeTab === 'video' && <VideoSettings />}
        
        {activeTab === 'general' && (
          <div className="st-form-container">
            <div className="st-header">
              <h1>通用设置</h1>
              <p>控制软件的全局外观和默认行为</p>
            </div>

            <div className="st-group">
              <label className="st-label">本地数据存储</label>
              <div className="st-inline-row">
                <div className="st-inline-left">
                  <div className="st-inline-title">数据存储位置</div>
                  <div className="st-inline-desc">用于保存设置、创意库、布局等本地数据。默认在“文档/Nexa”。</div>
                </div>
                <button
                  type="button"
                  className="st-refresh-btn"
                  onClick={async () => {
                    try {
                      const api = (window as any).nexaAPI
                      const r = await api?.openDataRoot?.()
                      if (!r?.ok) uiToast('error', '打开失败')
                    } catch {
                      uiToast('error', '打开失败')
                    }
                  }}
                >
                  打开文件夹
                </button>
              </div>

              <div className="st-input-wrapper">
                <input
                  type="text"
                  className="st-input"
                  value={String(persistCfg?.dataRoot || '')}
                  readOnly
                  placeholder="数据存储路径"
                />
              </div>

              <div className="st-inline-row" style={{ marginTop: 10 }}>
                <div className="st-inline-left">
                  <div className="st-inline-title">重新运行首次设置</div>
                  <div className="st-inline-desc">如果你想把数据/默认保存目录迁移到其它盘符，可以重新配置。</div>
                </div>
                <button
                  type="button"
                  className="st-refresh-btn"
                  onClick={async () => {
                    try {
                      const api = (window as any).nexaAPI
                      if (!api?.setPersistConfig) return
                      const r = await api.setPersistConfig({ setupCompleted: false })
                      if (!r?.success) {
                        uiToast('error', r?.error || '操作失败')
                        return
                      }
                      uiToast('success', '已标记为未完成，下次打开会弹出向导')
                      setPersistCfg(r.config)
                    } catch (e: any) {
                      uiToast('error', e?.message || '操作失败')
                    }
                  }}
                >
                  重新设置
                </button>
              </div>
            </div>
            
            <div className="st-group">
              <label className="st-label">图片自动保存路径</label>
              <div className="st-inline-row">
                <div className="st-inline-left">
                  <div className="st-inline-title">自动保存生成图片</div>
                  <div className="st-inline-desc">默认开启；关闭后仅展示远端图片，预览里仍可手动“保存”。</div>
                </div>
                <Toggle
                  checked={autoSaveEnabled}
                  onChange={setAutoSaveEnabled}
                  label="自动保存生成图片"
                />
              </div>
              <div className="st-input-wrapper">
                <input 
                  type="text" 
                  className="st-input" 
                  value={outputDirectory}
                  onChange={(e) => setOutputDirectory(e.target.value)}
                  placeholder="例如: output 或 D:\\Nexa\\output"
                  disabled={!autoSaveEnabled}
                />
              </div>
              <div style={{ fontSize: '0.8rem', color: '#8e94a8', marginTop: '4px' }}>
                生成成功的图片将自动下载并保存到此本地文件夹中。
              </div>
            </div>

            <div className="st-group" style={{ marginTop: 18 }}>
              <label className="st-label">全局主题</label>
              <div className="st-inline-row">
                <div className="st-inline-left">
                  <div className="st-inline-title">主题模式</div>
                  <div className="st-inline-desc">深色更适合长时间使用；浅色更清爽。</div>
                </div>
                <div className="st-seg">
                  <button
                    type="button"
                    className={`st-seg-btn ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    深色
                  </button>
                  <button
                    type="button"
                    className={`st-seg-btn ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    浅色
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'about' && (
          <div className="st-form-container">
            <div className="st-header">
              <h1>关于 Nexa</h1>
              <p>{`v${appVersion || '1.0.0'} - 下一代智能多媒体工作站`}</p>
            </div>

            <div className="st-group" style={{ marginTop: 12 }}>
              <label className="st-label">软件更新</label>
              <div className="st-inline-row">
                <div className="st-inline-left">
                  <div className="st-inline-title">更新通道</div>
                  <div className="st-inline-desc">stable 为正式版；beta 为测试版（更早体验新功能）。</div>
                </div>
                <div className="st-seg">
                  <button
                    type="button"
                    className={`st-seg-btn ${updateChannel === 'stable' ? 'active' : ''}`}
                    onClick={async () => {
                      setUpdateChannel('stable')
                      try {
                        await (window as any).nexaAPI?.updaterSetChannel?.('stable')
                        uiToast('success', '已切换到 stable')
                      } catch {
                        uiToast('error', '切换失败')
                      }
                    }}
                  >
                    stable
                  </button>
                  <button
                    type="button"
                    className={`st-seg-btn ${updateChannel === 'beta' ? 'active' : ''}`}
                    onClick={async () => {
                      setUpdateChannel('beta')
                      try {
                        await (window as any).nexaAPI?.updaterSetChannel?.('beta')
                        uiToast('success', '已切换到 beta')
                      } catch {
                        uiToast('error', '切换失败')
                      }
                    }}
                  >
                    beta
                  </button>
                </div>
              </div>

              <div className="st-inline-row" style={{ marginTop: 10 }}>
                <div className="st-inline-left">
                  <div className="st-inline-title">手动检查更新</div>
                  <div className="st-inline-desc">启动时会自动检查；也可以在这里手动触发一次。</div>
                </div>
                <button
                  type="button"
                  className="st-refresh-btn"
                  onClick={async () => {
                    try {
                      window.dispatchEvent(new Event('nexa-updater-manual-check'))
                      uiToast('info', '正在检查更新…')
                      const api = (window as any).nexaAPI
                      await api?.updaterSetChannel?.(updateChannel)
                      const r = await api?.updaterCheck?.()
                      if (r && r.success === false) {
                        const msg = r.error === 'not packaged'
                          ? '开发环境无法自动更新，请先打包安装版再测试更新。'
                          : (r.error || '检查更新失败')
                        uiToast('error', msg)
                      }
                    } catch (e: any) {
                      uiToast('error', e?.message || '检查更新失败')
                    }
                  }}
                >
                  检查更新
                </button>
              </div>

              <div style={{ fontSize: '0.8rem', color: '#8e94a8', marginTop: 8 }}>
                {`更新源：GitHub Releases（qinhao11223/Nexa）`}
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
