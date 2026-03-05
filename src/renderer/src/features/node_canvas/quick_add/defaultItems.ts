import { FileUp, Globe, Image as ImageIcon, Music, StickyNote, Terminal, Type, Video } from 'lucide-react'
import type { QuickAddEntry } from './types'

export function buildDefaultCommonEntries(args: {
  resolveNode: (nodeId: string) => { enabled: boolean; subtitle?: string }
}): QuickAddEntry[] {
  const { resolveNode } = args

  const node = (nodeId: string, title: string, icon: any, desc?: string): QuickAddEntry => {
    const r = resolveNode(nodeId)
    return {
      key: `node:${nodeId}`,
      kind: 'node',
      group: 'common',
      nodeId,
      title,
      subtitle: r.subtitle,
      description: desc,
      icon,
      enabled: r.enabled
    }
  }

  const action = (actionId: 'upload_assets', title: string, icon: any, desc?: string): QuickAddEntry => {
    return {
      key: `action:${actionId}`,
      kind: 'action',
      group: 'resource',
      actionId,
      title,
      subtitle: '选择文件',
      description: desc,
      icon,
      enabled: true
    }
  }

  return [
    node('nexa.custom.text', '文本', Type, '输入一段文字并输出'),
    node('nexa.custom.asset.image', '图片', ImageIcon, '图片资源节点'),
    node('nexa.custom.asset.video', '视频', Video, '视频资源节点'),
    node('nexa.custom.asset.audio', '音频', Music, '音频资源节点'),
    action('upload_assets', '上传资源', FileUp, '上传图片/视频/音频/文件'),
    node('nexa.core.debug.log', '日志', Terminal, '输出任意值到日志'),
    node('nexa.core.http.request', 'HTTP 请求', Globe, '请求一个 URL'),
    node('nexa.custom.note', '注释', StickyNote, '便签/注释节点')
  ]
}
