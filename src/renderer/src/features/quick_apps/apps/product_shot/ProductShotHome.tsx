import React, { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot, BookText, Image as ImageIcon, ListChecks, Plus, Sparkles, Star } from 'lucide-react'
import { uiConfirm, uiPrompt } from '../../../ui/dialogStore'
import { uiToast } from '../../../ui/toastStore'
import { usePromptLibraryStore } from '../../prompt_library/store'
import ProductShotGeniePolicyModal from './ProductShotGeniePolicyModal'
import '../../styles/quickApps.css'
import { fileToQuickAppInputImage } from '../../utils/imageOptimize'

function norm(s: string) {
  return String(s || '').trim().toLowerCase()
}

function shortDate(ts: number) {
  const d = new Date(Number(ts || 0) || Date.now())
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${m}-${dd}`
}

export default function ProductShotHome() {
  const nav = useNavigate()
  const sets = usePromptLibraryStore(s => s.sets)
  const addSet = usePromptLibraryStore(s => s.addSet)
  const updateSet = usePromptLibraryStore(s => s.updateSet)
  const toggleFavorite = usePromptLibraryStore(s => s.toggleFavorite)
  const setActiveSet = usePromptLibraryStore(s => s.setActive)

  const [q, setQ] = React.useState('')
  const [policyOpen, setPolicyOpen] = React.useState(false)

  const pickCoverFile = async (): Promise<File | null> => {
    return await new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = () => {
        const f = (input.files && input.files[0]) ? input.files[0] : null
        resolve(f)
      }
      input.click()
    })
  }

  const cacheCoverToLocal = async (dataUrl: string, setId: string): Promise<string> => {
    const api = (window as any).nexaAPI
    const src = String(dataUrl || '')
    if (!api?.downloadImage || !/^data:/i.test(src)) return src
    try {
      const saved = await api.downloadImage({ url: src, saveDir: 'cache/covers/product_shot', fileName: `qa_ps_cover_${setId}_${Date.now()}` })
      const localPath = String(saved?.localPath || '')
      if (saved?.success && /^nexa:\/\/local\?path=/i.test(localPath)) return localPath
    } catch {
      // ignore
    }
    return src
  }

  const setCoverForSet = async (setId: string) => {
    try {
      const f = await pickCoverFile()
      if (!f) return
      const img = await fileToQuickAppInputImage(f, { maxDim: 720, jpegQuality: 0.84 })
      if (!img?.dataUrl) {
        uiToast('error', '读取封面失败')
        return
      }
      const coverUrl = await cacheCoverToLocal(img.dataUrl, setId)
      updateSet(setId, { coverUrl } as any)
      uiToast('success', '已设置封面')
    } catch (e: any) {
      uiToast('error', e?.message || '设置封面失败')
    }
  }

  const appSets = useMemo(() => {
    const list = (sets || []).filter(s => s.appId === 'product_shot')
    const nq = norm(q)
    return list
      .filter(s => {
        if (!nq) return true
        const hay = [s.name, s.category || '', ...(s.tags || [])].map(norm).join(' ')
        return hay.includes(nq)
      })
      .slice()
      .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.updatedAt - a.updatedAt)
  }, [sets, q])

  const openStudio = (setId?: string) => {
    if (setId) setActiveSet('product_shot', setId)
    const sp = new URLSearchParams()
    sp.set('view', 'studio')
    if (setId) sp.set('set', setId)
    nav(`/apps/product_shot?${sp.toString()}`)
  }

  const goPrompts = () => {
    const back = encodeURIComponent('/apps/product_shot')
    nav(`/apps/prompts?back=${back}`)
  }

  const goTasks = () => {
    const back = encodeURIComponent('/apps/product_shot')
    nav(`/apps/tasks?back=${back}`)
  }

  const createAndOpen = async () => {
    const name = await uiPrompt('模板组名称', { title: '新建模板组', placeholder: '例如：帽子（纯色背景）' })
    if (!name) return
    const category = await uiPrompt('分类（可选）', { title: '新建模板组', placeholder: '例如：帽子 / 饰品 / 袜子' })
    const created = addSet({
      appId: 'product_shot',
      name,
      category: category || undefined,
      agent1Template: '',
      agent2Template: '',
      agent3Template: '',
      genRatio: '1:1',
      genRes: '1K'
    } as any)
    setActiveSet('product_shot', created.id)

    const wantCover = await uiConfirm('为这个模板组设置封面？（可跳过）', '设置封面')
    if (wantCover) {
      await setCoverForSet(created.id)
    }

    uiToast('success', '已创建模板组')
    openStudio(created.id)
  }

  const placeholders = useMemo(() => Array.from({ length: 12 }).map((_, i) => `ph_${i}`), [])

  return (
    <div className="qa-run ps-run">
      <div className="qa-run-head">
        <Link to="/apps" className="qa-back"><ArrowLeft size={18} /> 返回应用</Link>
        <div className="qa-run-title">
          <div className="n">产品图增强</div>
          <div className="d">选择一个模板组开始工作；也可以继续上次的编辑状态。</div>
        </div>
      </div>

      <div className="ps-home">
        <div className="ps-home-toolbar">
          <div className="ps-home-search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模板组..." spellCheck={false} />
          </div>

          <div className="ps-home-actions">
            <button className="ps-home-iconbtn" type="button" onClick={() => setPolicyOpen(true)} title="提示词精灵关键策略">
              <Bot size={16} />
            </button>
            <button className="ps-home-btn" type="button" onClick={() => openStudio()} title="打开工作台（保持上次输入）">
              <Sparkles size={16} /> 继续上次
            </button>
            <button className="ps-home-btn" type="button" onClick={() => void createAndOpen()}>
              <Plus size={16} /> 新建模板组
            </button>
            <button className="ps-home-btn ghost" type="button" onClick={goPrompts}>
              <BookText size={16} /> 提示词库
            </button>
            <button className="ps-home-btn ghost" type="button" onClick={goTasks}>
              <ListChecks size={16} /> 任务列表
            </button>
          </div>
        </div>

        <ProductShotGeniePolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />

        <div className="ps-home-grid" role="list">
          {appSets.length === 0 ? (
            placeholders.map(id => (
              <div key={id} className="qa-card ps-set-card placeholder" role="listitem" aria-hidden="true">
                <div className="qa-card-cover ps-set-cover" />
                <div className="qa-card-head">
                  <div className="ps-set-sk sk" />
                  <div className="ps-set-sk2 sk" />
                </div>
                <div className="qa-card-desc ps-set-sk3 sk" />
                <div className="qa-card-foot">
                  <div className="qa-card-cat ps-set-sk4 sk" />
                </div>
              </div>
            ))
          ) : (
            appSets.map(s => {
              const category = String(s.category || '').trim()
              const name = String(s.name || '').trim() || '未命名'
              const coverUrl = String((s as any)?.coverUrl || '').trim()
              const sub = `${category || '未分类'} · 更新 ${shortDate(s.updatedAt)}`
              return (
                <div
                  key={s.id}
                  className="qa-card ps-set-card"
                  role="button"
                  tabIndex={0}
                  title={category ? `${category}/${name}` : name}
                  onClick={() => openStudio(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openStudio(s.id)
                    }
                  }}
                >
                  <div className={`qa-card-cover ps-set-cover ${coverUrl ? 'has-img' : ''}`} aria-hidden="true">
                    {coverUrl ? <img src={coverUrl} alt="" draggable={false} loading="lazy" /> : null}
                    <div className="qa-card-cover-badge">{category || '未分类'}</div>
                    <button
                      type="button"
                      className="ps-set-coverbtn"
                      title={coverUrl ? '更换封面' : '设置封面'}
                      aria-label={coverUrl ? '更换封面' : '设置封面'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void setCoverForSet(s.id)
                      }}
                    >
                      <ImageIcon size={14} />
                    </button>
                  </div>

                  <div className="qa-card-head">
                    <div className="qa-card-name">{name}</div>
                    <button
                      type="button"
                      className={`qa-card-pin ${s.favorite ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFavorite(s.id)
                      }}
                      title={s.favorite ? '取消收藏' : '收藏'}
                      aria-label={s.favorite ? '取消收藏' : '收藏'}
                    >
                      <Star size={16} />
                    </button>
                  </div>

                  <div className="qa-card-desc" title={sub}>{sub}</div>

                  <div className="qa-card-foot">
                    <div className="qa-card-cat">模板组</div>
                    <div className="ps-set-meta">{shortDate(s.updatedAt)}</div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
