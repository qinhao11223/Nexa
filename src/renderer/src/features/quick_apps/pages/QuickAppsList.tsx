import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import AppCard from '../components/AppCard'
import { quickAppsCatalog } from '../apps/loadApps'
import { useSettingsStore } from '../../settings/store'
import '../styles/quickApps.css'

type FilterKey = 'all' | 'pinned' | string

function norm(s: string) {
  return String(s || '').trim().toLowerCase()
}

export default function QuickAppsList() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')

  const pinned = useSettingsStore(s => s.quickAppsPinned)
  const togglePinned = useSettingsStore(s => s.toggleQuickAppPinned)
  const enabledMap = useSettingsStore(s => s.quickAppsEnabled)

  const apps = useMemo(() => {
    return quickAppsCatalog.list.filter(w => {
      const id = w.meta.id
      const enabled = (enabledMap && typeof enabledMap === 'object') ? enabledMap[id] : undefined
      return enabled === false ? false : true
    })
  }, [enabledMap])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const a of apps) {
      const c = String(a.meta.category || '').trim()
      if (c) set.add(c)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [apps])

  const filtered = useMemo(() => {
    const nq = norm(q)
    const pinSet = new Set(pinned || [])
    return apps.filter(a => {
      const id = a.meta.id
      const inPinned = pinSet.has(id)
      if (filter === 'pinned' && !inPinned) return false
      if (filter !== 'all' && filter !== 'pinned') {
        const c = String(a.meta.category || '')
        if (c !== filter) return false
      }
      if (!nq) return true
      const hay = [a.meta.name, a.meta.desc || '', ...(a.meta.keywords || [])]
        .map(norm)
        .join(' ')
      return hay.includes(nq)
    })
  }, [apps, q, filter, pinned])

  return (
    <div className="qa-layout">
      <div className="qa-top">
        <div className="qa-search">
          <Search size={18} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索快捷应用..."
            spellCheck={false}
          />
        </div>
      </div>

      <div className="qa-body">
        <aside className="qa-side">
          <div className="qa-side-group">
            <button type="button" className={`qa-side-item ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>全部</button>
            <button type="button" className={`qa-side-item ${filter === 'pinned' ? 'active' : ''}`} onClick={() => setFilter('pinned')}>收藏</button>
          </div>

          <div className="qa-side-title">分类</div>
          <div className="qa-side-group">
            {categories.length === 0 ? (
              <div className="qa-side-empty">暂无分类</div>
            ) : (
              categories.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`qa-side-item ${filter === c ? 'active' : ''}`}
                  onClick={() => setFilter(c)}
                >
                  {c}
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="qa-grid">
          {filtered.length === 0 ? (
            <div className="qa-empty">
              <div className="t">没有找到匹配的应用</div>
              <div className="d">可以尝试换个关键词，或在设置里开启更多应用。</div>
            </div>
          ) : (
            filtered.map(app => (
              <AppCard
                key={app.meta.id}
                app={app}
                pinned={(pinned || []).includes(app.meta.id)}
                onPin={() => togglePinned(app.meta.id)}
                onOpen={() => navigate(`/apps/${app.meta.id}`)}
              />
            ))
          )}
        </section>
      </div>
    </div>
  )
}
