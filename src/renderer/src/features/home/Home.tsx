import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Image, Video, Share2, LayoutGrid } from 'lucide-react'

// --- 模块主页面 ---
// 主页提供整个系统的入口卡片
export default function HomeView() {
  const navigate = useNavigate() // 用于页面跳转

  return (
    <div className="home-container">
      {/* 标题区域 */}
      <div className="home-header">
        <h1 className="home-title">
          <span className="text-white">NEXA</span> <span className="text-cyan">SYSTEM</span>
        </h1>
        <p className="home-subtitle">下一代智能多媒体工作站</p>
      </div>

      {/* 核心功能入口卡片组 */}
      <div className="cards-wrapper">
        
        {/* 卡片1: 图像处理 */}
        <div className="feature-card card-cyan" onClick={() => navigate('/image')}>
          <div className="card-icon-wrapper">
            <Image size={40} className="card-icon" />
          </div>
          <h2>图像处理</h2>
          <p>AI 图像增强与分析</p>
        </div>

        {/* 卡片2: 视频编辑 (根据图示高亮显示红色边框) */}
        <div className="feature-card card-pink active-card" onClick={() => navigate('/video')}>
          <div className="card-icon-wrapper">
            <Video size={40} className="card-icon" />
          </div>
          <h2>视频编辑</h2>
          <p>智能视频剪辑与特效</p>
        </div>

        {/* 卡片3: 节点画布 */}
        <div className="feature-card card-green" onClick={() => navigate('/canvas')}>
          <div className="card-icon-wrapper">
            <Share2 size={40} className="card-icon" />
          </div>
          <h2>节点画布</h2>
          <p>可视化工作流编排</p>
        </div>

        {/* 卡片4: 快捷应用 */}
        <div className="feature-card card-cyan" onClick={() => navigate('/apps')}>
          <div className="card-icon-wrapper">
            <LayoutGrid size={40} className="card-icon" />
          </div>
          <h2>快捷应用</h2>
          <p>一键工作流与小工具</p>
        </div>

      </div>
    </div>
  )
}
