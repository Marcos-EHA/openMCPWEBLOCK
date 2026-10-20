import type { Root } from 'react-dom/client';
import { BaseAdapterPlugin } from './base.adapter';
import type { AdapterCapability, PluginContext } from '../plugin-types';
import { findClaudeFileInput } from './claudeFileAttachment';

const CLAUDE_INPUT_SELECTOR = '[data-testid="chat-input"][role="textbox"], [data-testid="chat-input"]';
const CLAUDE_ATTACH_SELECTOR = 'button[data-testid="chat-input-attach"]';
const CLAUDE_SUBMIT_SELECTOR =
  'button[type="submit"], button[data-testid*="send"], button[aria-label*="send" i], button[aria-label*="enviar" i]';
const CLAUDE_SUBMIT_READY_TIMEOUT_MS = 5000;

type ClaudeInsertionPoint = { container: Element; insertAfter: Element };
type ClaudeSubmitButtonState = {
  disabled: boolean;
  hasLayoutBox: boolean;
  display: string;
  visibility: string;
  pageVisibility: DocumentVisibilityState;
};

function isVisible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

export function isClaudeSubmitButtonReady({
  disabled,
  hasLayoutBox,
  display,
  visibility,
  pageVisibility,
}: ClaudeSubmitButtonState): boolean {
  return !disabled &&
    hasLayoutBox &&
    display !== 'none' &&
    (visibility !== 'hidden' || pageVisibility === 'hidden');
}

export function findClaudeInsertionPoint(doc: Document = document): ClaudeInsertionPoint | null {
  const input = Array.from(doc.querySelectorAll<HTMLElement>(CLAUDE_INPUT_SELECTOR)).find(isVisible);
  if (!input) return null;

  const composer = input.closest('fieldset') ?? input.closest('form') ?? input.parentElement?.parentElement;
  if (!composer) return null;

  const attachButton = Array.from(composer.querySelectorAll<HTMLButtonElement>(CLAUDE_ATTACH_SELECTOR)).find(isVisible);
  const attachWrapper = attachButton?.parentElement;
  const actionRow = attachWrapper?.parentElement;
  if (!attachWrapper || !actionRow) return null;

  return { container: actionRow, insertAfter: attachWrapper };
}

function findEnabledSubmitButton(composer: Element): HTMLButtonElement | null {
  return (
    Array.from(composer.querySelectorAll<HTMLButtonElement>(CLAUDE_SUBMIT_SELECTOR)).find(
      button => {
        const style = window.getComputedStyle(button);
        return isClaudeSubmitButtonReady({
          disabled: button.disabled,
          hasLayoutBox: button.getClientRects().length > 0,
          display: style.display,
          visibility: style.visibility,
          pageVisibility: document.visibilityState,
        });
      },
    ) ?? null
  );
}

function waitForEnabledSubmitButton(composer: Element): Promise<HTMLButtonElement | null> {
  const availableButton = findEnabledSubmitButton(composer);
  if (availableButton) return Promise.resolve(availableButton);

  return new Promise(resolve => {
    const observer = new MutationObserver(() => {
      const button = findEnabledSubmitButton(composer);
      if (button) finish(button);
    });
    const timeout = window.setTimeout(() => finish(null), CLAUDE_SUBMIT_READY_TIMEOUT_MS);
    let finished = false;

    const finish = (button: HTMLButtonElement | null) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve(button);
    };

    observer.observe(composer, {
      attributes: true,
      attributeFilter: ['aria-disabled', 'class', 'disabled', 'style'],
      childList: true,
      subtree: true,
    });
    const buttonAfterObserving = findEnabledSubmitButton(composer);
    if (buttonAfterObserving) finish(buttonAfterObserving);
  });
}

export class ClaudeAdapter extends BaseAdapterPlugin {
  readonly name = 'ClaudeAdapter';
  readonly version = '1.0.0';
  readonly hostnames = ['claude.ai'];
  readonly capabilities: AdapterCapability[] = [
    'text-insertion',
    'form-submission',
    'file-attachment',
    'dom-manipulation',
  ];

  private observer: MutationObserver | null = null;
  private popoverContainer: HTMLElement | null = null;
  private popoverRoot: Root | null = null;

  async initialize(context: PluginContext): Promise<void> {
    await super.initialize(context);
  }

  async activate(): Promise<void> {
    if (this.currentStatus === 'active') return;
    await super.activate();
    this.observer = new MutationObserver(() => this.ensurePopover());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.ensurePopover();
  }

  async deactivate(): Promise<void> {
    if (this.currentStatus === 'inactive' || this.currentStatus === 'disabled') return;
    this.observer?.disconnect();
    this.observer = null;
    this.removePopover();
    await super.deactivate();
  }

  async cleanup(): Promise<void> {
    await this.deactivate();
    await super.cleanup();
  }

  async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
    const input = options?.targetElement ??
      document.querySelector<HTMLElement>(CLAUDE_INPUT_SELECTOR);
    if (!input || !input.isConnected) {
      this.context.logger.error('Could not find the Claude chat input');
      return false;
    }

    input.focus();
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      this.context.logger.error('Claude chat input rejected text insertion');
      return false;
    }
    return true;
  }

  async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
    const input = document.querySelector<HTMLElement>(CLAUDE_INPUT_SELECTOR);
    const composer = options?.formElement ?? input?.closest('form') ?? input?.closest('fieldset');
    if (!composer) {
      this.context.logger.error('Could not find the Claude composer for submission');
      return false;
    }

    const submitButton = await waitForEnabledSubmitButton(composer);
    if (!submitButton) {
      this.context.logger.error('Claude send button did not become enabled before the submission timeout');
      return false;
    }

    submitButton.click();
    return true;
  }

  async attachFile(file: File, options?: { inputElement?: HTMLInputElement }): Promise<boolean> {
    if (!file || file.size === 0) {
      this.context.logger.error('Cannot attach an empty file to the Claude composer');
      return false;
    }

    const input = this.findFileInput(file, options?.inputElement);
    if (!input) {
      this.context.logger.error(
        `Claude has no enabled composer file input that accepts ${file.type || file.name}`,
      );
      return false;
    }

    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      if (input.files?.length !== 1 || input.files[0]?.name !== file.name) {
        this.context.logger.error(`Claude did not accept the selected file ${file.name}`);
        return false;
      }

      input.dispatchEvent(new Event('change', { bubbles: true }));
      this.context.logger.info(`Submitted ${file.name} to the Claude composer file input`);
      return true;
    } catch (error) {
      this.context.logger.error(
        `Could not attach ${file.name} to the Claude composer:`,
        error,
      );
      return false;
    }
  }

  supportsFileAttachment(file: File): boolean {
    return this.findFileInput(file) !== null;
  }

  private findFileInput(file: File, preferredInput?: HTMLInputElement): HTMLInputElement | null {
    const chatInput = Array.from(
      document.querySelectorAll<HTMLElement>(CLAUDE_INPUT_SELECTOR),
    ).find(isVisible);
    const composer = chatInput?.closest('fieldset') ??
      chatInput?.closest('form') ??
      chatInput?.parentElement?.parentElement;
    if (!composer) return null;

    const inputs = Array.from(
      composer.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    if (preferredInput) {
      return inputs.includes(preferredInput) &&
        findClaudeFileInput([preferredInput], file)
        ? preferredInput
        : null;
    }

    return findClaudeFileInput(inputs, file);
  }

  private ensurePopover(): void {
    if (this.currentStatus !== 'active') return;
    if (this.popoverContainer?.isConnected) return;

    this.disposeDisconnectedPopover();
    if (document.getElementById('mcp-popover-container')) return;

    const insertionPoint = findClaudeInsertionPoint();
    if (!insertionPoint) return;

    const container = document.createElement('div');
    container.id = 'mcp-popover-container';
    container.dataset.adapter = this.name;
    container.style.display = 'inline-flex';
    container.style.flex = '0 0 auto';
    container.style.alignItems = 'center';
    container.style.margin = '0 4px';
    insertionPoint.container.insertBefore(container, insertionPoint.insertAfter.nextSibling);
    this.popoverContainer = container;
    void this.renderPopover(container);
  }

  private async renderPopover(container: HTMLElement): Promise<void> {
    try {
      const [React, ReactDOM, { MCPPopover }] = await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('../../components/mcpPopover/mcpPopover'),
      ]);
      if (!container.isConnected || this.popoverContainer !== container) return;

      this.popoverRoot = ReactDOM.createRoot(container);
      this.popoverRoot.render(
        React.createElement(MCPPopover, {
          toggleStateManager: this.createToggleStateManager(),
          adapterName: this.name,
        }),
      );
    } catch (error) {
      this.context.logger.error('Failed to render the Claude MCP control:', error);
      if (this.popoverContainer === container) {
        container.remove();
        this.popoverContainer = null;
      }
    }
  }

  private createToggleStateManager() {
    const ui = this.context.stores.ui;
    const update = () => {
      const container = this.popoverContainer;
      if (!container) return;
      container.dispatchEvent(new CustomEvent('mcp:update-toggle-state', {
        detail: {
          toggleState: {
            mcpEnabled: ui?.mcpEnabled ?? false,
            autoInsert: ui?.preferences?.autoInsert ?? false,
            autoSubmit: ui?.preferences?.autoSubmit ?? false,
            autoExecute: ui?.preferences?.autoExecute ?? false,
          },
        },
      }));
    };

    return {
      getState: () => ({
        mcpEnabled: ui?.mcpEnabled ?? false,
        autoInsert: ui?.preferences?.autoInsert ?? false,
        autoSubmit: ui?.preferences?.autoSubmit ?? false,
        autoExecute: ui?.preferences?.autoExecute ?? false,
      }),
      setMCPEnabled: (enabled: boolean) => {
        ui?.setMCPEnabled?.(enabled, 'claude-mcp-popover-toggle');
        update();
      },
      setAutoInsert: (enabled: boolean) => {
        ui?.updatePreferences?.({ autoInsert: enabled });
        update();
      },
      setAutoSubmit: (enabled: boolean) => {
        ui?.updatePreferences?.({ autoSubmit: enabled });
        update();
      },
      setAutoExecute: (enabled: boolean) => {
        ui?.updatePreferences?.({ autoExecute: enabled });
        update();
      },
      updateUI: update,
    };
  }

  private disposeDisconnectedPopover(): void {
    if (this.popoverContainer?.isConnected) return;
    this.popoverRoot?.unmount();
    this.popoverRoot = null;
    this.popoverContainer = null;
  }

  private removePopover(): void {
    this.popoverRoot?.unmount();
    this.popoverRoot = null;
    this.popoverContainer?.remove();
    this.popoverContainer = null;
  }
}
