import { afterEach, describe, expect, test } from 'bun:test'
import { buildInsertScript, getAdapter } from './PlatformAdapters.js'

class FakeElement {
  readonly tagName: string
  readonly id: string
  readonly hidden: boolean
  disabled = false
  textContent = ''
  innerText = ''
  inputValue = ''
  clicked = false
  dispatchedEvents: string[] = []

  get value(): string {
    return this.inputValue
  }

  set value(value: string) {
    this.inputValue = value
  }

  constructor(tagName: string, id: string, hidden = false) {
    this.tagName = tagName
    this.id = id
    this.hidden = hidden
  }

  getBoundingClientRect() {
    return this.hidden
      ? { width: 0, height: 0 }
      : { width: 320, height: 40 }
  }

  focus(): void {}

  querySelector(): null {
    return null
  }

  getAttribute(): null {
    return null
  }

  dispatchEvent(event: Event): boolean {
    this.dispatchedEvents.push(event.type)
    return true
  }

  click(): void {
    this.clicked = true
  }
}

class FakeHTMLTextAreaElement extends FakeElement {}
Object.defineProperty(FakeHTMLTextAreaElement.prototype, 'value', {
  configurable: true,
  get(this: FakeElement) {
    return this.inputValue
  },
  set(this: FakeElement, value: string) {
    this.inputValue = value
  },
})

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalInputEvent = Object.getOwnPropertyDescriptor(globalThis, 'InputEvent')
const originalKeyboardEvent = Object.getOwnPropertyDescriptor(globalThis, 'KeyboardEvent')

function installPage(documentValue: unknown): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentValue,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      getComputedStyle: (element: FakeElement) => ({
        display: element.hidden ? 'none' : 'block',
        visibility: element.hidden ? 'hidden' : 'visible',
      }),
      HTMLTextAreaElement: FakeHTMLTextAreaElement,
    },
  })
  Object.defineProperty(globalThis, 'InputEvent', {
    configurable: true,
    value: class {
      constructor(readonly type: string) {}
    },
  })
  Object.defineProperty(globalThis, 'KeyboardEvent', {
    configurable: true,
    value: class {
      constructor(readonly type: string) {}
    },
  })
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}

afterEach(() => {
  restoreGlobal('document', originalDocument)
  restoreGlobal('window', originalWindow)
  restoreGlobal('InputEvent', originalInputEvent)
  restoreGlobal('KeyboardEvent', originalKeyboardEvent)
})

describe('ChatGPT platform adapter', () => {
  test('inserts into the visible editor instead of a hidden mobile textarea', () => {
    const hiddenTextarea = new FakeElement('TEXTAREA', 'mobile-composer-prompt', true)
    const visibleEditor = new FakeElement('DIV', 'prompt-textarea')
    const documentValue = {
      querySelector: () => hiddenTextarea,
      querySelectorAll: (selector: string) =>
        selector.includes('#prompt-textarea') ? [visibleEditor] : [hiddenTextarea],
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('chatgpt'), 'safe-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(visibleEditor.textContent).toBe('safe-smoke-message')
    expect(hiddenTextarea.value).toBe('')
  })

  test('submits through a visible send button rather than a hidden duplicate', () => {
    const hiddenButton = new FakeElement('BUTTON', 'hidden-send', true)
    const visibleButton = new FakeElement('BUTTON', 'visible-send')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('button[') ? [hiddenButton, visibleButton] : [],
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('chatgpt').submitForm})`)()

    expect(result).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(visibleButton.clicked).toBe(true)
  })

  test('does not report insertion when only hidden ChatGPT editors exist', () => {
    const hiddenTextarea = new FakeElement('TEXTAREA', 'mobile-composer-prompt', true)
    const hiddenEditor = new FakeElement('DIV', 'prompt-textarea', true)
    const documentValue = {
      querySelector: () => hiddenTextarea,
      querySelectorAll: (selector: string) =>
        selector.includes('#prompt-textarea')
          ? [hiddenEditor]
          : selector.includes('[contenteditable="true"]')
            ? [hiddenEditor]
            : [hiddenTextarea],
      execCommand: () => true,
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('chatgpt'), 'safe-smoke-message')})`,
    )()

    expect(result).toBe(false)
    expect(hiddenTextarea.value).toBe('')
    expect(hiddenEditor.textContent).toBe('')
  })
})

describe('Claude platform adapter', () => {
  test('extracts assistant messages with Claude-specific selectors', () => {
    const messages = [
      new FakeElement('DIV', 'previous-message'),
      new FakeElement('DIV', 'latest-message'),
    ]
    messages[0]!.innerText = 'previous response'
    messages[1]!.innerText = 'latest response'
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector === '.font-claude-message' ? messages : [],
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('claude').extractResponse})`)()

    expect(getAdapter('claude').assistantMessageSelector).toBe('.font-claude-message')
    expect(result).toBe('latest response')
  })

  test('inserts through the visible ProseMirror editor input path', () => {
    const hiddenEditor = new FakeElement('DIV', 'hidden-editor', true)
    const visibleEditor = new FakeElement('DIV', 'claude-editor')
    let selectedEditor: FakeElement | undefined
    const range = {
      selectNodeContents: (editor: FakeElement) => {
        selectedEditor = editor
      },
    }
    const selection = {
      removeAllRanges() {},
      addRange() {},
    }
    const inserted: Array<{ command: string; value: string }> = []
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('[contenteditable="true"]')
          ? [hiddenEditor, visibleEditor]
          : [],
      createRange: () => range,
      execCommand: (command: string, _showUI: boolean, value: string) => {
        inserted.push({ command, value })
        return true
      },
    }
    installPage(documentValue)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        getComputedStyle: (element: FakeElement) => ({
          display: element.hidden ? 'none' : 'block',
          visibility: element.hidden ? 'hidden' : 'visible',
        }),
        HTMLTextAreaElement: FakeHTMLTextAreaElement,
        getSelection: () => selection,
      },
    })

    const result = Function(
      `return (${buildInsertScript(getAdapter('claude'), 'safe-claude-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(selectedEditor).toBe(visibleEditor)
    expect(inserted).toEqual([{ command: 'insertText', value: 'safe-claude-smoke-message' }])
    expect(hiddenEditor.textContent).toBe('')
  })

  test("submits through Claude's localized chat input send button while minimized", () => {
    const sendButton = new FakeElement('BUTTON', 'chat-input-send', true)
    const documentValue = {
      querySelector: (selector: string) =>
        selector.includes('chat-input-send') ? sendButton : null,
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('claude').submitForm})`)()

    expect(result).toBe(true)
    expect(sendButton.clicked).toBe(true)
  })

  test('does not submit when Claude disables the send button', () => {
    const sendButton = new FakeElement('BUTTON', 'chat-input-send')
    sendButton.disabled = true
    const documentValue = {
      querySelector: (selector: string) =>
        selector.includes('chat-input-send') ? sendButton : null,
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('claude').submitForm})`)()

    expect(result).toBe(false)
    expect(sendButton.clicked).toBe(false)
  })
})

describe('Arena Direct platform adapter', () => {
  test('inserts text into the visible Direct composer textarea', () => {
    const hiddenInput = new FakeElement('TEXTAREA', 'hidden-composer', true)
    const visibleInput = new FakeElement('TEXTAREA', 'arena-composer')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('textarea[name="message"]') ? [hiddenInput, visibleInput] : [],
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('arena'), 'safe-arena-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenInput.inputValue).toBe('')
    expect(visibleInput.inputValue).toBe('safe-arena-smoke-message')
    expect(visibleInput.dispatchedEvents).toEqual(['input', 'change'])
  })

  test('submits only through an enabled visible Direct send button', () => {
    const hiddenButton = new FakeElement('BUTTON', 'hidden-send', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-send')
    disabledButton.disabled = true
    const visibleButton = new FakeElement('BUTTON', 'arena-send')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('Send message') ? [hiddenButton, disabledButton, visibleButton] : [],
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('arena').submitForm})`)()

    expect(result).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(visibleButton.clicked).toBe(true)
  })

  test('does not report insertion or submission when Arena controls are unavailable', () => {
    installPage({ querySelectorAll: () => [] })

    const insertResult = Function(
      `return (${buildInsertScript(getAdapter('arena'), 'safe-arena-smoke-message')})`,
    )()
    const submitResult = Function(`return (${getAdapter('arena').submitForm})`)()

    expect(insertResult).toBe(false)
    expect(submitResult).toBe(false)
  })
})

describe('Z.ai platform adapter', () => {
  test('inserts text into the visible chat composer textarea', () => {
    const hiddenInput = new FakeHTMLTextAreaElement('TEXTAREA', 'chat-input', true)
    const visibleInput = new FakeHTMLTextAreaElement('TEXTAREA', 'chat-input')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector === 'textarea#chat-input' ? [hiddenInput, visibleInput] : [],
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('zai'), 'safe-zai-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenInput.value).toBe('')
    expect(visibleInput.value).toBe('safe-zai-smoke-message')
    expect(visibleInput.dispatchedEvents).toEqual(['input', 'change'])
  })

  test('submits only through an enabled visible Z.ai send button', () => {
    const hiddenButton = new FakeElement('BUTTON', 'send-message-button', true)
    const disabledButton = new FakeElement('BUTTON', 'send-message-button')
    disabledButton.disabled = true
    const visibleButton = new FakeElement('BUTTON', 'send-message-button')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector === '#send-message-button[type="submit"]'
          ? [hiddenButton, disabledButton, visibleButton]
          : [],
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('zai').submitForm})`)()

    expect(result).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(visibleButton.clicked).toBe(true)
  })

  test('fails explicitly when Z.ai composer controls are unavailable', () => {
    installPage({ querySelectorAll: () => [] })

    const insertResult = Function(
      `return (${buildInsertScript(getAdapter('zai'), 'safe-zai-smoke-message')})`,
    )()
    const submitResult = Function(`return (${getAdapter('zai').submitForm})`)()

    expect(insertResult).toBe(false)
    expect(submitResult).toBe(false)
  })
})

describe('Grok platform adapter', () => {
  test('inserts text into the visible localized Grok composer', () => {
    const hiddenInput = new FakeHTMLTextAreaElement('TEXTAREA', 'hidden-grok', true)
    const visibleInput = new FakeHTMLTextAreaElement('TEXTAREA', 'grok-composer')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('textarea[aria-label*="Grok"]')
          ? [hiddenInput, visibleInput]
          : [],
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('grok'), 'safe-grok-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenInput.value).toBe('')
    expect(visibleInput.value).toBe('safe-grok-smoke-message')
    expect(visibleInput.dispatchedEvents).toEqual(['input', 'change'])
  })

  test('submits only through an enabled visible Grok send button', () => {
    const hiddenButton = new FakeElement('BUTTON', 'hidden-send', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-send')
    disabledButton.disabled = true
    const visibleButton = new FakeElement('BUTTON', 'grok-send')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('data-testid="chat-submit"')
          ? [hiddenButton, disabledButton, visibleButton]
          : [],
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('grok').submitForm})`)()

    expect(result).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(visibleButton.clicked).toBe(true)
  })

  test('does not report insertion or submission when Grok controls are unavailable', () => {
    installPage({ querySelectorAll: () => [] })

    const insertResult = Function(
      `return (${buildInsertScript(getAdapter('grok'), 'safe-grok-smoke-message')})`,
    )()
    const submitResult = Function(`return (${getAdapter('grok').submitForm})`)()

    expect(insertResult).toBe(false)
    expect(submitResult).toBe(false)
  })
})

describe('Google AI Studio platform adapter', () => {
  test('inserts text into the visible prompt textarea', () => {
    const hiddenInput = new FakeHTMLTextAreaElement('TEXTAREA', 'hidden-prompt', true)
    const visibleInput = new FakeHTMLTextAreaElement('TEXTAREA', 'ai-studio-prompt')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('textarea.textarea[placeholder="Start typing a prompt"]')
          ? [hiddenInput, visibleInput]
          : [],
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('aistudio'), 'safe-aistudio-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenInput.value).toBe('')
    expect(visibleInput.value).toBe('safe-aistudio-smoke-message')
    expect(visibleInput.dispatchedEvents).toEqual(['input', 'change'])
  })

  test('submits only through an enabled visible Run or Send button', () => {
    const hiddenButton = new FakeElement('BUTTON', 'hidden-run', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-run')
    disabledButton.disabled = true
    const visibleButton = new FakeElement('BUTTON', 'run')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('aria-label="Run"')
          ? [hiddenButton, disabledButton, visibleButton]
          : [],
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('aistudio').submitForm})`)()

    expect(result).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(visibleButton.clicked).toBe(true)
  })

  test('returns false when Google AI Studio controls are not present', () => {
    installPage({ querySelectorAll: () => [] })

    const insertResult = Function(
      `return (${buildInsertScript(getAdapter('aistudio'), 'safe-aistudio-smoke-message')})`,
    )()
    const submitResult = Function(`return (${getAdapter('aistudio').submitForm})`)()

    expect(insertResult).toBe(false)
    expect(submitResult).toBe(false)
  })
})

describe('Perplexity platform adapter', () => {
  test('inserts text into the visible Lexical contenteditable composer', () => {
    const hiddenEditor = new FakeElement('DIV', 'hidden-ask-input', true)
    const visibleEditor = new FakeElement('DIV', 'ask-input')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('#ask-input[contenteditable="true"]')
          ? [hiddenEditor, visibleEditor]
          : [],
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (command: string, _showUI: boolean, text: string) => {
        if (command !== 'insertText') return false
        visibleEditor.textContent = text
        return true
      },
    }
    installPage(documentValue)
    Object.assign(globalThis.window, {
      getSelection: () => ({
        removeAllRanges: () => {},
        addRange: () => {},
      }),
    })

    const result = Function(
      `return (${buildInsertScript(getAdapter('perplexity'), 'safe-perplexity-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenEditor.textContent).toBe('')
    expect(visibleEditor.textContent).toBe('safe-perplexity-smoke-message')
  })

  test('uses the visible enabled submit button when Perplexity provides one', () => {
    const editor = new FakeElement('DIV', 'ask-input')
    const hiddenButton = new FakeElement('BUTTON', 'hidden-submit', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-submit')
    disabledButton.disabled = true
    const visibleButton = new FakeElement('BUTTON', 'submit')
    const documentValue = {
      querySelectorAll: (selector: string) => {
        if (selector.includes('#ask-input')) return [editor]
        if (selector.includes('button[aria-label="Submit"]')) {
          return [hiddenButton, disabledButton, visibleButton]
        }
        return []
      },
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('perplexity').submitForm})`)()

    expect(result).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(visibleButton.clicked).toBe(true)
  })

  test('falls back to Enter on the contenteditable composer when there is no send button', () => {
    const editor = new FakeElement('DIV', 'ask-input')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('#ask-input') ? [editor] : [],
    }
    installPage(documentValue)

    const result = Function(`return (${getAdapter('perplexity').submitForm})`)()

    expect(result).toBe(true)
    expect(editor.dispatchedEvents).toEqual(['keydown'])
  })

  test('does not report missing Perplexity composer controls as successful', () => {
    installPage({ querySelectorAll: () => [] })

    const insertResult = Function(
      `return (${buildInsertScript(getAdapter('perplexity'), 'safe-perplexity-smoke-message')})`,
    )()
    const submitResult = Function(`return (${getAdapter('perplexity').submitForm})`)()

    expect(insertResult).toBe(false)
    expect(submitResult).toBe(false)
  })
})

describe('DeepSeek platform adapter', () => {
  test('inserts text into the visible textarea rather than a hidden duplicate', () => {
    const hiddenInput = new FakeHTMLTextAreaElement('TEXTAREA', 'chat-input', true)
    const visibleInput = new FakeHTMLTextAreaElement('TEXTAREA', 'chat-input')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('textarea#chat-input') ? [hiddenInput, visibleInput] : [],
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('deepseek'), 'safe-deepseek-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenInput.value).toBe('')
    expect(visibleInput.value).toBe('safe-deepseek-smoke-message')
    expect(visibleInput.dispatchedEvents).toEqual(['input', 'change'])
  })

  test('inserts into a contenteditable editor using the browser insertion command', () => {
    const editor = new FakeElement('DIV', 'deepseek-editor')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('div[contenteditable="true"]') ? [editor] : [],
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (command: string, _showUI: boolean, text: string) => {
        if (command !== 'insertText') return false
        editor.textContent = text
        return true
      },
    }
    installPage(documentValue)
    Object.assign(globalThis.window, {
      getSelection: () => ({
        removeAllRanges: () => {},
        addRange: () => {},
      }),
    })

    const result = Function(
      `return (${buildInsertScript(getAdapter('deepseek'), 'safe-deepseek-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(editor.textContent).toBe('safe-deepseek-smoke-message')
  })

  test('uses a visible enabled send button and falls back to Enter', () => {
    const editor = new FakeHTMLTextAreaElement('TEXTAREA', 'chat-input')
    const hiddenButton = new FakeElement('BUTTON', 'hidden-send', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-send')
    disabledButton.disabled = true
    const visibleButton = new FakeElement('BUTTON', 'send')
    const documentWithButton = {
      querySelectorAll: (selector: string) => {
        if (selector.includes('textarea#chat-input')) return [editor]
        if (selector.includes('button[data-testid="send-button"]')) {
          return [hiddenButton, disabledButton, visibleButton]
        }
        return []
      },
    }
    installPage(documentWithButton)

    const buttonResult = Function(`return (${getAdapter('deepseek').submitForm})`)()

    expect(buttonResult).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(visibleButton.clicked).toBe(true)

    const editorWithoutButton = new FakeHTMLTextAreaElement('TEXTAREA', 'chat-input')
    installPage({
      querySelectorAll: (selector: string) =>
        selector.includes('textarea#chat-input') ? [editorWithoutButton] : [],
    })

    const enterResult = Function(`return (${getAdapter('deepseek').submitForm})`)()

    expect(enterResult).toBe(true)
    expect(editorWithoutButton.dispatchedEvents).toEqual(['keydown'])
  })

  test('does not report success if the composer is unavailable', () => {
    installPage({ querySelectorAll: () => [] })

    const insertResult = Function(
      `return (${buildInsertScript(getAdapter('deepseek'), 'safe-deepseek-smoke-message')})`,
    )()
    const submitResult = Function(`return (${getAdapter('deepseek').submitForm})`)()

    expect(insertResult).toBe(false)
    expect(submitResult).toBe(false)
  })
})

describe('ChatHub platform adapter', () => {
  test('inserts text into the visible composer textarea', () => {
    const hiddenEditor = new FakeHTMLTextAreaElement('TEXTAREA', 'hidden-editor', true)
    const visibleEditor = new FakeHTMLTextAreaElement('TEXTAREA', 'chathub-editor')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('form textarea')
          ? [hiddenEditor, visibleEditor]
          : [],
    }
    installPage(documentValue)

    const result = Function(
      `return (${buildInsertScript(getAdapter('chathub'), 'safe-chathub-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenEditor.value).toBe('')
    expect(visibleEditor.value).toBe('safe-chathub-smoke-message')
    expect(visibleEditor.dispatchedEvents).toEqual(['input', 'change'])
  })

  test('submits through the visible enabled Send button within the composer form', () => {
    const editor = new FakeHTMLTextAreaElement('TEXTAREA', 'chathub-editor')
    const hiddenButton = new FakeElement('BUTTON', 'hidden-send', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-send')
    disabledButton.disabled = true
    const sendButton = new FakeElement('BUTTON', 'send-button')
    Object.assign(sendButton, { innerText: 'Enviar' })
    const form = { querySelectorAll: () => [hiddenButton, disabledButton, sendButton] }
    Object.assign(editor, { closest: () => form })
    installPage({
      querySelectorAll: (selector: string) =>
        selector.includes('form textarea') ? [editor] : [],
    })

    const result = Function(`return (${getAdapter('chathub').submitForm})`)()

    expect(result).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(sendButton.clicked).toBe(true)
  })

  test('returns false when ChatHub composer controls are unavailable', () => {
    installPage({ querySelectorAll: () => [] })

    const insertResult = Function(
      `return (${buildInsertScript(getAdapter('chathub'), 'safe-chathub-smoke-message')})`,
    )()
    const submitResult = Function(`return (${getAdapter('chathub').submitForm})`)()

    expect(insertResult).toBe(false)
    expect(submitResult).toBe(false)
  })
})

describe('Kimi platform adapter', () => {
  test('inserts text into the visible contenteditable composer', () => {
    const hiddenEditor = new FakeElement('DIV', 'hidden-kimi-editor', true)
    const visibleEditor = new FakeElement('DIV', 'kimi-editor')
    const documentValue = {
      querySelectorAll: (selector: string) =>
        selector.includes('.chat-input-editor[contenteditable="true"]')
          ? [hiddenEditor, visibleEditor]
          : [],
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (command: string, _showUI: boolean, text: string) => {
        if (command !== 'insertText') return false
        visibleEditor.textContent = text
        return true
      },
    }
    installPage(documentValue)
    Object.assign(globalThis.window, {
      getSelection: () => ({
        removeAllRanges: () => {},
        addRange: () => {},
      }),
    })

    const result = Function(
      `return (${buildInsertScript(getAdapter('kimi'), 'safe-kimi-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenEditor.textContent).toBe('')
    expect(visibleEditor.textContent).toBe('safe-kimi-smoke-message')
  })

  test('submits with a visible send control or Enter fallback', () => {
    const editor = new FakeElement('DIV', 'kimi-editor')
    const hiddenButton = new FakeElement('BUTTON', 'hidden-send', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-send')
    disabledButton.disabled = true
    const sendButton = new FakeElement('BUTTON', 'send')
    installPage({
      querySelectorAll: (selector: string) => {
        if (selector.includes('.chat-input-editor[contenteditable="true"]')) return [editor]
        if (selector.includes('button[data-testid*="send"]')) {
          return [hiddenButton, disabledButton, sendButton]
        }
        return []
      },
    })

    const buttonResult = Function(`return (${getAdapter('kimi').submitForm})`)()

    expect(buttonResult).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(sendButton.clicked).toBe(true)

    const fallbackEditor = new FakeElement('DIV', 'kimi-editor')
    installPage({
      querySelectorAll: (selector: string) =>
        selector.includes('.chat-input-editor[contenteditable="true"]') ? [fallbackEditor] : [],
    })

    const enterResult = Function(`return (${getAdapter('kimi').submitForm})`)()

    expect(enterResult).toBe(true)
    expect(fallbackEditor.dispatchedEvents).toEqual(['keydown'])
  })

  test('does not report success when the composer is unavailable', () => {
    installPage({ querySelectorAll: () => [] })
    expect(Function(`return (${getAdapter('kimi').submitForm})`)()).toBe(false)
  })
})

describe('Qwen platform adapter', () => {
  test('inserts text into the visible Qwen textarea', () => {
    const hiddenEditor = new FakeHTMLTextAreaElement('TEXTAREA', 'hidden-qwen-editor', true)
    const visibleEditor = new FakeHTMLTextAreaElement('TEXTAREA', 'qwen-editor')
    installPage({
      querySelectorAll: (selector: string) =>
        selector.includes('textarea.message-input-textarea')
          ? [hiddenEditor, visibleEditor]
          : [],
    })

    const result = Function(
      `return (${buildInsertScript(getAdapter('qwen'), 'safe-qwen-smoke-message')})`,
    )()

    expect(result).toBe(true)
    expect(hiddenEditor.value).toBe('')
    expect(visibleEditor.value).toBe('safe-qwen-smoke-message')
    expect(visibleEditor.dispatchedEvents).toEqual(['input', 'change'])
  })

  test('submits with a visible enabled send button or Enter fallback', () => {
    const editor = new FakeHTMLTextAreaElement('TEXTAREA', 'qwen-editor')
    const hiddenButton = new FakeElement('BUTTON', 'hidden-send', true)
    const disabledButton = new FakeElement('BUTTON', 'disabled-send')
    disabledButton.disabled = true
    const sendButton = new FakeElement('BUTTON', 'send')
    installPage({
      querySelectorAll: (selector: string) => {
        if (selector.includes('textarea.message-input-textarea')) return [editor]
        if (selector.includes('button.omni-button-content-btn')) {
          return [hiddenButton, disabledButton, sendButton]
        }
        return []
      },
    })

    const buttonResult = Function(`return (${getAdapter('qwen').submitForm})`)()

    expect(buttonResult).toBe(true)
    expect(hiddenButton.clicked).toBe(false)
    expect(disabledButton.clicked).toBe(false)
    expect(sendButton.clicked).toBe(true)

    const fallbackEditor = new FakeHTMLTextAreaElement('TEXTAREA', 'qwen-editor')
    installPage({
      querySelectorAll: (selector: string) =>
        selector.includes('textarea.message-input-textarea') ? [fallbackEditor] : [],
    })

    const enterResult = Function(`return (${getAdapter('qwen').submitForm})`)()

    expect(enterResult).toBe(true)
    expect(fallbackEditor.dispatchedEvents).toEqual(['keydown'])
  })

  test('does not report success when the composer is unavailable', () => {
    installPage({ querySelectorAll: () => [] })
    expect(Function(`return (${getAdapter('qwen').submitForm})`)()).toBe(false)
  })
})
