import type { QuickAppWorkflow } from '../../types'

const workflow: QuickAppWorkflow = {
  meta: {
    id: 'product_shot',
    name: '产品图增强',
    desc: '把参考图处理成电商产品图（更干净的背景与光影）',
    category: '电商',
    keywords: ['产品图', '电商', '背景', '棚拍', '光影'],
    kind: 'image',
    requiresImage: true,
    requiresPrompt: true
  },
  api: {
    keyUsage: 'image',
    modelField: 'selectedImageModel'
  },
  imageOptions: {
    n: 1,
    size: '1024x1024'
  },
  buildPrompt: (input) => {
    const p = String(input.prompt || '').trim()
    return [
      '你将把用户上传的图片处理为“电商产品图”。',
      '要求：主体居中清晰，细节锐利，材质真实；背景干净或浅色渐变；光影自然高级；避免过度涂抹。',
      p ? `额外要求：\n${p}` : ''
    ].filter(Boolean).join('\n\n')
  }
}

export default workflow
