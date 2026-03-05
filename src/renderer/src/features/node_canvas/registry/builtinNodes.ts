import type { NodeManifest } from './types'

export const builtinNodeManifests: NodeManifest[] = [
  {
    schema_version: '1.0',
    node_id: 'nexa.core.prompt',
    version: '1.0.0',
    display_name: '提示词',
    description: '纯文本提示词节点',
    category: '文本',
    tags: ['text', 'prompt'],
    search_aliases: ['prompt', 'text', '提示词'],
    interface: {
      inputs: [],
      outputs: [{ name: 'text', type: 'string' }],
      params: [{ name: 'text', type: 'text', label: '文本', default: '' }]
    },
    runtime: { kind: 'builtin', entry: 'prompt' },
    permissions: []
  },
  {
    schema_version: '1.0',
    node_id: 'nexa.core.debug.log',
    version: '1.0.0',
    display_name: '日志',
    description: '输出任意值到日志，便于调试',
    category: '调试',
    tags: ['debug'],
    search_aliases: ['log', 'print', '日志'],
    interface: {
      inputs: [{ name: 'in', type: 'any', required: true }],
      outputs: [],
      params: [{ name: 'label', type: 'string', label: '标签', default: 'log' }]
    },
    runtime: { kind: 'builtin', entry: 'log' },
    permissions: []
  },
  {
    schema_version: '1.0',
    node_id: 'nexa.core.http.request',
    version: '1.0.0',
    display_name: 'HTTP 请求',
    description: '请求一个 URL（具体策略由 Runner 决定）',
    category: '输入输出',
    tags: ['http', 'io'],
    search_aliases: ['http', 'fetch', 'request'],
    interface: {
      inputs: [{ name: 'body', type: 'any', required: false }],
      outputs: [{ name: 'response', type: 'any' }],
      params: [
        { name: 'method', type: 'enum', label: '方法', default: 'GET', enumValues: ['GET', 'POST', 'PUT', 'DELETE'] },
        { name: 'url', type: 'string', label: '地址', default: '' },
        { name: 'headers', type: 'json', label: '请求头(JSON)', default: '{}' }
      ]
    },
    runtime: { kind: 'builtin', entry: 'http' },
    permissions: ['net']
  }
]
