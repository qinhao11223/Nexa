import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useVideoGenStore, type VideoTask } from '../store'
import { X, Download, Trash2, Copy, FolderOpen } from 'lucide-react'
import { formatRequestDebugForCopy } from '../../image_gen/utils/requestDebug'
import { useSettingsStore } from '../../settings/store'
import { uiTextViewer } from '../../ui/dialogStore'

function extractAllowedModels(text: string): string[] {
  const s = String(text || '')
  const m = /not\s+in\s*\[([^\]]+)\]/i.exec(s)
  if (!m) return []
  const raw = m[1]
  const parts = raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => x.replace(/^['"\s]+|['"\s]+$/g, ''))
    .filter(Boolean)
  // 去重（保持顺序）
  const out: string[] = []
  const set = new Set<string>()
  for (const p of parts) {
    if (set.has(p)) continue
    set.add(p)
    out.push(p)
    if (out.length >= 50) break
  }
  return out
}

export default function VideoPreviewModal(props: {
  open: boolean
  task: VideoTask | null
  outputDirectory: string
  onClose: () => void
  onDelete: (id: string) => void
}) {
  const { open, task, outputDirectory, onClose, onDelete } = props
  const [msg, setMsg] = useState('')

  const canShow = Boolean(open && task)
  const url = task?.url || ''
  const respPreview = task?.response?.dataPreview || ''
  const taskId = task?.id || ''
  const respFull = useVideoGenStore(s => (taskId ? (s.responseFullById?.[taskId] || '') : ''))
  const [showFullResp, setShowFullResp] = useState(false)

  useEffect(() => {
    setShowFullResp(false)
  }, [taskId])

  // 一旦拿到更完整的返回，默认切到“完整”视图（避免用户误以为被截断）
  useEffect(() => {
    if (showFullResp) return
    if (respFull.trim()) setShowFullResp(true)
  }, [respFull, showFullResp])

  const respText = (showFullResp && respFull.trim()) ? respFull : respPreview

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [durationSec, setDurationSec] = useState(0)
  const [currentSec, setCurrentSec] = useState(0)

  const isPortrait = useMemo(() => {
    const raw = String(task?.aspectRatio || '').trim().replace(/：/g, ':')
    const m = /^(\d+)\s*:\s*(\d+)$/.exec(raw)
    if (!m) return false
    const a = Number(m[1])
    const b = Number(m[2])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false
    return b > a
  }, [task?.aspectRatio])

  useEffect(() => {
    setDurationSec(0)
    setCurrentSec(0)
  }, [url])

  const fmtTime = (sec: number) => {
    const s = Math.max(0, Math.floor(sec || 0))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const r = s % 60
    const pad = (n: number) => String(n).padStart(2, '0')
    if (h > 0) return `${h}:${pad(m)}:${pad(r)}`
    return `${m}:${pad(r)}`
  }

  const progressPct = durationSec > 0 ? Math.max(0, Math.min(100, (currentSec / durationSec) * 100)) : 0

  const { providers, activeProviderId, videoProviderId, updateProvider } = useSettingsStore()
  const providerId = task?.providerId || videoProviderId || activeProviderId
  const provider = providers.find(p => p.id === providerId)

  const allowedModels = useMemo(() => {
    const combined = `${task?.errorMsg || ''}\n${respPreview || ''}`
    return extractAllowedModels(combined)
  }, [task?.errorMsg, respPreview])

  const fileName = useMemo(() => {
    if (!url) return 'video'
    try {
      const u = new URL(url)
      const p = (u.pathname || '').split('/').filter(Boolean)
      return p.length ? p[p.length - 1] : 'video'
    } catch {
      return 'video'
    }
  }, [url])

  if (!canShow) return null

  return (
    <div className="vg-modal" onMouseDown={onClose}>
      <div className="vg-modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <button className="vg-modal-close" onClick={onClose} title="关闭"><X size={18} /></button>

        <div className={`vg-modal-media ${isPortrait ? 'portrait' : 'landscape'}`}>
          {url ? (
            isPortrait ? (
              <div className="vg-modal-portrait-wrap">
                <video
                  ref={(el) => { videoRef.current = el }}
                  src={url}
                  controls
                  autoPlay
                  playsInline
                  className="vg-modal-video portrait"
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget
                    const d = Number(v.duration)
                    if (Number.isFinite(d) && d > 0) setDurationSec(d)
                  }}
                  onDurationChange={(e) => {
                    const v = e.currentTarget
                    const d = Number(v.duration)
                    if (Number.isFinite(d) && d > 0) setDurationSec(d)
                  }}
                  onTimeUpdate={(e) => {
                    const v = e.currentTarget
                    const t = Number(v.currentTime)
                    if (Number.isFinite(t) && t >= 0) setCurrentSec(t)
                  }}
                />

                <div
                  className="vg-modal-playbar"
                  title="点击进度条跳转"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const v = videoRef.current
                    if (!v) return
                    const d = Number(v.duration)
                    if (!Number.isFinite(d) || d <= 0) return
                    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
                    const next = Math.max(0, Math.min(d, ratio * d))
                    try {
                      v.currentTime = next
                      setCurrentSec(next)
                    } catch {
                      // ignore
                    }
                  }}
                >
                  <div className="track">
                    <div className="fill" style={{ width: `${progressPct}%` }} />
                  </div>
                  <div className="time">{fmtTime(currentSec)} / {durationSec > 0 ? fmtTime(durationSec) : '--:--'}</div>
                </div>
              </div>
            ) : (
              <video
                src={url}
                controls
                autoPlay
                playsInline
                className="vg-modal-video landscape"
              />
            )
          ) : (
            <div className="vg-modal-ph">暂无视频</div>
          )}
        </div>

        <div className="vg-modal-side">
          <div className="vg-modal-title">视频操作</div>

          <div className="vg-modal-actions">
            <button
              type="button"
              className="vg-mini-btn"
              onClick={async () => {
                if (!task?.url) return
                if (!window.nexaAPI?.downloadVideo) {
                  setMsg('保存失败：当前环境不支持')
                  return
                }
                const dl = await window.nexaAPI.downloadVideo({
                  url: task.url,
                  saveDir: outputDirectory,
                  fileName: `nexa_video_${Date.now()}`
                })
                setMsg(dl.success ? '已保存到本地' : `保存失败：${dl.error || '未知错误'}`)
              }}
              title="保存到本地（默认输出目录）"
            >
              <Download size={14} /> 保存
            </button>

            <button
              type="button"
              className="vg-mini-btn"
              onClick={async () => {
                if (!task?.url) return
                if (!window.nexaAPI?.selectDirectory || !window.nexaAPI?.exportVideosToDir) {
                  setMsg('导出失败：当前环境不支持')
                  return
                }
                const picked = await window.nexaAPI.selectDirectory()
                if (!picked.success) {
                  setMsg(`导出失败：${picked.error || '选择目录失败'}`)
                  return
                }
                if (!picked.dirPath) {
                  setMsg('已取消导出')
                  return
                }
                const r = await window.nexaAPI.exportVideosToDir({
                  saveDir: picked.dirPath,
                  items: [{ url: task.url, fileName: `nexa_video_${task.createdAt || Date.now()}` }]
                })
                if (!r.success) {
                  setMsg(`导出失败：${r.error || '未知错误'}`)
                  return
                }
                const failedCount = Array.isArray(r.failed) ? r.failed.length : 0
                setMsg(failedCount ? `导出完成（失败 ${failedCount} 个）` : '导出完成')
              }}
              title="导出到指定目录"
            >
              <FolderOpen size={14} /> 导出
            </button>

            <button
              type="button"
              className="vg-mini-btn"
              onClick={async () => {
                const req = task?.request
                if (!req) {
                  setMsg('无请求信息')
                  return
                }
                const text = formatRequestDebugForCopy(req)
                try {
                  if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                  await navigator.clipboard.writeText(text)
                  setMsg('已复制请求代码（已脱敏）')
                } catch {
                  uiTextViewer(text, { title: '复制失败，请手动复制（已脱敏）' })
                  setMsg('复制失败：已弹出手动复制框')
                }
              }}
              title="复制请求代码（已脱敏）"
            >
              <Copy size={14} /> 复制请求
            </button>

            <button
              type="button"
              className="vg-mini-btn"
              onClick={async () => {
                if (!respText.trim()) {
                  setMsg('无接口返回信息')
                  return
                }
                const text = `// Response (masked)\n${respText}`
                try {
                  if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
                  await navigator.clipboard.writeText(text)
                  setMsg(showFullResp && respFull.trim() ? '已复制接口返回（完整）' : '已复制接口返回')
                } catch {
                  uiTextViewer(text, { title: '复制失败，请手动复制' })
                  setMsg('复制失败：已弹出手动复制框')
                }
              }}
              title={showFullResp && respFull.trim() ? '复制接口返回（完整）' : '复制接口返回'}
            >
              <Copy size={14} /> 复制返回
            </button>

            <button
              type="button"
              className="vg-mini-btn danger"
              onClick={() => task && onDelete(task.id)}
              title="删除任务"
            >
              <Trash2 size={14} /> 删除
            </button>
          </div>

          {task?.status === 'error' && task?.errorMsg ? (
            <div className="vg-modal-error">
              <div className="k">错误</div>
              <div className="v">{task.errorMsg}</div>
            </div>
          ) : null}

          {allowedModels.length > 0 ? (
            <div className="vg-modal-allowed">
              <div className="k">该接口可用模型（来自错误提示）</div>
              <div className="vg-allowed-actions">
                <button
                  type="button"
                  className="vg-mini-btn"
                  disabled={!providerId || !provider}
                  title={!providerId || !provider ? '找不到对应的 API 网站配置' : '切换为第一个可用模型'}
                  onClick={() => {
                    if (!providerId || !provider) return
                    const first = allowedModels[0]
                    updateProvider(providerId, { selectedVideoModel: first })
                    setMsg(`已切换模型：${first}`)
                  }}
                >
                  应用第一个
                </button>

                <button
                  type="button"
                  className="vg-mini-btn"
                  disabled={!providerId || !provider}
                  title={!providerId || !provider ? '找不到对应的 API 网站配置' : '写入到视频常用（最多 4 个）'}
                  onClick={() => {
                    if (!providerId || !provider) return
                    const nextPinned = allowedModels.slice(0, 4)
                    updateProvider(providerId, { pinnedVideoModels: nextPinned })
                    setMsg(`已写入视频常用：${nextPinned.join(', ')}`)
                  }}
                >
                  写入常用(4)
                </button>
              </div>

              <div className="vg-allowed-grid">
                {allowedModels.slice(0, 16).map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`vg-allowed-chip ${provider?.selectedVideoModel === m ? 'active' : ''}`}
                    title={m}
                    onClick={() => {
                      if (!providerId || !provider) {
                        setMsg('无法应用：找不到对应的 API 网站配置')
                        return
                      }
                      updateProvider(providerId, { selectedVideoModel: m })
                      setMsg(`已切换模型：${m}`)
                    }}
                  >
                    {m}
                  </button>
                ))}
                {allowedModels.length > 16 ? (
                  <div className="vg-allowed-more">+{allowedModels.length - 16}</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {respText.trim() ? (
            <div className="vg-modal-debug">
              <div className="k" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span>接口返回（脱敏）</span>
                {respFull.trim() ? (
                  <button
                    type="button"
                    className="vg-mini-btn"
                    onClick={() => setShowFullResp(v => !v)}
                    title={showFullResp ? '切换为预览' : '切换为完整'}
                  >
                    {showFullResp ? '预览' : '完整'}
                  </button>
                ) : null}
              </div>
              <pre className="v">{respText}</pre>
            </div>
          ) : null}

          {msg && <div className="vg-tip">{msg}</div>}

          <div className="vg-modal-info">
            <div className="r"><span className="k">文件</span><span className="v">{fileName}</span></div>
            <div className="r"><span className="k">状态</span><span className="v">{task?.status}</span></div>
            <div className="r"><span className="k">时长</span><span className="v">{task?.durationSec}s</span></div>
            <div className="r"><span className="k">画幅</span><span className="v">{task?.aspectRatio}</span></div>
            {/* 清晰度通常由模型决定；不再展示/请求 */}
            <div className="r"><span className="k">模型</span><span className="v">{task?.model}</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
