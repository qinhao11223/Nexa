import React from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Image as ImageIcon, Music, PencilLine, Video, Wand2 } from 'lucide-react'
import type { CanvasNodeData } from '../../registry/types'
import { useWorkflowStore } from '../../store/workflowStore'

type CanvasNode = Node<CanvasNodeData, 'text'>

export default function TextNode(props: NodeProps<CanvasNode>) {
  const { id, data } = props
  const setNodeParamLive = useWorkflowStore(s => s.setNodeParamLive)
  const commitNodeParam = useWorkflowStore(s => s.commitNodeParam)

  const text = typeof data.params?.text === 'string' ? (data.params.text as string) : ''
  const lastCommitted = React.useRef(text)
  const [editing, setEditing] = React.useState(false)
  const taRef = React.useRef<HTMLTextAreaElement | null>(null)

  React.useEffect(() => {
    lastCommitted.current = text
  }, [id])

  React.useEffect(() => {
    if (!editing) return
    const t = window.setTimeout(() => taRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [editing])

  const commit = () => {
    const cur = typeof (props.data as any)?.params?.text === 'string' ? String((props.data as any).params.text) : ''
    if (cur !== lastCommitted.current) {
      commitNodeParam(id, 'text', cur)
      lastCommitted.current = cur
    }
  }

  return (
    <div className="nexa-aix-text-node">
      <div className="nexa-aix-text-node-title">Text</div>

      <div className="nexa-aix-text-card">
        <div className="nexa-aix-text-hint">尝试:</div>

        <button
          type="button"
          className="nexa-aix-text-item active nodrag"
          onClick={() => setEditing(true)}
        >
          <span className="ic"><PencilLine size={16} /></span>
          <span className="lb">自己编写内容</span>
        </button>

        <button type="button" className="nexa-aix-text-item disabled nodrag" disabled>
          <span className="ic"><Wand2 size={16} /></span>
          <span className="lb">文生图</span>
        </button>

        <button type="button" className="nexa-aix-text-item disabled nodrag" disabled>
          <span className="ic"><Video size={16} /></span>
          <span className="lb">文生视频</span>
        </button>

        <button type="button" className="nexa-aix-text-item disabled nodrag" disabled>
          <span className="ic"><Music size={16} /></span>
          <span className="lb">文生音乐</span>
        </button>

        <button type="button" className="nexa-aix-text-item disabled nodrag" disabled>
          <span className="ic"><ImageIcon size={16} /></span>
          <span className="lb">图片反推提示词</span>
        </button>

        {editing && (
          <div className="nexa-aix-text-editor-wrap nodrag">
            <textarea
              ref={taRef}
              className="nexa-aix-text-editor"
              value={text}
              onChange={(e) => setNodeParamLive(id, 'text', e.target.value)}
              onBlur={() => {
                commit()
                setEditing(false)
              }}
              placeholder="这里输入文字"
            />
            <div className="nexa-aix-text-editor-tip">点击空白处或失焦自动保存</div>
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left} id="in:in" className="nexa-plus-handle" />
      <Handle type="source" position={Position.Right} id="out:text" className="nexa-plus-handle" />
    </div>
  )
}
