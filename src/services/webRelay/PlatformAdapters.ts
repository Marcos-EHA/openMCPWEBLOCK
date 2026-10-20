/**
 * Platform Adapters — Ported from MCP-SuperAssistant's adapter architecture.
 * Each adapter knows how to:
 *   1. Insert text into the platform's input field
 *   2. Submit the form (click send)
 *   3. Detect if AI is still generating
 *   4. Extract the AI's response
 *
 * These are JS strings executed via CDP Runtime.evaluate in the browser context.
 * Self-contained: no dependency on SA extension being installed.
 */

export interface PlatformAdapter {
  /** JS that inserts text into the input. Use __PROMPT__ as placeholder. */
  insertText: string
  /** JS that clicks the send/submit button */
  submitForm: string
  /** JS that returns true if the AI is still generating */
  isGenerating: string
  /** JS that returns the last AI response text, or null */
  extractResponse: string
  /** CSS selector for one top-level assistant message, when platform-specific. */
  assistantMessageSelector?: string
  /** Max time to wait for response (ms) */
  timeoutMs: number
  /** Poll interval (ms) */
  pollMs: number
}

// Helper: most platforms use contenteditable or textarea
const GENERIC_INSERT = `
(function(text) {
  // Try textarea first
  const ta = document.querySelector('textarea');
  if (ta) {
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSet.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  // Try contenteditable (ProseMirror, Tiptap, etc.)
  const ce = document.querySelector('[contenteditable="true"]');
  if (ce) {
    ce.focus();
    ce.innerHTML = '';
    document.execCommand('insertText', false, text);
    ce.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
})(__PROMPT__)
`

const GENERIC_SUBMIT = `
(function() {
  // Try common send button selectors
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]',
    'button[class*="send"]',
    'form button:last-of-type',
  ];
  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled) { btn.click(); return true; }
  }
  // Fallback: Enter key on textarea
  const ta = document.querySelector('textarea');
  if (ta) {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }
  return false;
})()
`

const CHATGPT_ASSISTANT_SELECTOR = [
  '[data-local-conversation-final-assistant]',
  '[data-message-role="assistant"]:not([data-local-conversation-final-assistant] *)',
  '[data-message-author-role="assistant"]:not([data-local-conversation-final-assistant] *)',
  '[data-turn="assistant"]:not([data-message-role="assistant"] *):not([data-message-author-role="assistant"] *):not([data-local-conversation-final-assistant] *)',
  '[data-testid="assistant-message"]:not([data-local-conversation-final-assistant] *)',
  '[data-test-id="model-response"]:not([data-local-conversation-final-assistant] *)',
  '[data-markdown-text-style="assistant-message"]:not([data-local-conversation-final-assistant] *)',
].join(', ')

export const ADAPTERS: Record<string, PlatformAdapter> = {
  chatgpt: {
    assistantMessageSelector: CHATGPT_ASSISTANT_SELECTOR,
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    '#prompt-textarea, [id="prompt-textarea"], .ProseMirror[contenteditable="true"]'
  )).find(isVisible);
  if (editor) {
    editor.focus();
    const p = editor.querySelector('p');
    if (p) {
      p.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      return true;
    }
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }
  const ta = Array.from(document.querySelectorAll('#mobile-composer-prompt, textarea'))
    .find(isVisible);
  if (ta) {
    ta.focus();
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSet) nativeSet.call(ta, text); else ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const editable = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    .find(isVisible);
  if (editable) {
    editable.focus();
    editable.innerHTML = '';
    document.execCommand('insertText', false, text);
    editable.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }
  return false;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const buttons = Array.from(document.querySelectorAll(
    'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Enviar"], button[aria-label*="Send"]'
  ));
  const labeledButton = Array.from(document.querySelectorAll('button')).find(b => {
    const label = (b.getAttribute('aria-label') || b.innerText || '').toLowerCase();
    return (label.includes('send') || label.includes('enviar')) && !b.disabled;
  });
  const btn = [...buttons, ...(labeledButton ? [labeledButton] : [])]
    .find(button => isVisible(button) && !button.disabled);
  if (btn) { btn.click(); return true; }
  const editor = Array.from(document.querySelectorAll(
    '#prompt-textarea, #mobile-composer-prompt, textarea'
  )).find(isVisible);
  if (editor) {
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }
  return false;
})()`,
    isGenerating: `
(function() {
  const stop = document.querySelector('button[aria-label="Stop generating"], button[aria-label*="Detener"], button[data-testid="stop-button"]');
  if (stop) return true;
  const streaming = document.querySelector('.result-streaming, [data-is-streaming="true"], [data-stream-target]');
  return !!streaming;
})()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll(${JSON.stringify(CHATGPT_ASSISTANT_SELECTOR)});
  if (!msgs.length) return null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    var md = m.matches('[data-markdown-text-style="assistant-message"]')
      ? m
      : m.querySelector('[data-markdown-text-style="assistant-message"], [data-assistant-markdown], .markdown, .prose');
    var text = md ? md.innerText : m.innerText;
    if (text && text.trim().length > 0) {
      return text.replace(/^ChatGPT(\\s+Plus)?\\s+/i, '').trim();
    }
  }
  return null;
})()`,
    timeoutMs: 120_000,
    pollMs: 2000,
  },

  gemini: {
    insertText: `
(function(text) {
  const editor = document.querySelector('.ql-editor, [contenteditable="true"], .input-area textarea, rich-textarea .textarea');
  if (editor) {
    if (editor.tagName === 'TEXTAREA') {
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSet.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      editor.focus();
      editor.innerHTML = '<p>' + text + '</p>';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  }
  return false;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const btn = document.querySelector('button[aria-label="Send message"], button.send-button, button[mattooltip="Send message"]');
  if (btn && !btn.disabled) { btn.click(); return true; }
  return false;
})()`,
    isGenerating: `
(function() {
  const stop = document.querySelector('button[aria-label="Stop generating"], mat-icon[data-mat-icon-name="stop_circle"]');
  if (stop) return true;
  const loading = document.querySelector('.loading-indicator, message-loading, .model-response-loading');
  return !!loading;
})()`,
    extractResponse: `
(function() {
  const turns = document.querySelectorAll('model-response, .model-response-text, message-content');
  if (!turns.length) return null;
  const last = turns[turns.length - 1];
  const md = last.querySelector('.markdown-main-panel, .response-content, .model-response-text');
  return md ? md.innerText : last.innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2000,
  },

  claude: {
    assistantMessageSelector: '.font-claude-message',
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    '[contenteditable="true"].ProseMirror, div[contenteditable="true"]'
  )).find(isVisible);
  if (!editor) return false;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand('insertText', false, text);
})(__PROMPT__)`,
    submitForm: `
(function() {
  const btn = document.querySelector(
'button[data-testid="chat-input-send"], button[data-testid="send-button"], ' +
'button[aria-label="Send Message" i], button[aria-label="Enviar mensaje" i]'
  );
  if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
btn.click();
return true;
  }
  return false;
})()`,
    isGenerating: `
(function() {
  const streaming = document.querySelector('[data-is-streaming="true"]');
  if (streaming) return true;
  const stop = document.querySelector('button[aria-label="Stop Response"]');
  return !!stop;
})()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('.font-claude-message');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2000,
  },

  arena: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    'form textarea[name="message"][placeholder="Ask anything…"]'
  )).find(isVisible);
  if (!editor) return false;
  editor.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(editor, text); else editor.value = text;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const button = Array.from(document.querySelectorAll(
    'form button[aria-label="Send message"]'
  )).find(element => isVisible(element) && !element.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`,
    isGenerating: `
(function() {
  return !!document.querySelector(
    'button[aria-label*="Stop" i], [data-is-streaming="true"], [class*="streaming"]'
  );
})()`,
    extractResponse: `
(function() {
  const messages = document.querySelectorAll(
    '[data-message-role="assistant"], [data-role="assistant"], [data-testid*="assistant"]'
  );
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i].innerText?.trim();
    if (text) return text;
  }
  return null;
})()`,
    timeoutMs: 180_000,
    pollMs: 2500,
  },

  chatx: {
    assistantMessageSelector: '#chat_conversation #chatanswer, #chat_conversation #conversionsdiv .markdown',
    insertText: `
(function(text) {
  const editor = document.querySelector('textarea#prompt');
  if (!editor || editor.disabled || editor.readOnly) return false;
  editor.focus();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (!setter) return false;
  setter.call(editor, text);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const button = document.querySelector('button#sendchat_btn');
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`,
    isGenerating: `
(function() {
  return ['#loading', '#typing', '#typing_2', '#stopprocess'].some(selector =>
    Array.from(document.querySelectorAll(selector)).some(element => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        style.opacity !== '0' && element.getClientRects().length > 0;
    })
  );
})()`,
    extractResponse: `
(function() {
  const responses = document.querySelectorAll(
    '#chat_conversation #chatanswer, #chat_conversation #conversionsdiv .markdown'
  );
  for (let index = responses.length - 1; index >= 0; index--) {
    const text = responses[index].innerText?.trim();
    if (text) return text;
  }
  return null;
})()`,
    timeoutMs: 180_000,
    pollMs: 2000,
  },

  deepseek: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    'textarea#chat-input, textarea[spellcheck="false"], textarea[placeholder*="DeepSeek"], div[contenteditable="true"][role="textbox"]'
  )).find(isVisible);
  if (!editor) return false;
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (!nativeSet) return false;
    nativeSet.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand('insertText', false, text);
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    'textarea#chat-input, textarea[spellcheck="false"], textarea[placeholder*="DeepSeek"], div[contenteditable="true"][role="textbox"]'
  )).find(isVisible);
  if (!editor) return false;
  const button = Array.from(document.querySelectorAll(
    'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"], button[aria-label*="Enviar"], button.send-button'
  )).find(element => isVisible(element) && !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true');
  if (button) {
    button.click();
    return true;
  }
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true
  }));
  return true;
})()`,
    isGenerating: `(function() { return !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"], [class*="generating"], [class*="streaming"], [class*="loading"], .ds-loading'); })()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('.ds-markdown, .markdown-body, [class*="assistant-message"]');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 180_000,
    pollMs: 2500,
  },

  kimi: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    '.chat-input-editor[contenteditable="true"], [role="textbox"].chat-input-editor'
  )).find(isVisible);
  if (!editor) return false;
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand('insertText', false, text);
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    '.chat-input-editor[contenteditable="true"], [role="textbox"].chat-input-editor'
  )).find(isVisible);
  if (!editor) return false;
  const button = Array.from(document.querySelectorAll(
    'button[data-testid*="send"], button[aria-label*="Send"], button[aria-label*="发送"], button[aria-label*="Enviar"], .send-button-container:not(.disabled) .send-button'
  )).find(element => isVisible(element) && !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true');
  if (button) {
    button.click();
    return true;
  }
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true
  }));
  return true;
})()`,
    isGenerating: `(function() { return !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"], [class*="streaming"], [class*="generating"], [class*="loading"]'); })()`,
    extractResponse: `
(function() {
  const messages = document.querySelectorAll('[data-testid*="message-content"], [class*="assistant-message"], [class*="message-content"]');
  if (!messages.length) return null;
  const text = messages[messages.length - 1].innerText;
  return text && text.trim() ? text.trim() : null;
})()`,
    timeoutMs: 180_000,
    pollMs: 2500,
  },

  qwen: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    'textarea.message-input-textarea, textarea[placeholder="Preguntar a Qwen"]'
  )).find(isVisible);
  if (!editor) return false;
  editor.focus();
  const nativeSet = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (!nativeSet) return false;
  nativeSet.call(editor, text);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    'textarea.message-input-textarea, textarea[placeholder="Preguntar a Qwen"]'
  )).find(isVisible);
  if (!editor) return false;
  const button = Array.from(document.querySelectorAll(
    'button.omni-button-content-btn, .message-input-right-button-send button, button.send-button, #send-message-button'
  )).find(element => isVisible(element) && !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true');
  if (button) {
    button.click();
    return true;
  }
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true
  }));
  return true;
})()`,
    isGenerating: `(function() { return !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], [data-testid*="stop"], [class*="loading"], [class*="streaming"], [class*="generating"]'); })()`,
    extractResponse: `
(function() {
  const messages = document.querySelectorAll('[data-message-author-role="assistant"], [class*="markdown"], [class*="assistant-message"]');
  if (!messages.length) return null;
  const text = messages[messages.length - 1].innerText;
  return text && text.trim() ? text.trim() : null;
})()`,
    timeoutMs: 180_000,
    pollMs: 2500,
  },

  chathub: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    'form textarea'
  )).find(isVisible);
  if (!editor) return false;
  editor.focus();
  const nativeSet = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (!nativeSet) return false;
  nativeSet.call(editor, text);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    'form textarea'
  )).find(isVisible);
  if (!editor) return false;
  const form = editor.closest('form');
  const button = Array.from(form?.querySelectorAll('button') ?? []).find(element => {
    const label = (element.getAttribute('aria-label') || element.innerText || '').trim().toLowerCase();
    return isVisible(element) && !element.disabled &&
      element.getAttribute('aria-disabled') !== 'true' &&
      (label === 'send' || label === 'enviar');
  });
  if (button) {
    button.click();
    return true;
  }
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true
  }));
  return true;
})()`,
    isGenerating: `(function() { return !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="Detener"], [data-testid*="stop"], [class*="streaming"], [class*="generating"], [class*="loading"]'); })()`,
    extractResponse: `
(function() {
  const messages = document.querySelectorAll('[data-message-role="assistant"], [data-message-author-role="assistant"], [class*="assistant-message"], [class*="ChatMessage"]');
  if (!messages.length) return null;
  const last = messages[messages.length - 1];
  const text = last.innerText;
  return text && text.trim() ? text.trim() : null;
})()`,
    timeoutMs: 180_000,
    pollMs: 2500,
  },

  zai: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const input = Array.from(document.querySelectorAll('textarea#chat-input'))
    .find(isVisible);
  if (!input) return false;
  input.focus();
  const nativeSet = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (!nativeSet) return false;
  nativeSet.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const button = Array.from(document.querySelectorAll('#send-message-button[type="submit"]'))
    .find(element => isVisible(element) && !element.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`,
    isGenerating: `(function() { return document.querySelectorAll('[class*="loading"], [class*="generating"], [class*="streaming"], [class*="typing"]').length > 0; })()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('[class*="assistant"], [class*="bot"], [class*="response"], .prose, .markdown-body, .markdown');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2500,
  },

  grok: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const input = Array.from(document.querySelectorAll(
    'textarea[aria-label*="Grok"], textarea[placeholder*="Grok"]'
  )).find(isVisible);
  if (!input) return false;
  input.focus();
  const nativeSet = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (!nativeSet) return false;
  nativeSet.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const button = Array.from(document.querySelectorAll(
    'button[data-testid="chat-submit"], button[aria-label="Send"], button[aria-label="Enviar"]'
  )).find(element => isVisible(element) && !element.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`,
    isGenerating: `(function() { return !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Detener"], [class*="streaming"], [class*="generating"]'); })()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('[data-testid*="assistant"], [data-testid*="response"], [class*="message"][class*="assistant"], [class*="assistant"], [data-role="assistant"]');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2000,
  },

  aistudio: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const input = Array.from(document.querySelectorAll(
    'textarea.textarea[placeholder="Start typing a prompt"], textarea.textarea[aria-label="Enter a prompt"], .prompt-box-container textarea.textarea'
  )).find(isVisible);
  if (!input) return false;
  input.focus();
  const nativeSet = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (!nativeSet) return false;
  nativeSet.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const buttons = Array.from(document.querySelectorAll(
    'button[aria-label="Run"], button[aria-label="Send"], button[type="submit"]'
  ));
  const button = buttons.find(element => isVisible(element) && !element.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`,
    isGenerating: `(function() { return !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="stop"], [class*="loading"], [class*="generating"], [class*="streaming"]'); })()`,
    extractResponse: `
(function() {
  const turns = document.querySelectorAll(
    '[class*="model-response"], [class*="response-container"], [class*="response-content"], [class*="markdown"]'
  );
  if (!turns.length) return null;
  return turns[turns.length - 1].innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2500,
  },

  perplexity: {
    insertText: `
(function(text) {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    '#ask-input[contenteditable="true"], #ask-input[role="textbox"], div[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"]'
  )).find(isVisible);
  if (!editor) return false;
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) return false;
  return true;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll(
    '#ask-input[contenteditable="true"], #ask-input[role="textbox"], div[role="textbox"][contenteditable="true"]'
  )).find(isVisible);
  if (!editor) return false;
  const button = Array.from(document.querySelectorAll(
    'button[aria-label="Submit"], button[aria-label="Send"], button[type="submit"]'
  )).find(element => isVisible(element) && !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true');
  if (button) {
    button.click();
    return true;
  }
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true
  }));
  return true;
})()`,
    isGenerating: `(function() { return !!document.querySelector('[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="Detener"], [class*="streaming"], [class*="generating"], [class*="loading"]'); })()`,
    extractResponse: `
(function() {
  const answers = document.querySelectorAll('[data-testid*="answer"], [data-testid*="response"], [class*="answer"], [class*="response-content"], [class*="response-text"]');
  if (!answers.length) return null;
  return answers[answers.length - 1].innerText;
})()`,
    timeoutMs: 60_000,
    pollMs: 2000,
  },

  // Fallback for platforms without specific adapters
  _default: {
    insertText: GENERIC_INSERT,
    submitForm: GENERIC_SUBMIT,
    isGenerating: `(function() { return document.querySelectorAll('[class*="loading"], [class*="generating"], [class*="streaming"], [class*="typing"]').length > 0; })()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('[class*="assistant"], [class*="bot"], [class*="response"], .prose, .markdown-body, .markdown');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2500,
  },
}

/** Get adapter for a platform, falling back to default */
export function getAdapter(platformId: string): PlatformAdapter {
  return ADAPTERS[platformId] ?? ADAPTERS._default
}

/** Prepare insertText script by replacing __PROMPT__ placeholder */
export function buildInsertScript(adapter: PlatformAdapter, prompt: string): string {
  const escaped = JSON.stringify(prompt) // Handles all escaping
  return adapter.insertText.replace(/__PROMPT__/g, () => escaped)
}
