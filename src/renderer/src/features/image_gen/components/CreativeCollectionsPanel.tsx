import React, { useMemo } from 'react'
import { Star, History, Type, Wand2, ArrowRight } from 'lucide-react'
import type { CreativeLibraryMode } from '../../creative_library/types'
import { useCreativeLibraryStore } from '../../creative_library/store'

// 右侧“收藏/最近使用”面板（用于图像改图页）
// 说明：之前这里是占位模拟数据，浅色模式下看起来像 bug；现在改为真正展示创意库里的数据

function renderCover(idea: any) {
  if (idea.coverKind === 'image' && idea.coverValue) {
    return <img src={idea.coverValue} alt="cover" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} />
  }
  if (idea.coverKind === 'emoji' && idea.coverValue) {
    return <span style={{ fontSize: 18 }}>{idea.coverValue}</span>
  }
  return <span style={{ fontSize: 18 }}>🧠</span>
}

export default function CreativeCollectionsPanel(props: {
  mode: CreativeLibraryMode
  onOpenLibrary: () => void
  onApplyPrompt: (text: string) => void
  onApplyOptimizeCustom: (text: string) => void
}) {
  const { mode, onOpenLibrary, onApplyPrompt, onApplyOptimizeCustom } = props

  const { promptIdeas, optimizeIdeas, recentUsedIds, recordUsed } = useCreativeLibraryStore()

  const ideas = useMemo(() => {
    return [...promptIdeas, ...optimizeIdeas]
  }, [promptIdeas, optimizeIdeas])

  const favorites = useMemo(() => {
    return ideas
      .filter(i => i.mode === mode && i.favorite)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
  }, [ideas, mode])

  const recents = useMemo(() => {
    const map = new Map(ideas.map(i => [i.id, i]))
    const list = recentUsedIds
      .map(id => map.get(id))
      .filter(Boolean)
      .filter(i => (i as any).mode === mode) as any[]
    return list.slice(0, 8)
  }, [ideas, recentUsedIds, mode])

  const Item = (idea: any) => (
    <div key={idea.id} className="ig-history-item" title={idea.kind === 'prompt' ? idea.prompt : idea.optimizeCustomText}>
      <div className="ig-history-thumb">
        {renderCover(idea)}
      </div>
      <div className="ig-history-info">
        <span className="title">{idea.listTitle || idea.title}</span>
        <span className="desc">{idea.listSubtitle || idea.category}</span>
      </div>
      <div className="ig-creative-actions">
        {idea.kind === 'prompt' ? (
          <button
            type="button"
            className="ig-icon-btn"
            title="写入提示词（Prompt）"
            onClick={() => {
              recordUsed(idea.id)
              onApplyPrompt(idea.prompt)
            }}
          >
            <Type size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="ig-icon-btn"
            title="写入优化偏好"
            onClick={() => {
              recordUsed(idea.id)
              onApplyOptimizeCustom(idea.optimizeCustomText)
            }}
          >
            <Wand2 size={16} />
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="ig-creative-section">
      <div className="ig-right-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Star size={18} color="#3b82f6" /> 收藏创意
        </div>
        <button type="button" className="ig-action-btn" onClick={onOpenLibrary} title="去创意库管理">
          管理 <ArrowRight size={14} />
        </button>
      </div>

      {favorites.length === 0 ? (
        <div className="ig-creative-empty">暂无收藏。你可以在创意库中点星标收藏常用模板。</div>
      ) : (
        <div className="ig-creative-list">
          {favorites.map(Item)}
        </div>
      )}

      <div className="ig-right-header" style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <History size={18} color="#00e5ff" /> 最近使用
        </div>
      </div>

      {recents.length === 0 ? (
        <div className="ig-creative-empty">暂无最近使用记录。点右侧按钮写入一次就会出现在这里。</div>
      ) : (
        <div className="ig-creative-list">
          {recents.map(Item)}
        </div>
      )}
    </div>
  )
}
