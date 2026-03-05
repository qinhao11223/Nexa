import React from 'react'
import CanvasToolbar from '../components/CanvasToolbar'
import CanvasView from '../components/CanvasView'
import InspectorPanel from '../components/InspectorPanel'
import { score } from '../search/fuzzy'
import { useWorkflowStore } from '../store/workflowStore'
import { useNodeRegistryStore } from '../registry/store'
import QuickAddMenu from '../quick_add/QuickAddMenu'
import { setDraggedNodeId } from '../dnd/dragData'

export default function CanvasWorkbench() {
  const addNodeFromManifest = useWorkflowStore(s => s.addNodeFromManifest)
  const addNodeFromManifestWithParams = useWorkflowStore(s => s.addNodeFromManifestWithParams)
  const deleteSelection = useWorkflowStore(s => s.deleteSelection)
  const selectAll = useWorkflowStore(s => s.selectAll)

  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [paletteQuery, setPaletteQuery] = React.useState('')
  const anchorRef = React.useRef<{ client: { x: number; y: number }; flow: { x: number; y: number } }>({
    client: { x: 0, y: 0 },
    flow: { x: 0, y: 0 }
  })

  const canvasHostRef = React.useRef<HTMLDivElement | null>(null)
  const uploadInputRef = React.useRef<HTMLInputElement | null>(null)
  const getManifest = useNodeRegistryStore(s => s.getManifest)

  const builtins = useNodeRegistryStore(s => s.builtins)
  const customs = useNodeRegistryStore(s => s.customs)
  const refreshRegistry = useNodeRegistryStore(s => s.refresh)
  const manifests = React.useMemo(() => [...builtins, ...customs], [builtins, customs])
  const [libQuery, setLibQuery] = React.useState('')
  const libItems = React.useMemo(() => {
    const q = libQuery.trim()
    return manifests
      .map(m => {
        const hay = [m.display_name, m.node_id, m.category || '', ...(m.tags || []), ...(m.search_aliases || [])].join(' ')
        return { m, s: score(hay, q) }
      })
      .filter(x => (q ? x.s > 0 : true))
      .sort((a, b) => b.s - a.s)
      .map(x => x.m)
  }, [manifests, libQuery])

  React.useEffect(() => {
    void refreshRegistry()
  }, [refreshRegistry])

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as any).isContentEditable)
      if (typing) return

      if (e.key === ' ' && !paletteOpen) {
        e.preventDefault()
        setPaletteOpen(true)
        setPaletteQuery('')
        return
      }

      if ((e.key === 'Backspace' || e.key === 'Delete') && !paletteOpen) {
        e.preventDefault()
        deleteSelection()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        selectAll()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paletteOpen, deleteSelection, selectAll])

  const enqueueAssetNodes = React.useCallback((files: FileList) => {
    const items = Array.from(files || [])
    if (items.length === 0) return

    let dx = 0
    let dy = 0
    for (const f of items) {
      const mime = String((f as any).type || '')
      const name = String((f as any).name || 'file')
      const size = typeof (f as any).size === 'number' ? (f as any).size : 0
      const path = typeof (f as any).path === 'string' ? String((f as any).path) : ''

      const base = {
        file_name: name,
        mime,
        size_bytes: size,
        file_path: path
      }

      const pickNodeId = () => {
        if (mime.startsWith('image/')) return 'nexa.custom.asset.image'
        if (mime.startsWith('video/')) return 'nexa.custom.asset.video'
        if (mime.startsWith('audio/')) return 'nexa.custom.asset.audio'
        return 'nexa.custom.note'
      }

      const nodeId = pickNodeId()
      const m = getManifest(nodeId)
      if (!m) continue

      const pos = { x: anchorRef.current.flow.x + dx, y: anchorRef.current.flow.y + dy }
      if (nodeId === 'nexa.custom.note') {
        addNodeFromManifestWithParams(m, pos, {
          note: `文件: ${name}\nMIME: ${mime || 'unknown'}\n大小: ${size} bytes${path ? `\n路径: ${path}` : ''}`
        })
      } else {
        addNodeFromManifestWithParams(m, pos, base)
      }

      dx += 28
      dy += 18
    }
  }, [addNodeFromManifestWithParams, getManifest])

  return (
    <div className="nexa-canvas-root">
      <CanvasToolbar />

      <div className="nexa-canvas-body">
        <div className="nexa-canvas-panel">
          <div className="panel-header">
            <h3>节点库</h3>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{manifests.length}</div>
          </div>
          <div className="panel-content">
            <input
              className="small-search"
              value={libQuery}
              onChange={(e) => setLibQuery(e.target.value)}
              placeholder="搜索 / 点击添加"
            />
            <div style={{ height: 10 }} />
            <div style={{ display: 'grid', gap: 10 }}>
              {libItems.map(m => (
                <button
                  key={m.node_id}
                  className="node-lib-item"
                  draggable
                  onDragStart={(e) => {
                    try {
                      setDraggedNodeId(e.dataTransfer, m.node_id)
                      e.dataTransfer.effectAllowed = 'copy'
                    } catch {
                      // ignore
                    }
                  }}
                  onClick={() => addNodeFromManifest(m, anchorRef.current.flow)}
                  title={m.description || ''}
                >
                  <div className="name">{m.display_name}</div>
                  <div className="meta">
                    <span>{m.category || '未分类'}</span>
                    <span>{m.version}</span>
                  </div>
                </button>
              ))}
              {libItems.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>无匹配结果</div>}
            </div>
            <div style={{ marginTop: 14, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.4 }}>
              提示：双击画布或按空格打开搜索。
            </div>
          </div>
        </div>

        <div ref={canvasHostRef} style={{ position: 'relative', minHeight: 0 }}>
          <CanvasView
            onRequestPaletteAt={(a) => {
              anchorRef.current = a
              setPaletteOpen(true)
              setPaletteQuery('')
            }}
            onPointerAt={(a) => {
              anchorRef.current = a
            }}
          />
          <QuickAddMenu
            open={paletteOpen}
            anchor={anchorRef.current}
            containerRef={canvasHostRef as any}
            query={paletteQuery}
            setQuery={setPaletteQuery}
            onClose={() => setPaletteOpen(false)}
            onPickNode={(m, keepOpen, anchorFlow) => {
              addNodeFromManifest(m, anchorFlow)
              if (keepOpen) {
                anchorRef.current = {
                  client: anchorRef.current.client,
                  flow: { x: anchorFlow.x + 26, y: anchorFlow.y + 18 }
                }
              } else {
                setPaletteOpen(false)
              }
            }}
            onAction={(actionId, keepOpen, anchorFlow) => {
              if (actionId === 'upload_assets') {
                // update anchor from action trigger so uploads place near cursor
                anchorRef.current = { client: anchorRef.current.client, flow: anchorFlow }
                uploadInputRef.current?.click()
              }
              if (!keepOpen) setPaletteOpen(false)
            }}
          />

          <input
            ref={uploadInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = e.currentTarget.files
              if (files) enqueueAssetNodes(files)
              e.currentTarget.value = ''
            }}
          />
        </div>

        <InspectorPanel />
      </div>
    </div>
  )
}
