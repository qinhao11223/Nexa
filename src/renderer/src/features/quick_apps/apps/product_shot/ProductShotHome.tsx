import React, { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot, BookText, Check, FolderOpen, Download, Image as ImageIcon, ListChecks, Plus, Sparkles, Star, Trash2, X } from 'lucide-react'
import { uiConfirm, uiPrompt } from '../../../ui/dialogStore'
import { uiToast } from '../../../ui/toastStore'
import { usePromptLibraryStore } from '../../prompt_library/store'
import { downloadJson, exportPromptSetV1, makeUniqueFileName, makeUniqueImportedName, parsePromptSetImports, pickJsonFiles } from '../../prompt_library/transfer'
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
  const removeSet = usePromptLibraryStore(s => s.removeSet)

  const [q, setQ] = React.useState('')
  const [policyOpen, setPolicyOpen] = React.useState(false)
  const [selecting, setSelecting] = React.useState(false)
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])

  const isSelected = (id: string) => selectedIds.includes(id)
  const toggleSelected = (id: string) => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [id, ...prev]))
  }

  const exitSelecting = () => {
    setSelecting(false)
    setSelectedIds([])
  }

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

  const importSets = async () => {
    try {
      const files = await pickJsonFiles(true)
      if (files.length === 0) return
      let imported: any[] = []
      for (const f of files) {
        try {
          const text = await f.text()
          imported = imported.concat(parsePromptSetImports(text))
        } catch {
          // ignore invalid file
        }
      }
      const list = imported.filter(Boolean)
      if (list.length === 0) {
        uiToast('error', '导入失败：未识别到有效模板组 JSON')
        return
      }

      const existing = (sets || []).filter(s => s.appId === 'product_shot').slice()
      let added = 0
      for (const it of list) {
        const cat = String(it.category || '').trim() || undefined
        const name = makeUniqueImportedName(existing, String(it.name || ''), cat)
        const created = addSet({
          appId: 'product_shot',
          name,
          category: cat,
          tags: Array.isArray(it.tags) ? it.tags : undefined,
          agent1Template: String(it.agent1Template || ''),
          agent2Template: String(it.agent2Template || ''),
          agent3Template: String(it.agent3Template || ''),
          agent1Model: String(it.agent1Model || ''),
          agent2Model: String(it.agent2Model || ''),
          genModel: String(it.genModel || ''),
          genRatio: String(it.genRatio || ''),
          genRes: String(it.genRes || '')
        } as any)
        existing.unshift(created as any)
        added += 1
      }
      uiToast('success', `已导入 ${added} 个模板组`)
    } catch (e: any) {
      uiToast('error', e?.message || '导入失败')
    }
  }

  const exportSelected = async () => {
    const ids = selectedIds.slice().filter(Boolean)
    if (ids.length === 0) return
    const map: Record<string, any> = {}
    for (const s of (sets || []).filter(x => x.appId === 'product_shot')) map[s.id] = s
    const picked = ids.map(id => map[id]).filter(Boolean)
    if (picked.length === 0) return

    const used = new Set<string>()
    for (const s of picked) {
      const fileName = makeUniqueFileName(String(s.name || '模板组'), used)
      downloadJson(fileName, exportPromptSetV1(s))
      // allow multiple downloads
      await new Promise(r => window.setTimeout(r, 120))
    }
    uiToast('success', `已导出 ${picked.length} 个 JSON`)
  }

  const deleteSelected = async () => {
    const ids = selectedIds.slice().filter(Boolean)
    if (ids.length === 0) return
    const ok = await uiConfirm(`确定删除选中的 ${ids.length} 个模板组？此操作不可撤销。`, '删除')
    if (!ok) return
    for (const id of ids) removeSet(id)
    uiToast('success', `已删除 ${ids.length} 个模板组`)
    exitSelecting()
  }

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
            {selecting ? (
              <>
                <button className="ps-home-btn ghost" type="button" onClick={() => void importSets()} title="导入模板组 JSON">
                  <FolderOpen size={16} /> 导入模板组
                </button>
                <button className="ps-home-btn ghost" type="button" onClick={() => void exportSelected()} disabled={selectedIds.length === 0} title="导出选中模板组为 JSON">
                  <Download size={16} /> 导出JSON（{selectedIds.length}）
                </button>
                <button className="ps-home-btn danger" type="button" onClick={() => void deleteSelected()} disabled={selectedIds.length === 0} title="删除选中模板组">
                  <Trash2 size={16} /> 删除（{selectedIds.length}）
                </button>
                <button className="ps-home-btn ghost" type="button" onClick={exitSelecting} title="退出选择模式">
                  <X size={16} /> 取消
                </button>
              </>
            ) : (
              <>
                <button className="ps-home-iconbtn" type="button" onClick={() => setPolicyOpen(true)} title="提示词精灵关键策略">
                  <Bot size={16} />
                </button>
                <button className="ps-home-btn" type="button" onClick={() => openStudio()} title="打开工作台（保持上次输入）">
                  <Sparkles size={16} /> 继续上次
                </button>
                <button className="ps-home-btn" type="button" onClick={() => void createAndOpen()}>
                  <Plus size={16} /> 新建模板组
                </button>
                <button className="ps-home-btn ghost" type="button" onClick={() => { setSelecting(true); setSelectedIds([]) }} title="选择多个模板组进行导出/删除">
                  <Check size={16} /> 选择
                </button>
                <button className="ps-home-btn ghost" type="button" onClick={goPrompts}>
                  <BookText size={16} /> 提示词库
                </button>
                <button className="ps-home-btn ghost" type="button" onClick={goTasks}>
                  <ListChecks size={16} /> 任务列表
                </button>
              </>
            )}
          </div>
        </div>

        <ProductShotGeniePolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />

        <div className="ps-home-grid" role="list">
          {appSets.length === 0 ? (
            <div className="qa-empty ps-home-empty" role="listitem">
              <div className="t">还没有模板组</div>
              <div className="d">点击右上角“新建模板组”，或用“选择”进入后导入 JSON。</div>
            </div>
          ) : (
            appSets.map(s => {
              const category = String(s.category || '').trim()
              const name = String(s.name || '').trim() || '未命名'
              const coverUrl = String((s as any)?.coverUrl || '').trim()
              const sub = `${category || '未分类'} · 更新 ${shortDate(s.updatedAt)}`
              const selected = selecting && isSelected(s.id)
              return (
                <div
                  key={s.id}
                  className={`qa-card ps-set-card ${selected ? 'selected' : ''} ${selecting ? 'selecting' : ''}`}
                  role="button"
                  tabIndex={0}
                  title={category ? `${category}/${name}` : name}
                  onClick={() => {
                    if (selecting) toggleSelected(s.id)
                    else openStudio(s.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (selecting) toggleSelected(s.id)
                      else openStudio(s.id)
                    }
                  }}
                >
                  <div className={`qa-card-cover ps-set-cover ${coverUrl ? 'has-img' : ''}`} aria-hidden="true">
                    {coverUrl ? <img src={coverUrl} alt="" draggable={false} loading="lazy" /> : null}
                    <div className="qa-card-cover-badge">{category || '未分类'}</div>
                    {selecting ? (
                      <div className={`ps-set-check ${selected ? 'on' : ''}`} aria-hidden="true">
                        {selected ? <Check size={16} /> : null}
                      </div>
                    ) : null}
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
