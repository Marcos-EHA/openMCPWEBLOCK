// Web platforms supported by MCP SuperAssistant
export interface WebPlatform {
  id: string;
  name: string;
  url: string;
  description: string;
  icon?: string;
}

export const WEB_PLATFORMS: WebPlatform[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chat.openai.com',
    description: 'OpenAI\'s ChatGPT web interface'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    description: 'Google\'s Gemini AI web interface'
  },
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com/',
    description: 'xAI Grok chat; choose an available model in Grok'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    url: 'https://www.perplexity.ai',
    description: 'Perplexity AI web interface'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    description: 'DeepSeek chat; sign in and choose an available model in the clean Relay profile'
  },
  {
    id: 'kimi',
    name: 'Kimi',
    url: 'https://www.kimi.com/',
    description: 'Kimi chat; sign in and choose an available model in the clean Relay profile'
  },
  {
    id: 'qwen',
    name: 'Qwen',
    url: 'https://chat.qwen.ai/',
    description: 'Qwen chat; choose a model available in the clean Relay profile'
  },
  {
    id: 'chathub',
    name: 'ChatHub',
    url: 'https://app.chathub.gg/chat/cloud-glm-5.3?cid=d6fb4088-ad5c-41f2-a513-4658ec1f06de',
    description: 'ChatHub GLM-5.3; sign in in each clean Relay profile'
  },
  {
    id: 'chatx',
    name: 'ChatX',
    url: 'https://chatx.ai/es/gpt',
    description: 'ChatX web chat; choose an available model in ChatX. Gemini 3.8 Flash may require registration'
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    description: 'Anthropic\'s Claude web interface'
  },
  {
    id: 'arena',
    name: 'Arena.ai',
    url: 'https://arena.ai/text/direct?model_a=max',
    description: 'Arena.ai Direct Chat; choose one available model in Arena'
  },
  {
    id: 'zai',
    name: 'Z.ai',
    url: 'https://chat.z.ai/',
    description: 'Z.ai chat; sign in and open a conversation in the clean Relay profile'
  },
  {
    id: 'aistudio',
    name: 'Google AI Studio',
    url: 'https://aistudio.google.com/prompts/new_chat',
    description: 'Google AI Studio; sign in with Google in the clean Relay profile'
  }
];

export function getWebPlatformById(id: string): WebPlatform | undefined {
  return WEB_PLATFORMS.find(platform => platform.id === id);
}

export function getWebPlatformOptions() {
  return WEB_PLATFORMS.map(platform => ({
    value: platform.id,
    label: platform.name,
    description: platform.description
  }));
}