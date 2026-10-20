import type { Root } from 'react-dom/client';
import { BaseAdapterPlugin } from './base.adapter';
import type { AdapterCapability, PluginContext } from '../plugin-types';

const ARENA_INPUT_SELECTOR = 'form textarea[name="message"][placeholder="Ask anything…"]';
const ARENA_ATTACH_SELECTOR = 'form button[aria-label="Add files"]';

type ArenaInsertionPoint = { container: Element; insertAfter: Element };

function isVisible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

export function findArenaInsertionPoint(doc: Document = document): ArenaInsertionPoint | null {
  const input = Array.from(doc.querySelectorAll<HTMLTextAreaElement>(ARENA_INPUT_SELECTOR)).find(isVisible);
  const composer = input?.closest('form');
  if (!composer) return null;

  const attachButton = Array.from(
    composer.querySelectorAll<HTMLButtonElement>(ARENA_ATTACH_SELECTOR),
  ).find(isVisible);
  const actionContainer = attachButton?.parentElement;
  if (!attachButton || !actionContainer) return null;

  return { container: actionContainer, insertAfter: attachButton };
}

export class ArenaAdapter extends BaseAdapterPlugin {
  readonly name = 'ArenaAdapter';
  readonly version = '1.0.0';
  readonly hostnames = ['arena.ai'];
  readonly capabilities: AdapterCapability[] = ['text-insertion', 'form-submission', 'dom-manipulation'];

  private observer: MutationObserver | null = null;
  private popoverContainer: HTMLElement | null = null;
  private popoverRoot: Root | null = null;

  isSupported(): boolean {
    return window.location.hostname === 'arena.ai' &&
      window.location.pathname.replace(/\/+$/, '') === '/text/direct';
  }

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
    const input = options?.targetElement ?? Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(ARENA_INPUT_SELECTOR),
    ).find(isVisible);
    if (!(input instanceof HTMLTextAreaElement) || !input.isConnected) {
      this.context.logger.error('Could not find the Arena Direct Chat input');
      return false;
    }

    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
    const input = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(ARENA_INPUT_SELECTOR),
    ).find(isVisible);
    const composer = options?.formElement ?? input?.closest('form');
    const button = Array.from(
      composer?.querySelectorAll<HTMLButtonElement>('button[aria-label="Send message"]') ?? [],
    ).find(candidate => isVisible(candidate) && !candidate.disabled);
    if (!button) {
      this.context.logger.error('Could not find an enabled Arena Direct Chat send button');
      return false;
    }

    button.click();
    return true;
  }

  private ensurePopover(): void {
    if (this.currentStatus !== 'active') return;
    if (!this.isSupported()) {
      this.removePopover();
      return;
    }
    if (this.popoverContainer?.isConnected) return;

    this.disposeDisconnectedPopover();
    if (document.getElementById('mcp-popover-container')) return;

    const insertionPoint = findArenaInsertionPoint();
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
      this.context.logger.error('Failed to render the Arena MCP control:', error);
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
        ui?.setMCPEnabled?.(enabled, 'arena-mcp-popover-toggle');
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
    if (this.popoverContainer && !this.popoverContainer.isConnected) {
      this.popoverRoot?.unmount();
      this.popoverRoot = null;
      this.popoverContainer = null;
    }
  }

  private removePopover(): void {
    this.popoverRoot?.unmount();
    this.popoverRoot = null;
    this.popoverContainer?.remove();
    this.popoverContainer = null;
  }
}
