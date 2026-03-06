import React, { Suspense } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { Home, Image, Video, Share2, Settings, LayoutGrid } from 'lucide-react'
import { useSettingsStore } from './features/settings/store'

// 主页面
import HomeView from './features/home/Home'

// 其余模块改为懒加载：缩短冷启动时间
const SettingsView = React.lazy(() => import('./features/settings/Settings'))
const ImageGenView = React.lazy(() => import('./features/image_gen/ImageGen'))
const VideoGenView = React.lazy(() => import('./features/video_gen/VideoGen'))
const CanvasView = React.lazy(() => import('./features/node_canvas/CanvasApp'))
const QuickAppsLayout = React.lazy(() => import('./features/quick_apps/QuickAppsRoute'))
const QuickAppsList = React.lazy(() => import('./features/quick_apps/pages/QuickAppsList'))
const QuickAppRunner = React.lazy(() => import('./features/quick_apps/pages/QuickAppRunner'))
const CreativeLibraryRoute = React.lazy(() => import('./features/creative_library/CreativeLibraryRoute'))
import DialogHost from './features/ui/DialogHost'
import ToastHost from './features/ui/ToastHost'
import UpdateCenter from './features/ui/UpdateCenter'
import FirstRunWizard from './features/ui/FirstRunWizard'
import AppLoading from './features/ui/AppLoading'

function App() {
  const location = useLocation()

  // 应用全局主题：写入到 html[data-theme]
  const theme = useSettingsStore(s => s.theme)
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // 辅助函数：判断当前路由是否激活
  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  return (
    <div className="nexa-app-container">
      
      {/* --- 全新顶部导航栏 --- */}
      <header className="nexa-topbar">
        {/* 左侧 Logo */}
        <div className="brand-logo">NEXA</div>
        
        {/* 中间核心导航 */}
        <nav className="top-nav">
          <Link to="/" className={isActive('/') ? 'active' : ''}>
            <Home size={18} /> 主页
          </Link>
          <Link to="/image" className={isActive('/image') ? 'active' : ''}>
            <Image size={18} /> 图像
          </Link>
          <Link to="/video" className={isActive('/video') ? 'active' : ''}>
            <Video size={18} /> 视频
          </Link>
          <Link to="/canvas" className={isActive('/canvas') ? 'active' : ''}>
            <Share2 size={18} /> 画布
          </Link>
          <Link to="/apps" className={isActive('/apps') ? 'active' : ''}>
            <LayoutGrid size={18} /> 应用
          </Link>
        </nav>
        
        {/* 右侧设置按钮 */}
        <div className="settings-btn-area">
          <Link to="/settings" className={`settings-btn ${isActive('/settings') ? 'active' : ''}`}>
            <Settings size={20} />
          </Link>
        </div>
      </header>

      {/* --- 核心内容区 (路由容器) --- */}
      <main className="nexa-content">
        <Suspense fallback={<AppLoading />}>
          <Routes>
            <Route path="/" element={<HomeView />} />
            <Route path="/image" element={<ImageGenView />} />
            <Route path="/video" element={<VideoGenView />} />
            <Route path="/library" element={<CreativeLibraryRoute />} />
            <Route path="/canvas" element={<CanvasView />} />
            <Route path="/apps" element={<QuickAppsLayout />}>
              <Route index element={<QuickAppsList />} />
              <Route path=":appId" element={<QuickAppRunner />} />
            </Route>
            <Route path="/settings" element={<SettingsView />} />
          </Routes>
        </Suspense>
      </main>

      {/* Themed dialogs/toasts (replace native alert/confirm) */}
      <DialogHost />
      <ToastHost />
      <UpdateCenter />
      <FirstRunWizard />

      {/* --- 底部状态栏 --- */}
      <footer className="nexa-footer">
        就绪
      </footer>

    </div>
  )
}

export default App
