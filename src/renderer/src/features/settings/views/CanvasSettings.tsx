import React from 'react'

export default function CanvasSettings() {
  const [root, setRoot] = React.useState<string>('')
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const api = (window as any).nexaAPI
        if (!api?.listCustomNodes) {
          if (!alive) return
          setErr('当前环境不支持读取 custom_nodes（nexaAPI 缺失）')
          return
        }
        const r = await api.listCustomNodes()
        if (!alive) return
        if (r?.success) {
          setRoot(String(r.root || ''))
          if (r.warning) setErr(String(r.warning))
        } else {
          setErr('读取 custom_nodes 失败')
        }
      } catch (e: any) {
        if (!alive) return
        setErr(e?.message || '读取失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const openFolder = async () => {
    try {
      const api = (window as any).nexaAPI
      if (!api?.openCustomNodesFolder) {
        setErr('当前环境不支持打开文件夹（nexaAPI 缺失）')
        return
      }
      const r = await api.openCustomNodesFolder()
      if (!r?.success) setErr(r?.error || '打开失败')
      if (r?.root) setRoot(String(r.root))
    } catch (e: any) {
      setErr(e?.message || '打开失败')
    }
  }

  return (
    <div className="st-form-container">
      <div className="st-header">
        <h1>画布设置</h1>
        <p>节点库、工作流与运行相关的设置会逐步沉淀在这里</p>
      </div>

      <div className="st-group">
        <label className="st-label">自定义节点库</label>
        <div className="st-inline-row">
          <div className="st-inline-left">
            <div className="st-inline-title">custom_nodes 文件夹</div>
            <div className="st-inline-desc">把你的节点放到这个文件夹（递归扫描 node.json），画布节点库会自动出现。</div>
          </div>
          <button type="button" className="st-refresh-btn" onClick={openFolder}>
            在资源管理器中打开
          </button>
        </div>
        <div className="st-input-wrapper">
          <input className="st-input" value={root} readOnly placeholder="custom_nodes 路径" />
        </div>
        {err && (
          <div style={{ fontSize: '0.8rem', color: '#8e94a8' }}>
            {err}
          </div>
        )}
      </div>
    </div>
  )
}
