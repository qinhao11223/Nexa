export type QuickAppKind = 'image'

export type QuickAppApiKeyUsage = 'image' | 'prompt' | 'translate' | 'video' | 'models'

export type QuickAppMeta = {
  id: string
  name: string
  desc?: string
  category?: string
  keywords?: string[]
  kind: QuickAppKind
  requiresImage?: boolean
  requiresPrompt?: boolean
}

export type QuickAppInputImage = {
  dataUrl: string
  base64: string
  name: string
}

export type QuickAppInput = {
  prompt: string
  images: QuickAppInputImage[]
}

export type QuickAppContext = {
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  saveDir?: string
}

export type QuickAppOutput = {
  images?: string[]
  text?: string
}

export type QuickAppWorkflow = {
  meta: QuickAppMeta

  api: {
    keyUsage: QuickAppApiKeyUsage
    modelField: 'selectedImageModel' | 'selectedPromptModel' | 'selectedTranslateModel' | 'selectedVideoModel'
  }

  // A lightweight way to define per-app behavior without building custom UI.
  // You can evolve this later into a full workflow DSL.
  buildPrompt: (input: QuickAppInput, ctx: QuickAppContext) => string

  // Optional: override default runner behavior.
  run?: (input: QuickAppInput, ctx: QuickAppContext) => Promise<QuickAppOutput>

  // Default runner options (mostly for image generation).
  imageOptions?: {
    n?: number
    size?: string
    aspectRatio?: string
    imageSize?: string
  }
}
