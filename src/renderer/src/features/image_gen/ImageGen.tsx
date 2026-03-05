import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import TextToImage from './views/TextToImage'
import ImageToImage from './views/ImageToImage'
import LibraryView from './views/Library'
import './styles/index.css'

export type ImageGenMode = 't2i' | 'i2i' | 'library'

export default function ImageGenView() {
  const location = useLocation()
  // 控制当前显示的模式: 't2i' = 文字生图, 'i2i' = 图像改图, 'library' = 创意库
  const [activeMode, setActiveMode] = useState<ImageGenMode>('t2i')

  // 支持通过路由参数打开指定子模式：/image?mode=i2i
  useEffect(() => {
    try {
      const sp = new URLSearchParams(location.search || '')
      const m = sp.get('mode')
      if (m === 't2i' || m === 'i2i') setActiveMode(m)
    } catch {
      // ignore
    }
  }, [location.search])

  // 渲染函数：通过条件渲染实现无缝切换，同时保持三个文件的代码绝对物理隔离
  return (
    <div className="feature-container" style={{ margin: 0, padding: 0 }}>
      {activeMode === 't2i' && <TextToImage onSwitchMode={setActiveMode} />}
      {activeMode === 'i2i' && <ImageToImage onSwitchMode={setActiveMode} />}
      {activeMode === 'library' && <LibraryView onSwitchMode={setActiveMode} />}
    </div>
  )
}
