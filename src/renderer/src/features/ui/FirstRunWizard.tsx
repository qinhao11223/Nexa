import React, { useEffect, useMemo, useState } from 'react'
import { useSettingsStore } from '../settings/store'
import { uiToast } from './toastStore'

type PersistConfig = {
  setupCompleted: boolean
  dataRoot: string
  imageOutputDirectory: string
  videoOutputDirectory: string
}

export default function FirstRunWizard() {
  const setOutputDirectory = useSettingsStore(s => s.setOutputDirectory)
  const setVideoOutputDirectory = useSettingsStore(s => s.setVideoOutputDirectory)
  const setAutoSaveEnabled = useSettingsStore(s => s.setAutoSaveEnabled)
  const setVideoAutoSaveEnabled = useSettingsStore(s => s.setVideoAutoSaveEnabled)

  const [open, setOpen] = useState(false)
  const [dataRoot, setDataRoot] = useState('')
  const [imgDir, setImgDir] = useState('')
  const [vidDir, setVidDir] = useState('')
  const [busy, setBusy] = useState(false)

  const api = (window as any).nexaAPI

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (!api?.getPersistConfig) return
        const r = await api.getPersistConfig()
        if (!alive) return
        const c = r?.config as PersistConfig
        if (!c) return
        setDataRoot(String(c.dataRoot || ''))
        setImgDir(String(c.imageOutputDirectory || ''))
        setVidDir(String(c.videoOutputDirectory || ''))
        if (r?.warning) {
          uiToast('info', String(r.warning || ''))
        }
        if (!c.setupCompleted) setOpen(true)
      } catch {
        // ignore
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const canSave = useMemo(() => {
    return Boolean(dataRoot.trim() && imgDir.trim() && vidDir.trim())
  }, [dataRoot, imgDir, vidDir])

  if (!open) return null

  const pickDir = async (setter: (v: string) => void) => {
    try {
      if (!api?.selectDirectory) {
        uiToast('error', '当前环境不支持选择目录')
        return
      }
      const r = await api.selectDirectory()
      if (!r?.success) {
        uiToast('error', r?.error || '选择目录失败')
        return
      }
      if (!r.dirPath) return
      setter(String(r.dirPath))
    } catch (e: any) {
      uiToast('error', e?.message || '选择目录失败')
    }
  }

  return (
    <div className="nx-onboard-wrap" role="presentation">
      <div className="nx-onboard-backdrop" />
      <div className="nx-onboard" role="dialog" aria-modal="true">
        <div className="nx-onboard-head">
          <div className="nx-onboard-title">首次使用设置</div>
          <div className="nx-onboard-sub">选择数据存储位置与默认导出目录（后续可在设置中修改）</div>
        </div>

        <div className="nx-onboard-body">
          <div className="nx-onboard-row">
            <div className="k">数据存储位置</div>
            <div className="v">
              <input className="nx-onboard-input" value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} placeholder="例如 D:\\Nexa" />
              <button type="button" className="nx-btn ghost" onClick={() => pickDir(setDataRoot)}>选择</button>
            </div>
          </div>

          <div className="nx-onboard-row">
            <div className="k">图片默认保存目录</div>
            <div className="v">
              <input className="nx-onboard-input" value={imgDir} onChange={(e) => setImgDir(e.target.value)} placeholder="例如 D:\\Nexa\\output\\images" />
              <button type="button" className="nx-btn ghost" onClick={() => pickDir(setImgDir)}>选择</button>
            </div>
          </div>

          <div className="nx-onboard-row">
            <div className="k">视频默认保存目录</div>
            <div className="v">
              <input className="nx-onboard-input" value={vidDir} onChange={(e) => setVidDir(e.target.value)} placeholder="例如 D:\\Nexa\\output\\videos" />
              <button type="button" className="nx-btn ghost" onClick={() => pickDir(setVidDir)}>选择</button>
            </div>
          </div>

          <div className="nx-onboard-hint">
            提示：建议将“数据存储位置”放在你常用的盘符（例如 D 盘），以便备份与迁移。图片/视频保存目录也建议放在该目录下。
          </div>
        </div>

        <div className="nx-onboard-actions">
          <button
            type="button"
            className="nx-btn"
            disabled={!canSave || busy}
            onClick={async () => {
              if (!canSave) return
              setBusy(true)
              try {
                if (api?.setPersistConfig) {
                  const r = await api.setPersistConfig({
                    setupCompleted: true,
                    dataRoot: dataRoot.trim(),
                    imageOutputDirectory: imgDir.trim(),
                    videoOutputDirectory: vidDir.trim()
                  })
                  if (!r?.success) throw new Error(r?.error || '保存失败')
                }

                setAutoSaveEnabled(true)
                setVideoAutoSaveEnabled(true)
                setOutputDirectory(imgDir.trim())
                setVideoOutputDirectory(vidDir.trim())

                uiToast('success', '已完成首次设置')
                setOpen(false)
              } catch (e: any) {
                uiToast('error', e?.message || '保存失败')
              } finally {
                setBusy(false)
              }
            }}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
