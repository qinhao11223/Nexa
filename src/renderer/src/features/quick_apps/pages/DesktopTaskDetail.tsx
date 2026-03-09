import React, { useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, Copy, X } from 'lucide-react'
import { useProductShotTaskStore } from '../product_shot_tasks/store'
import { uiTextViewer } from '../../ui/dialogStore'
import { useSettingsStore } from '../../settings/store'
import { formatRequestDebugForCopy } from '../../image_gen/utils/requestDebug'
import '../styles/quickApps.css'

function copyText(text: string) {
  const t = String(text || '').trim()
  if (!t) return
  if (!navigator.clipboard?.writeText) {
    void uiTextViewer(t, { title: '复制内容', size: 'lg' })
    return
  }
  void navigator.clipboard.writeText(t)
}

function safeFileName(s: string) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 120) || 'image'
}

function tryGetLocalFilePathFromUrl(url: string): string | null {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'nexa:') return null
    if (u.hostname === 'local') return u.searchParams.get('path')
    const p = (u.pathname || '').replace(/^\/+/, '')
    return p ? decodeURIComponent(p) : null
  } catch {
    return null
  }
}

function pickFileNameFromUrl(url: string) {
  const local = tryGetLocalFilePathFromUrl(url)
  if (local) {
    const s = String(local || '').replace(/\\/g, '/')
    const idx = s.lastIndexOf('/')
    return idx >= 0 ? s.slice(idx + 1) : s
  }
  try {
    const u = new URL(String(url || ''))
    const s = String(u.pathname || '').replace(/\\/g, '/')
    const idx = s.lastIndexOf('/')
    return idx >= 0 ? s.slice(idx + 1) : (s || 'image')
  } catch {
    return 'image'
  }
}

function stringifySafe(v: any) {
  try {
    return JSON.stringify(v ?? null, null, 2)
  } catch {
    return String(v)
  }
}

export default function DesktopTaskDetail() {
  const { taskId } = useParams()
  const loc = useLocation()
  const tasks = useProductShotTaskStore(s => s.tasks)
  const outputDirectory = useSettingsStore(s => s.outputDirectory)
  const task = useMemo(() => (tasks || []).find(t => t.id === String(taskId || '')) || null, [tasks, taskId])
  const [preview, setPreview] = useState<string | null>(null)
  const [previewMsg, setPreviewMsg] = useState<string>('')
  const [previewActualSize, setPreviewActualSize] = useState<string>('')

  const openPreview = (url: string) => {
    setPreviewMsg('')
    setPreviewActualSize('')
    setPreview(url)
  }

  const closePreview = () => {
    setPreview(null)
    setPreviewMsg('')
    setPreviewActualSize('')
  }

  if (!task) {
    return (
      <div className="qa-run">
        <div className="qa-run-head">
          <Link to={`/apps/tasks${loc.search || ''}`} className="qa-back"><ArrowLeft size={18} /> 返回任务列表</Link>
          <div className="qa-run-title"><div className="n">任务不存在</div></div>
        </div>
      </div>
    )
  }

  return (
    <div className="qa-run">
      <div className="qa-run-head">
        <Link to={`/apps/tasks${loc.search || ''}`} className="qa-back"><ArrowLeft size={18} /> 返回任务列表</Link>
        <div className="qa-run-title">
          <div className="n">{task.title}</div>
          <div className="d">{task.promptSetLabel || '未分组'} · {task.id}</div>
        </div>
      </div>

      <div className="dt-body">
        <div className="dt-panel">
          <div className="dt-title">步骤状态</div>
          <div className="dt-steps">
            {(['agent1', 'agent2', 'merge', 'gen'] as const).map(k => (
              <div key={k} className="dt-step">
                <div className="k">{k}</div>
                <div className="v">{task.steps?.[k]?.state || 'idle'}{task.steps?.[k]?.error ? ` · ${task.steps?.[k]?.error}` : ''}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="dt-panel">
          <div className="dt-title">输出</div>
          <div className="dt-out">
            <div className="dt-out-head">
              <div className="t">角色1输出</div>
              <button className="ps-iconbtn" type="button" onClick={() => copyText(task.agent1Output)} title="复制"><Copy size={16} /></button>
            </div>
            <textarea className="dt-text" readOnly value={task.agent1Output} />
          </div>
          <div className="dt-out">
            <div className="dt-out-head">
              <div className="t">角色2输出</div>
              <button className="ps-iconbtn" type="button" onClick={() => copyText(task.agent2Output)} title="复制"><Copy size={16} /></button>
            </div>
            <textarea className="dt-text" readOnly value={task.agent2Output} />
          </div>
          <div className="dt-out">
            <div className="dt-out-head">
              <div className="t">最终提示词</div>
              <button className="ps-iconbtn" type="button" onClick={() => copyText(task.finalPrompt)} title="复制"><Copy size={16} /></button>
            </div>
            <textarea className="dt-text" readOnly value={task.finalPrompt} />
          </div>
        </div>

        <div className="dt-panel">
          <div className="dt-title">结果图片</div>
          {task.outImages.length === 0 ? (
            <div className="qa-empty"><div className="t">暂无结果</div></div>
          ) : (
            <div className="ps-result-grid">
              {task.outImages.map((u, i) => (
                <div key={`${u}_${i}`} className="ps-result-item">
                  <img src={u} alt="result" onDoubleClick={() => openPreview(u)} draggable={false} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={`ps-preview-modal ${preview ? 'show' : ''}`} onMouseDown={closePreview}>
        {preview ? (
          <div className="ps-preview-card" onMouseDown={(e) => e.stopPropagation()}>
            <button className="ps-preview-close" type="button" onClick={closePreview} aria-label="关闭">
              <X size={22} />
            </button>

            <div className="ps-preview-media">
              <img
                src={preview}
                className="ps-preview-img"
                alt="preview"
                onLoad={(e) => {
                  const img = e.currentTarget
                  setPreviewActualSize(`${img.naturalWidth}x${img.naturalHeight}`)
                }}
              />
            </div>

            <div className="ps-preview-side">
              <div className="ps-preview-title">图片操作</div>
              <div className="ps-preview-actions">
                <button
                  className="ps-preview-btn"
                  type="button"
                  onClick={async () => {
                    const url = String(preview)
                    const localPath = tryGetLocalFilePathFromUrl(url)
                    if (localPath && window.nexaAPI?.showItemInFolder) {
                      const r = await window.nexaAPI.showItemInFolder({ filePath: localPath })
                      setPreviewMsg(r.success ? '已在资源管理器中定位文件' : '定位文件失败')
                      return
                    }
                    try {
                      window.open(url, '_blank')
                      setPreviewMsg('已打开')
                    } catch {
                      setPreviewMsg('打开失败')
                    }
                  }}
                  title="打开或定位原文件"
                >
                  打开
                </button>

                <button
                  className="ps-preview-btn"
                  type="button"
                  onClick={async () => {
                    const url = String(preview)
                    if (!window.nexaAPI?.exportImagesToDir || !window.nexaAPI?.showItemInFolder) {
                      setPreviewMsg('保存失败：当前环境不支持')
                      return
                    }

                    const base = safeFileName(`${task.title}_${task.id.slice(-6)}`)
                    const r = await window.nexaAPI.exportImagesToDir({
                      saveDir: outputDirectory,
                      items: [{ url, fileName: `${base}_${Date.now()}` }]
                    })
                    if (!r.success) {
                      setPreviewMsg(`保存失败：${r.error || (r.failed && r.failed[0] && r.failed[0].error) || '未知错误'}`)
                      return
                    }
                    const p = (r.saved && r.saved[0]) ? String(r.saved[0]) : ''
                    if (p) {
                      await window.nexaAPI.showItemInFolder({ filePath: p })
                      setPreviewMsg('已保存到本地并打开文件位置')
                      return
                    }
                    setPreviewMsg('保存失败：未返回文件路径')
                  }}
                  title="保存到本地输出目录并定位"
                >
                  保存
                </button>

                <button
                  className="ps-preview-btn"
                  type="button"
                  onClick={async () => {
                    const url = String(preview)
                    if (!window.nexaAPI?.copyImageToClipboard) {
                      setPreviewMsg('复制失败：当前环境不支持')
                      return
                    }
                    const r = await window.nexaAPI.copyImageToClipboard({ url })
                    setPreviewMsg(r.success ? '已复制图片到剪贴板' : `复制失败：${r.error || '未知错误'}`)
                  }}
                  title="复制图片到剪贴板"
                >
                  复制
                </button>

                <button
                  className="ps-preview-btn"
                  type="button"
                  onClick={async () => {
                    const req = (task as any)?.requestDebug
                    if (!req || !req.url) {
                      setPreviewMsg('无请求信息（可能是旧任务或未记录）')
                      return
                    }
                    const text = formatRequestDebugForCopy(req)
                    try {
                      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                      await navigator.clipboard.writeText(text)
                      setPreviewMsg('已复制请求代码（已脱敏）')
                    } catch {
                      uiTextViewer(text, { title: '复制失败，请手动复制（已脱敏）', size: 'lg' })
                      setPreviewMsg('复制失败：已弹出手动复制框')
                    }
                  }}
                  title="复制本次调用 API 的请求代码（已脱敏）"
                >
                  复制请求
                </button>

                <button
                  className="ps-preview-btn"
                  type="button"
                  onClick={async () => {
                    const raw = (task as any)?.responseDebug
                    const t = String(raw?.dataPreview || '').trim() || stringifySafe(raw)
                    if (!t.trim()) {
                      setPreviewMsg('暂无可复制的返回内容')
                      return
                    }
                    try {
                      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                      await navigator.clipboard.writeText(t)
                      setPreviewMsg('已复制接口返回')
                    } catch {
                      uiTextViewer(t, { title: '复制失败，请手动复制', size: 'lg' })
                      setPreviewMsg('复制失败：已弹出手动复制框')
                    }
                  }}
                  title="复制接口返回内容"
                >
                  复制返回
                </button>
              </div>

              <div className="ps-preview-info">
                <div className="ps-preview-info-title">信息</div>
                <div className="ps-preview-kv">
                  <div className="k">文件</div>
                  <div className="v" title={pickFileNameFromUrl(String(preview))}>{pickFileNameFromUrl(String(preview))}</div>

                  <div className="k">像素</div>
                  <div className="v">{previewActualSize || '-'}</div>
                </div>
              </div>

              {previewMsg ? (
                <div className="ps-preview-msg">{previewMsg}</div>
              ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
  )
}
