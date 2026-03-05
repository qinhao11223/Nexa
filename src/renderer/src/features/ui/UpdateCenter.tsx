import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSettingsStore } from '../settings/store'
import { uiTextViewer } from './dialogStore'
import { uiToast } from './toastStore'

type UpdaterEvt =
  | { type: 'checking' }
  | { type: 'update-available'; version: string; releaseNotes: string }
  | { type: 'update-not-available'; version: string }
  | { type: 'download-progress'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'error'; message: string }

function fmtBytes(n: number) {
  const v = Number(n || 0)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let x = v
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export default function UpdateCenter() {
  const updateChannel = useSettingsStore(s => s.updateChannel)

  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<'idle' | 'available' | 'downloading' | 'downloaded' | 'error'>('idle')
  const [newVersion, setNewVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [progress, setProgress] = useState({ percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 })
  const [errMsg, setErrMsg] = useState('')

  const lastCheckRef = useRef<number>(0)
  const silentNotAvailableRef = useRef(true)

  const notesPreview = useMemo(() => {
    const t = String(notes || '').trim()
    if (!t) return ''
    const lines = t.split(/\r?\n/)
    return lines.slice(0, 10).join('\n')
  }, [notes])

  const api = (window as any).nexaAPI

  const doCheck = async () => {
    const now = Date.now()
    if (now - lastCheckRef.current < 3000) return
    lastCheckRef.current = now
    try {
      await api?.updaterSetChannel?.(updateChannel)
      await api?.updaterCheck?.()
    } catch {
      // ignore (events will also fire error)
    }
  }

  useEffect(() => {
    const onManual = () => {
      silentNotAvailableRef.current = false
    }
    window.addEventListener('nexa-updater-manual-check', onManual as any)
    return () => window.removeEventListener('nexa-updater-manual-check', onManual as any)
  }, [])

  useEffect(() => {
    // 通道变更后同步到主进程（不自动检查，避免频繁）
    try {
      void api?.updaterSetChannel?.(updateChannel)
    } catch {
      // ignore
    }
  }, [updateChannel])

  useEffect(() => {
    // 启动自动检查更新（生产环境可用；开发环境会收到“仅安装版可用”的提示）
    const t = window.setTimeout(() => {
      void doCheck()
    }, 4500)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!api?.onUpdaterEvent) return
    api.onUpdaterEvent((evt: UpdaterEvt) => {
      if (!evt || typeof evt !== 'object') return
      if (evt.type === 'checking') {
        return
      }
      if (evt.type === 'update-not-available') {
        if (!silentNotAvailableRef.current) {
          uiToast('info', '当前已是最新版本')
        }
        silentNotAvailableRef.current = false
        return
      }
      if (evt.type === 'update-available') {
        setNewVersion(String(evt.version || ''))
        setNotes(String(evt.releaseNotes || ''))
        setStage('available')
        setOpen(true)
        return
      }
      if (evt.type === 'download-progress') {
        setStage('downloading')
        setProgress({
          percent: Number(evt.percent || 0),
          bytesPerSecond: Number(evt.bytesPerSecond || 0),
          transferred: Number(evt.transferred || 0),
          total: Number(evt.total || 0)
        })
        setOpen(true)
        return
      }
      if (evt.type === 'update-downloaded') {
        setStage('downloaded')
        setOpen(true)
        uiToast('success', '更新已下载完成')
        return
      }
      if (evt.type === 'error') {
        const m = String(evt.message || '更新失败')
        setErrMsg(m)
        setStage('error')
        setOpen(true)
        uiToast('error', '更新失败')
      }
    })
  }, [])

  if (!open) return null

  return (
    <div className="nx-update-wrap" role="presentation">
      <div className="nx-update-backdrop" onMouseDown={() => setOpen(false)} />
      <div className="nx-update" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nx-update-head">
          <div className="nx-update-title">软件更新</div>
          <button type="button" className="nx-update-x" onClick={() => setOpen(false)} aria-label="关闭">×</button>
        </div>

        <div className="nx-update-body">
          {stage === 'available' ? (
            <>
              <div className="nx-update-kv">
                <div className="k">发现新版本</div>
                <div className="v">{newVersion || '-'}</div>
              </div>

              <div className="nx-update-notes">
                <div className="t">更新内容</div>
                <pre className="p">{notesPreview || '（未提供更新说明）'}</pre>
                {notes && notes.trim() ? (
                  <button
                    type="button"
                    className="nx-update-link"
                    onClick={() => uiTextViewer(notes, { title: `更新内容 v${newVersion || ''}` })}
                  >
                    查看全部
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {stage === 'downloading' ? (
            <>
              <div className="nx-update-kv">
                <div className="k">正在下载</div>
                <div className="v">{`${Math.max(0, Math.min(100, progress.percent)).toFixed(0)}%`}</div>
              </div>
              <div className="nx-update-bar">
                <div className="fill" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
              </div>
              <div className="nx-update-meta">
                <div>{`${fmtBytes(progress.transferred)} / ${fmtBytes(progress.total)}`}</div>
                <div>{`${fmtBytes(progress.bytesPerSecond)}/s`}</div>
              </div>
            </>
          ) : null}

          {stage === 'downloaded' ? (
            <>
              <div className="nx-update-kv">
                <div className="k">下载完成</div>
                <div className="v">请重启安装更新</div>
              </div>
              {notesPreview ? (
                <div className="nx-update-notes">
                  <div className="t">更新内容</div>
                  <pre className="p">{notesPreview}</pre>
                </div>
              ) : null}
            </>
          ) : null}

          {stage === 'error' ? (
            <>
              <div className="nx-update-kv">
                <div className="k">更新失败</div>
                <div className="v">可前往下载页手动更新</div>
              </div>
              <pre className="nx-update-err">{errMsg || '未知错误'}</pre>
            </>
          ) : null}
        </div>

        <div className="nx-update-actions">
          {stage === 'available' ? (
            <>
              <button type="button" className="nx-btn ghost" onClick={() => setOpen(false)}>稍后</button>
              <button
                type="button"
                className="nx-btn"
                onClick={async () => {
                  try {
                    setStage('downloading')
                    await api?.updaterDownload?.()
                  } catch (e: any) {
                    setStage('error')
                    setErrMsg(String(e?.message || 'download failed'))
                  }
                }}
              >
                立即更新
              </button>
            </>
          ) : null}

          {stage === 'downloading' ? (
            <button type="button" className="nx-btn ghost" onClick={() => setOpen(false)}>后台下载</button>
          ) : null}

          {stage === 'downloaded' ? (
            <>
              <button type="button" className="nx-btn ghost" onClick={() => setOpen(false)}>稍后再说</button>
              <button
                type="button"
                className="nx-btn"
                onClick={async () => {
                  try {
                    await api?.updaterQuitAndInstall?.()
                  } catch {
                    // ignore
                  }
                }}
              >
                重启安装
              </button>
            </>
          ) : null}

          {stage === 'error' ? (
            <>
              <button type="button" className="nx-btn ghost" onClick={() => setOpen(false)}>关闭</button>
              <button
                type="button"
                className="nx-btn"
                onClick={async () => {
                  try {
                    await api?.updaterOpenReleases?.()
                  } catch {
                    // ignore
                  }
                }}
              >
                打开下载页
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
