import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import TextToVideo from './views/TextToVideo'
import ImageToVideo from './views/ImageToVideo'
import './styles/index.css'
import '../image_gen/styles/index.css'

export type VideoGenMode = 't2v' | 'i2v'

export default function VideoGenView() {
  const location = useLocation()
  const [mode, setMode] = useState<VideoGenMode>('t2v')

  // 支持通过路由参数打开指定子模式：/video?mode=i2v
  useEffect(() => {
    try {
      const sp = new URLSearchParams(location.search || '')
      const m = sp.get('mode')
      if (m === 't2v' || m === 'i2v') setMode(m)
    } catch {
      // ignore
    }
  }, [location.search])

  return (
    <div className="vg-root">
      {mode === 't2v' && <TextToVideo onSwitchMode={setMode} />}
      {mode === 'i2v' && <ImageToVideo onSwitchMode={setMode} />}
    </div>
  )
}
