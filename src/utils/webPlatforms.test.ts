import { describe, expect, test } from 'bun:test'
import { getWebPlatformById, getWebPlatformOptions } from './webPlatforms.js'

describe('Arena web platform registration', () => {
  test('opens the single-model Direct Chat route without claiming a specific model', () => {
    const arena = getWebPlatformById('arena')

    expect(arena?.url).toBe('https://arena.ai/text/direct?model_a=max')
    expect(arena?.description).toContain('choose one available model')
    expect(arena?.description).not.toContain('GPT-6 Sol')
  })

  test('exposes Arena in the web platform selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'arena',
      label: 'Arena.ai',
      description: 'Arena.ai Direct Chat; choose one available model in Arena',
    })
  })
})

describe('Z.ai web platform registration', () => {
  test('uses the stable chat home instead of a conversation-specific URL', () => {
    const zai = getWebPlatformById('zai')

    expect(zai?.url).toBe('https://chat.z.ai/')
    expect(zai?.description).toContain('clean Relay profile')
  })

  test('exposes Z.ai in the web platform selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'zai',
      label: 'Z.ai',
      description: 'Z.ai chat; sign in and open a conversation in the clean Relay profile',
    })
  })
})

describe('Grok web platform registration', () => {
  test('uses the current Grok host without pinning an unverified model', () => {
    const grok = getWebPlatformById('grok')

    expect(grok?.url).toBe('https://grok.com/')
    expect(grok?.description).toContain('choose an available model')
  })

  test('exposes Grok in the shared Web Relay platform selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'grok',
      label: 'Grok',
      description: 'xAI Grok chat; choose an available model in Grok',
    })
  })
})

describe('Google AI Studio web platform registration', () => {
  test('uses the new-chat route as the stable entry point', () => {
    const platform = getWebPlatformById('aistudio')

    expect(platform?.url).toBe('https://aistudio.google.com/prompts/new_chat')
    expect(platform?.description).toContain('sign in with Google')
  })

  test('exposes AI Studio in the shared platform selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'aistudio',
      label: 'Google AI Studio',
      description: 'Google AI Studio; sign in with Google in the clean Relay profile',
    })
  })
})

describe('Perplexity web platform registration', () => {
  test('uses the stable homepage and lets users select the available model', () => {
    const platform = getWebPlatformById('perplexity')

    expect(platform?.url).toBe('https://www.perplexity.ai')
    expect(platform?.description).toContain('Perplexity AI web interface')
  })

  test('exposes Perplexity in the shared Web Relay platform selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'perplexity',
      label: 'Perplexity',
      description: 'Perplexity AI web interface',
    })
  })
})

describe('DeepSeek web platform registration', () => {
  test('uses the stable chat homepage and does not pin an unverified model', () => {
    const platform = getWebPlatformById('deepseek')

    expect(platform?.url).toBe('https://chat.deepseek.com')
    expect(platform?.description).toContain('choose an available model')
  })

  test('exposes DeepSeek in the shared Web Relay platform selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'deepseek',
      label: 'DeepSeek',
      description: 'DeepSeek chat; sign in and choose an available model in the clean Relay profile',
    })
  })
})

describe('Kimi and Qwen web platform registration', () => {
  test('uses the observed public chat homepages without pinning models', () => {
    const kimi = getWebPlatformById('kimi')
    const qwen = getWebPlatformById('qwen')

    expect(kimi?.url).toBe('https://www.kimi.com/')
    expect(kimi?.description).toContain('choose an available model')
    expect(qwen?.url).toBe('https://chat.qwen.ai/')
    expect(qwen?.description).toContain('choose a model available')
  })

  test('exposes Kimi and Qwen in the shared Web Relay selector', () => {
    const options = getWebPlatformOptions()

    expect(options).toContainEqual({
      value: 'kimi',
      label: 'Kimi',
      description: 'Kimi chat; sign in and choose an available model in the clean Relay profile',
    })
    expect(options).toContainEqual({
      value: 'qwen',
      label: 'Qwen',
      description: 'Qwen chat; choose a model available in the clean Relay profile',
    })
  })
})

describe('ChatHub web platform registration', () => {
  test('preserves the requested GLM-5.3 chat URL and conversation id', () => {
    const platform = getWebPlatformById('chathub')

    expect(platform?.url).toBe(
      'https://app.chathub.gg/chat/cloud-glm-5.3?cid=d6fb4088-ad5c-41f2-a513-4658ec1f06de',
    )
    expect(platform?.description).toContain('GLM-5.3')
  })

  test('exposes ChatHub in the shared Web Relay platform selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'chathub',
      label: 'ChatHub',
      description: 'ChatHub GLM-5.3; sign in in each clean Relay profile',
    })
  })
})

describe('ChatX web platform registration', () => {
  test('uses the requested GPT page and leaves model selection to ChatX', () => {
    const platform = getWebPlatformById('chatx')

    expect(platform?.url).toBe('https://chatx.ai/es/gpt')
    expect(platform?.description).toContain('choose an available model in ChatX')
    expect(platform?.description).toContain('Gemini 3.8 Flash may require registration')
  })

  test('exposes ChatX in the shared Web Relay selector', () => {
    expect(getWebPlatformOptions()).toContainEqual({
      value: 'chatx',
      label: 'ChatX',
      description: 'ChatX web chat; choose an available model in ChatX. Gemini 3.8 Flash may require registration',
    })
  })
})
