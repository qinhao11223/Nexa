import React from 'react'
import { Star } from 'lucide-react'
import type { QuickAppWorkflow } from '../types'

export default function AppCard(props: {
  app: QuickAppWorkflow
  pinned?: boolean
  onPin?: () => void
  onOpen?: () => void
}) {
  const { app, pinned, onPin, onOpen } = props
  return (
    <div className="qa-card" role="button" tabIndex={0} onClick={onOpen}>
      <div className="qa-card-head">
        <div className="qa-card-name">{app.meta.name}</div>
        <button
          type="button"
          className={`qa-card-pin ${pinned ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onPin?.()
          }}
          title={pinned ? '取消收藏' : '收藏'}
          aria-label={pinned ? '取消收藏' : '收藏'}
        >
          <Star size={16} />
        </button>
      </div>
      <div className="qa-card-desc">{String(app.meta.desc || '快捷工作流') || ''}</div>
      <div className="qa-card-foot">
        <div className="qa-card-cat">{String(app.meta.category || '其他')}</div>
      </div>
    </div>
  )
}
