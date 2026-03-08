import React, { useMemo, useState } from 'react'
import { Bot, Check, Copy, Sparkles, X } from 'lucide-react'
import type { QuickAppInputImage } from '../../types'
import type { PromptSet } from '../../prompt_library/store'
import { usePromptLibraryStore } from '../../prompt_library/store'
import { uiConfirm, uiPrompt, uiTextViewer } from '../../../ui/dialogStore'
import { uiToast } from '../../../ui/toastStore'
import { chatCompletionsText, type ChatMessage } from '../../../../core/api/chatCompletions'
import { ensureQuickAppImageData } from '../../utils/localImage'
import { buildGeniePolicyPreviewText, useGeniePolicy } from './geniePolicy'

type GenieTemplateSource = 'editor' | 'set'

type GenieSendFlags = {
  model: boolean
  wear_ref: boolean
  pose: boolean
  outfit: boolean
  scene: boolean
  product: boolean
}

function safeJsonExtract(raw: string) {
  const s = String(raw || '').trim()
  if (!s) return ''
  try {
    JSON.parse(s)
    return s
  } catch {
    // try ```json
    const m = s.match(/```json\s*([\s\S]*?)```/i)
    if (m && m[1]) return m[1].trim()

    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) return s.slice(a, b + 1)
    return s
  }
}

function parseGenieResult(raw: string): { agent1Template: string, agent2Template: string, agent3Template: string, notes?: string[] } | null {
  const json = safeJsonExtract(raw)
  try {
    const obj = JSON.parse(json)
    const a1 = String(obj?.agent1Template || '')
    const a2 = String(obj?.agent2Template || '')
    const a3 = String(obj?.agent3Template || '')
    if (!a1.trim() || !a2.trim() || !a3.trim()) return null
    const notes = Array.isArray(obj?.notes)
      ? (obj.notes as any[]).map((x: any) => String(x)).map((s: string) => s.trim()).filter(Boolean).slice(0, 12)
      : undefined
    return { agent1Template: a1, agent2Template: a2, agent3Template: a3, notes }
  } catch {
    return null
  }
}

function buildSystemPrompt(policyText: string) {
  // Keep this stable; user preferences go to user message.
  return String.raw`你是“Nexa 产品图增强”的【提示词精灵】。

目标：根据用户的想法，为同一条工作流生成 3 个【相互配合、上下游接口明确】的 system prompt（角色1/2/3）。

你必须先在脑中建立“工作流契约（Master Spec）”，确保 3 个角色：
- 不重复、不抢活
- 产出格式稳定
- 适配现有的合并方式：角色3模板 + 角色2输出（### **【首图拍摄动作】**） + 角色1输出（产品详细信息提示词）

【强制约束：背景与文字策略（必须写进角色模板中）】
${policyText}

【角色职责定义（必须严格遵守）】
角色1：产品分析师
- 输入：产品角度图 +（可选）佩戴参考/我们的模特
- 输出：仅输出“产品详细信息提示词”内容（中文），固定结构；描述形态、材质、工艺、关键细节；
- 禁止：逐字转写/猜测字母；禁止输出场景/背景设计。

角色2：摄影导演
- 输入：产品角度图 +（可选）我们的模特/服装/场景/姿态/佩戴参考
- 输出：仅输出一个块：### **【首图拍摄动作】**，里面是“首图拍摄动作：”清单（中文、指令化）；
- 禁止：重复角色1的产品细节；禁止写背景颜色锁定（交给角色3）。

角色3：生图执行者（拼装模板）
- 输入：最终会拼入：角色2输出 + 角色1输出
- 输出：一段用于生图的 system prompt（中文），负责：
  - 复刻策略（产品/帽子细节不变化）
  - 背景锁定策略（纯色优先，场景图降权）
  - 文字/Logo 安全策略（小字不可读、禁止新造可读字母）
  - 服装/姿态/镜头距离等执行规则
- 禁止：输出负面提示词（除非用户明确要求）。

【输出格式：只允许输出 JSON】
你必须只输出一个 JSON 对象，不要 markdown，不要解释，不要多余文字。
JSON schema：
{
  "agent1Template": string,
  "agent2Template": string,
  "agent3Template": string,
  "notes": string[]
}
notes 用于简短说明分工与关键策略（不超过 8 条）。`
}

async function pickImageDataUrls(args: {
  productAngles: QuickAppInputImage[]
  slots: Record<string, QuickAppInputImage | null>
  flags: GenieSendFlags
  productAngleCount: number
}) {
  const { productAngles, slots, flags, productAngleCount } = args
  const items: Array<{ label: string, img: QuickAppInputImage }> = []

  if (flags.product) {
    const n = Math.max(0, Math.min(2, Math.floor(Number(productAngleCount) || 0)))
    for (let i = 0; i < Math.min(n, productAngles.length); i++) {
      const img = productAngles[i]
      if (img) items.push({ label: `产品角度图 ${i + 1}`, img })
    }
  }

  const pushSlot = (key: keyof GenieSendFlags, label: string) => {
    if (!flags[key]) return
    const img = slots?.[key as any] as any
    if (img) items.push({ label, img })
  }

  pushSlot('model', '我们的模特')
  pushSlot('wear_ref', '佩戴参考')
  pushSlot('pose', '参考姿态')
  pushSlot('outfit', '服装参考')
  pushSlot('scene', '场景/光影参考')

  const ensured = await Promise.all(items.map(async (it) => {
    const x = await ensureQuickAppImageData(it.img)
    const url = String(x.sourceDataUrl || x.dataUrl || '').trim()
    return url ? { label: it.label, url } : null
  }))

  return ensured.filter(Boolean) as Array<{ label: string, url: string }>
}

export default function ProductShotPromptGenie(props: {
  open: boolean
  onClose: () => void
  disabled?: boolean

  providerId: string | null
  baseUrl: string
  apiKey: string
  model: string

  templateSource: GenieTemplateSource
  onTemplateSourceChange: (v: GenieTemplateSource) => void

  useImages: boolean
  onUseImagesChange: (v: boolean) => void
  flags: GenieSendFlags
  onFlagsChange: (patch: Partial<GenieSendFlags>) => void
  productAngleCount: number
  onProductAngleCountChange: (v: number) => void

  userIdea: string
  onUserIdeaChange: (v: string) => void

  // templates to use as the "base" (from editor)
  editorTemplates: { agent1Template: string, agent2Template: string, agent3Template: string }
  // currently selected set in library
  activeSet: PromptSet | null

  productAngles: QuickAppInputImage[]
  slots: Record<string, QuickAppInputImage | null>

  onApplyAll: (t: { agent1Template: string, agent2Template: string, agent3Template: string }) => void
}) {
  const {
    open,
    onClose,
    disabled,
    providerId,
    baseUrl,
    apiKey,
    model,
    templateSource,
    onTemplateSourceChange,
    useImages,
    onUseImagesChange,
    flags,
    onFlagsChange,
    productAngleCount,
    onProductAngleCountChange,
    userIdea,
    onUserIdeaChange,
    editorTemplates,
    activeSet,
    productAngles,
    slots,
    onApplyAll
  } = props

  const addSet = usePromptLibraryStore(s => s.addSet)
  const updateSet = usePromptLibraryStore(s => s.updateSet)
  const setActive = usePromptLibraryStore(s => s.setActive)

  const [busy, setBusy] = useState(false)
  const [raw, setRaw] = useState('')
  const parsed = useMemo(() => parseGenieResult(raw), [raw])

  const { policy } = useGeniePolicy()
  const policyText = useMemo(() => buildGeniePolicyPreviewText(policy), [policy])

  const baseTemplates = useMemo(() => {
    if (templateSource === 'set' && activeSet) {
      return {
        agent1Template: String(activeSet.agent1Template || ''),
        agent2Template: String(activeSet.agent2Template || ''),
        agent3Template: String(activeSet.agent3Template || '')
      }
    }
    return {
      agent1Template: String(editorTemplates.agent1Template || ''),
      agent2Template: String(editorTemplates.agent2Template || ''),
      agent3Template: String(editorTemplates.agent3Template || '')
    }
  }, [templateSource, activeSet, editorTemplates])

  const imageSendCount = useMemo(() => {
    let n = 0
    if (useImages) {
      if (flags.product) n += Math.min(Math.max(0, productAngleCount), 2, productAngles.length)
      if (flags.model && slots?.model) n += 1
      if (flags.wear_ref && slots?.wear_ref) n += 1
      if (flags.pose && slots?.pose) n += 1
      if (flags.outfit && slots?.outfit) n += 1
      if (flags.scene && slots?.scene) n += 1
    }
    return n
  }, [useImages, flags, productAngleCount, productAngles.length, slots])

  const canRun = Boolean(providerId && baseUrl && apiKey && model)

  const run = async () => {
    if (!canRun) {
      uiToast('info', '请先在设置中配置提示词模型/Key')
      return
    }
    const idea = String(userIdea || '').trim()
    if (!idea) {
      uiToast('info', '请先输入你的想法（你希望这套角色怎么更好用）')
      return
    }

    setBusy(true)
    try {
      const imgs = useImages
        ? await pickImageDataUrls({ productAngles, slots, flags, productAngleCount })
        : []

      const userText = [
        `用户想法：\n${idea}`,
        `\n模板来源：${templateSource === 'set' ? '提示词库模板组' : '当前编辑内容'}`,
        `\n当前模板（供你在此基础上优化重写，保持接口一致）：\n[角色1模板]\n${baseTemplates.agent1Template}\n\n[角色2模板]\n${baseTemplates.agent2Template}\n\n[角色3模板]\n${baseTemplates.agent3Template}`,
        imgs.length ? `\n\n参考图：见后续图片（共 ${imgs.length} 张）。注意：图片只用于帮助你理解“分工与约束”，你生成的是 system prompt，不是最终生图。` : ''
      ].join('\n')

      const makeMessages = (withImages: boolean) => {
        const userContent: any = (withImages && imgs.length)
          ? [{ type: 'text', text: userText }, ...imgs.flatMap(it => ([
            { type: 'text', text: `【${it.label}】` },
            { type: 'image_url', image_url: { url: it.url } }
          ]))]
          : userText

        const messages: ChatMessage[] = [
          { role: 'system', content: buildSystemPrompt(policyText) },
          { role: 'user', content: userContent }
        ]
        return messages
      }

      const post = async (withImages: boolean) => {
        return await chatCompletionsText({
          baseUrl,
          apiKey,
          model,
          messages: makeMessages(withImages),
          temperature: 0.35,
          maxTokens: 2600
        })
      }

      let text = ''
      try {
        text = await post(Boolean(imgs.length))
      } catch (e: any) {
        const emsg = String(e?.message || '')
        if (imgs.length && /image|vision|multimodal|content\s*must\s*be\s*a\s*string/i.test(emsg)) {
          uiToast('info', '当前模型不支持图片输入：已自动降级为纯文本生成')
          text = await post(false)
        } else {
          throw e
        }
      }

      setRaw(String(text || '').trim())
      const ok = parseGenieResult(text)
      if (!ok) uiToast('info', '已生成，但解析失败：你可以在下方查看原文并手动复制')
    } catch (e: any) {
      uiToast('error', e?.message || '生成失败')
    } finally {
      setBusy(false)
    }
  }

  const handleApply = () => {
    if (!parsed) return
    onApplyAll(parsed)
    uiToast('success', '已写入三个角色模板')
  }

  const handleSaveNew = async () => {
    if (!parsed) return
    const name = await uiPrompt('模板组名称', { title: '保存为新模板组', placeholder: '例如：帽子/成熟气质/纯色背景' })
    if (!name) return
    const category = await uiPrompt('分类（可选）', { title: '保存为新模板组', placeholder: '例如：帽子 / 饰品 / 袜子' })
    const created = addSet({
      appId: 'product_shot',
      name,
      category: category || undefined,
      agent1Template: parsed.agent1Template,
      agent2Template: parsed.agent2Template,
      agent3Template: parsed.agent3Template
    } as any)
    setActive('product_shot', created.id)
    uiToast('success', '已保存为新模板组')
  }

  const handleOverwrite = async () => {
    if (!parsed) return
    if (!activeSet?.id) {
      uiToast('info', '请先选择一个模板组再覆盖')
      return
    }
    const ok = await uiConfirm(`覆盖保存模板组「${String(activeSet.name || '').trim() || '未命名'}」？`, '覆盖保存')
    if (!ok) return
    updateSet(activeSet.id, {
      agent1Template: parsed.agent1Template,
      agent2Template: parsed.agent2Template,
      agent3Template: parsed.agent3Template
    } as any)
    uiToast('success', '已覆盖保存')
  }

  if (!open) return null

  return (
    <div className="ps-genie-modal" onMouseDown={onClose}>
      <div className="ps-genie-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ps-genie-head">
          <div className="ps-genie-title">
            <Bot size={16} /> 提示词精灵
          </div>
          <button className="ps-genie-close" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="ps-genie-body">
          <div className="ps-genie-row">
            <div className="k">模板来源</div>
            <div className="v">
              <select
                className="ps-select"
                value={templateSource}
                onChange={(e) => onTemplateSourceChange(String(e.target.value) as any)}
                disabled={Boolean(disabled) || busy}
                title={templateSource === 'set' && !activeSet ? '当前未选择模板组，将回退到当前编辑内容' : ''}
              >
                <option value="editor">当前编辑内容</option>
                <option value="set">当前选中模板组</option>
              </select>
            </div>
          </div>

          <div className="ps-genie-row" style={{ marginTop: 10 }}>
            <div className="k">参考图</div>
            <div className="v" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label className="ps-genie-check">
                <input
                  type="checkbox"
                  checked={useImages}
                  onChange={(e) => onUseImagesChange(Boolean(e.target.checked))}
                  disabled={Boolean(disabled) || busy}
                />
                发送参考图（更准/更费）
              </label>
              <div className="ps-genie-hint">将发送 {imageSendCount} 张</div>
            </div>
          </div>

          {useImages ? (
            <div className="ps-genie-grid">
              <label className="ps-genie-check"><input type="checkbox" checked={flags.model} onChange={(e) => onFlagsChange({ model: Boolean(e.target.checked) })} disabled={busy} />我们的模特</label>
              <label className="ps-genie-check"><input type="checkbox" checked={flags.wear_ref} onChange={(e) => onFlagsChange({ wear_ref: Boolean(e.target.checked) })} disabled={busy} />佩戴参考</label>
              <label className="ps-genie-check"><input type="checkbox" checked={flags.pose} onChange={(e) => onFlagsChange({ pose: Boolean(e.target.checked) })} disabled={busy} />姿态</label>
              <label className="ps-genie-check"><input type="checkbox" checked={flags.outfit} onChange={(e) => onFlagsChange({ outfit: Boolean(e.target.checked) })} disabled={busy} />服装</label>
              <label className="ps-genie-check"><input type="checkbox" checked={flags.scene} onChange={(e) => onFlagsChange({ scene: Boolean(e.target.checked) })} disabled={busy} />场景/光影</label>

              <div className="ps-genie-inline">
                <label className="ps-genie-check" style={{ marginRight: 8 }}>
                  <input type="checkbox" checked={flags.product} onChange={(e) => onFlagsChange({ product: Boolean(e.target.checked) })} disabled={busy} />产品角度
                </label>
                <select
                  className="ps-select"
                  value={String(productAngleCount)}
                  onChange={(e) => onProductAngleCountChange(Number(e.target.value) || 0)}
                  disabled={busy || !flags.product}
                  style={{ height: 34 }}
                >
                  <option value="0">0 张</option>
                  <option value="1">1 张</option>
                  <option value="2">2 张</option>
                </select>
              </div>
            </div>
          ) : null}

          <div className="ps-genie-idea">
            <div className="t">你希望这套角色怎么更好用？</div>
            <textarea
              className="ps-genie-text"
              value={userIdea}
              onChange={(e) => onUserIdeaChange(e.target.value)}
              placeholder="例如：人物更成熟、动作更克制；背景必须纯色 #ededed；小吊牌字母保留但不可读；更强调高颅顶/显脸小；不要夸张姿态..."
              disabled={Boolean(disabled) || busy}
              spellCheck={false}
            />
          </div>

          <div className="ps-genie-actions">
            <button className="ps-runbtn" type="button" onClick={() => void run()} disabled={Boolean(disabled) || busy}>
              <Sparkles size={16} /> {busy ? '生成中...' : '生成三角色模板'}
            </button>
            <button className="ps-runbtn ghost" type="button" onClick={handleApply} disabled={!parsed || busy}>
              <Check size={16} /> 一键写入
            </button>
            <button className="ps-runbtn ghost" type="button" onClick={() => uiTextViewer(String(raw || ''), { title: '原始输出', size: 'lg' })} disabled={!raw.trim() || busy}>
              <Copy size={16} /> 查看原文
            </button>
          </div>

          {parsed?.notes?.length ? (
            <div className="ps-genie-notes">
              {parsed.notes.map((n, i) => (
                <div key={`${i}_${n}`} className="ps-genie-note">- {n}</div>
              ))}
            </div>
          ) : null}

          <div className="ps-genie-out">
            <div className="ps-genie-out-head">
              <div className="t">生成结果（可编辑后再写入）</div>
              <div className="a">
                <button className="ps-mini" type="button" onClick={() => {
                  if (!parsed) return
                  const text = JSON.stringify(parsed, null, 2)
                  navigator.clipboard?.writeText
                    ? navigator.clipboard.writeText(text).then(() => uiToast('success', '已复制')).catch(() => uiToast('error', '复制失败'))
                    : uiTextViewer(text, { title: '复制内容', size: 'lg' })
                }} disabled={!parsed || busy}>
                  复制JSON
                </button>
                <button className="ps-mini" type="button" onClick={() => void handleSaveNew()} disabled={!parsed || busy}>
                  保存为新模板组
                </button>
                <button className="ps-mini" type="button" onClick={() => void handleOverwrite()} disabled={!parsed || busy}>
                  覆盖当前模板组
                </button>
              </div>
            </div>

            <textarea
              className="ps-genie-raw"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="生成结果会显示在这里（JSON）"
              spellCheck={false}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
