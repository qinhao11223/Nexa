import React, { useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, Copy } from 'lucide-react'
import { useProductShotTaskStore } from '../product_shot_tasks/store'
import { uiTextViewer } from '../../ui/dialogStore'
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

export default function DesktopTaskDetail() {
  const { taskId } = useParams()
  const loc = useLocation()
  const tasks = useProductShotTaskStore(s => s.tasks)
  const task = useMemo(() => (tasks || []).find(t => t.id === String(taskId || '')) || null, [tasks, taskId])
  const [preview, setPreview] = useState<string | null>(null)

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
                  <img src={u} alt="result" onDoubleClick={() => setPreview(u)} draggable={false} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={`ps-preview-modal ${preview ? 'show' : ''}`} onMouseDown={() => setPreview(null)}>
        {preview ? (
          <div className="ps-preview-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ps-preview-media">
              <img src={preview} className="ps-preview-img" alt="preview" />
            </div>
            <div className="ps-preview-side">
              <div className="ps-preview-title">图片操作</div>
              <div className="ps-preview-actions">
                <button className="ps-preview-btn" type="button" onClick={() => { try { window.open(preview, '_blank') } catch {} }}>打开</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
