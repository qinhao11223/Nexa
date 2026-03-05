import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// 桌面软件通常使用 HashRouter 以防止本地文件路径解析错误
const Root = (
  <HashRouter>
    <App />
  </HashRouter>
)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  import.meta.env.DEV ? <React.StrictMode>{Root}</React.StrictMode> : Root
)
