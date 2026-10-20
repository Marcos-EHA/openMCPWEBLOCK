import { BaseAdapterPlugin } from './base.adapter';
import type { AdapterCapability, PluginContext } from '../plugin-types';

export class ChatHubAdapter extends BaseAdapterPlugin {
  readonly name = 'ChatHubAdapter';
  readonly version = '1.0.0';
  readonly hostnames = ['app.chathub.gg'];
  readonly capabilities: AdapterCapability[] = ['text-insertion', 'form-submission'];

  async initialize(context: PluginContext): Promise<void> {
    await super.initialize(context);
    this.currentStatus = 'active';
  }

  async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
    const editor = options?.targetElement ?? this.getVisibleEditor();
    if (!editor || editor.tagName !== 'TEXTAREA') {
      this.context.logger.error('ChatHub message textarea is not available');
      return false;
    }

    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (!nativeSet) {
      this.context.logger.error('Native textarea value setter is not available for ChatHub');
      return false;
    }

    editor.focus();
    nativeSet.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
    const editor = this.getVisibleEditor();
    if (!editor) {
      this.context.logger.error('ChatHub message textarea is not available');
      return false;
    }

    const form = options?.formElement ?? editor.closest('form');
    const button = Array.from(form?.querySelectorAll('button') ?? []).find(element => {
      const label = (element.getAttribute('aria-label') || element.innerText || '')
        .trim()
        .toLowerCase();
      return this.isVisible(element) &&
        !element.disabled &&
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
      cancelable: true,
    }));
    return true;
  }

  private getVisibleEditor(): HTMLTextAreaElement | null {
    return Array.from(document.querySelectorAll<HTMLTextAreaElement>(
      'form textarea',
    )).find(editor => this.isVisible(editor)) ?? null;
  }

  private isVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';
  }
}
