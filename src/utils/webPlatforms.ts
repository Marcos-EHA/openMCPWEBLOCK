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
    url: 'https://grok.x.ai',
    description: 'xAI\'s Grok web interface'
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
    description: 'DeepSeek AI web interface'
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    description: 'Anthropic\'s Claude web interface'
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