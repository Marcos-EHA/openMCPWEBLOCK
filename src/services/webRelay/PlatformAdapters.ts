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

export const ADAPTERS: Record<string, PlatformAdapter> = {
  chatgpt: {
    insertText: `
(function(text) {
  const editor = document.querySelector('#prompt-textarea, [id="prompt-textarea"]');
  if (editor) {
    editor.focus();
    // ChatGPT uses ProseMirror
    const p = editor.querySelector('p');
    if (p) {
      p.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      return true;
    }
    // Fallback to contenteditable
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }
  ${GENERIC_INSERT.replace('__PROMPT__', 'text')}
  return false;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"]');
  if (btn && !btn.disabled) { btn.click(); return true; }
  // Fallback: Ctrl+Enter or Enter
  const editor = document.querySelector('#prompt-textarea');
  if (editor) {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }
  return false;
})()`,
    isGenerating: `
(function() {
  const stop = document.querySelector('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
  if (stop) return true;
  const streaming = document.querySelector('.result-streaming, [data-is-streaming="true"]');
  return !!streaming;
})()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!msgs.length) return null;
  // Walk backwards to find last non-empty message (ChatGPT sometimes has empty placeholders)
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    var md = m.querySelector('.markdown, .prose');
    var text = md ? md.innerText : m.innerText;
    if (text && text.trim().length > 0) return text;
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
    insertText: `
(function(text) {
  const editor = document.querySelector('[contenteditable="true"].ProseMirror, div[contenteditable="true"]');
  if (editor) {
    editor.focus();
    const p = editor.querySelector('p');
    if (p) { p.textContent = text; }
    else { editor.textContent = text; }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    return true;
  }
  return false;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const btn = document.querySelector('button[aria-label="Send Message"], button[data-testid="send-button"]');
  if (btn && !btn.disabled) { btn.click(); return true; }
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
  const msgs = document.querySelectorAll('[data-is-streaming], .font-claude-message');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2000,
  },

  deepseek: {
    insertText: `
(function(text) {
  const ta = document.querySelector('textarea#chat-input, textarea');
  if (ta) {
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSet.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
})(__PROMPT__)`,
    submitForm: GENERIC_SUBMIT,
    isGenerating: `(function() { return !!document.querySelector('[class*="loading"], .ds-loading, [class*="generating"]'); })()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('.ds-markdown, .markdown-body, [class*="assistant-message"]');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 180_000,
    pollMs: 2500,
  },

  grok: {
    insertText: GENERIC_INSERT,
    submitForm: GENERIC_SUBMIT,
    isGenerating: `(function() { return !!document.querySelector('[class*="typing"], [class*="loading"], [class*="streaming"]'); })()`,
    extractResponse: `
(function() {
  const msgs = document.querySelectorAll('[class*="message"][class*="bot"], [class*="assistant"], [data-role="assistant"]');
  if (!msgs.length) return null;
  return msgs[msgs.length - 1].innerText;
})()`,
    timeoutMs: 120_000,
    pollMs: 2000,
  },

  perplexity: {
    insertText: `
(function(text) {
  const ta = document.querySelector('textarea');
  if (ta) {
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSet.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
})(__PROMPT__)`,
    submitForm: `
(function() {
  const btn = document.querySelector('button[aria-label="Submit"], button[aria-label="Ask"], button.bg-super');
  if (btn && !btn.disabled) { btn.click(); return true; }
  const ta = document.querySelector('textarea');
  if (ta) {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }
  return false;
})()`,
    isGenerating: `(function() { return !!document.querySelector('[class*="generating"], .animate-spin, [class*="loading"]'); })()`,
    extractResponse: `
(function() {
  const answers = document.querySelectorAll('.prose, [class*="answer"], [class*="response-text"]');
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
  return adapter.insertText.replace(/__PROMPT__/g, escaped)
}
