import { SA_COMPOSER_BUTTON_SELECTOR } from './SAComposerReadiness.js'

export type SAAutomationEvaluator = <T>(expression: string) => Promise<T | undefined>

type ControlObservation = {
  ready: boolean
  valid: boolean
  openedPanel: boolean
  action: string | null
  panel: { buttonPresent: boolean; expanded: boolean; visible: boolean }
  persisted: Record<string, boolean>
  rendered: Record<string, unknown>
}

const DOM_HELPERS = `
  const roots = [document];
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const all = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]);
  const visible = element => {
    if (!element) return false;
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden';
  };
  const popover = all('.mcp-popover').find(visible) || null;
  const button = all(${JSON.stringify(SA_COMPOSER_BUTTON_SELECTOR)}).find(visible) || null;
`

function inspectionScript(configure: boolean, allowOpenPanel: boolean): string {
  return `(async () => {
    ${DOM_HELPERS}
    let state = {};
    let storageReadable = true;
    try {
      state = JSON.parse(localStorage.getItem('mcp-super-assistant-ui-store') || '{}').state || {};
    } catch {
      storageReadable = false;
    }
    const preferences = state.preferences || {};
    const find = selector => popover?.querySelector(selector) || null;
    const toggle = id => {
      const input = find('#' + id);
      if (!input) return null;
      return {
        checked: input.checked === true,
        disabled: input.disabled === true,
        visible: visible(input.closest('.mcp-toggle-item') || input.parentElement)
      };
    };
    const mcp = find('#mcp-toggle');
    const sidebar = document.querySelector('#mcp-sidebar-shadow-host')?.shadowRoot?.querySelector('.sidebar') || null;
    const push = [...(sidebar?.querySelectorAll('button[role="switch"]') || [])]
      .find(element => element.textContent.trim() === 'Push Content Mode') || null;
    const minimized = sidebar?.classList.contains('collapsed') === true;
    const sidebarInlineWidth = Number.parseFloat(sidebar?.style.width || '');
    const sidebarComputedWidth = sidebar
      ? Number.parseFloat(getComputedStyle(sidebar).width)
      : Number.NaN;
    const rootCollapsed = document.documentElement.classList.contains('sidebar-collapsed');
    const pushLayoutWidth = document.documentElement.style.getPropertyValue('--sidebar-width-mcp');
    const compactSidebarState = {
      collapsed: minimized,
      inlineWidth: sidebar?.style.width || null,
      computedWidth: Number.isFinite(sidebarComputedWidth) ? sidebarComputedWidth : null,
      rootCollapsed,
      pushLayoutWidth: pushLayoutWidth || null
    };
    const compactSidebar = Boolean(
      minimized && visible(sidebar) &&
      sidebarInlineWidth <= 56.5 && sidebarComputedWidth <= 56.5 &&
      (rootCollapsed || pushLayoutWidth === '56px' || sidebarInlineWidth === 56 || sidebarComputedWidth === 56)
    );
    const persisted = {
      storageReadable,
      mcpEnabled: state.mcpEnabled === true,
      isPushMode: preferences.isPushMode === true,
      autoInsert: preferences.autoInsert === true,
      autoSubmit: preferences.autoSubmit === true,
      autoExecute: preferences.autoExecute === true,
      sidebarVisible: state.sidebar?.isVisible === true,
      sidebarMinimized: state.sidebar?.isMinimized === true,
      preferenceMinimized: preferences.isMinimized === true
    };
    const rendered = {
      mcpEnabled: mcp ? mcp.checked === true : null,
      mcpVisible: visible(mcp?.closest('.mcp-toggle-item') || mcp?.parentElement),
      pushContentMode: push ? push.getAttribute('aria-checked') === 'true' : null,
      pushContentModeVisible: visible(push),
      sidebarVisible: visible(sidebar),
      compactSidebar,
      compactSidebarState,
      autoInsert: toggle('auto-insert-toggle'),
      autoSubmit: toggle('auto-submit-toggle'),
      autoExecute: toggle('auto-execute-toggle')
    };
    const ready = Boolean(popover && mcp && rendered.autoInsert && rendered.autoSubmit && rendered.autoExecute);
    const sidebarPreferencesValid = !persisted.sidebarVisible || (
      persisted.isPushMode && persisted.sidebarMinimized && persisted.preferenceMinimized
    );
    const sidebarRenderedValid = !persisted.sidebarVisible || (
      rendered.pushContentMode === true && rendered.pushContentModeVisible &&
      rendered.sidebarVisible && rendered.compactSidebar
    );
    const observation = {
      ready,
      valid: ready &&
        persisted.storageReadable && persisted.mcpEnabled &&
        persisted.autoInsert && persisted.autoSubmit && persisted.autoExecute &&
        sidebarPreferencesValid && sidebarRenderedValid &&
        rendered.mcpEnabled === true && rendered.mcpVisible &&
        [rendered.autoInsert, rendered.autoSubmit, rendered.autoExecute].every(control =>
          control?.checked === true && control.disabled === false && control.visible),
      openedPanel: false,
      action: null,
      panel: {
        buttonPresent: Boolean(button),
        expanded: button?.getAttribute('aria-expanded') === 'true',
        visible: Boolean(popover)
      },
      persisted,
      rendered
    };

    // Recheck after every render. An expanded button may still be mounting its portal.
    if (!popover) {
      if (${JSON.stringify(allowOpenPanel)} && button && !button.disabled &&
          button.getAttribute('aria-expanded') !== 'true') {
        button.click();
        observation.openedPanel = true;
        observation.action = 'open-settings';
      }
      return observation;
    }

    const compactLayoutIsStale = minimized && visible(sidebar) &&
      sidebarInlineWidth <= 56.5 && sidebarComputedWidth <= 56.5 &&
      (!rootCollapsed || pushLayoutWidth !== '56px');
    if (rendered.pushContentMode === true && compactLayoutIsStale) {
      const manager = window.activeSidebarManager;
      if (manager && typeof manager.setPushContentMode === 'function') {
        manager.setPushContentMode(true, 56, true);
        observation.action = 'apply-compact-push-layout';
      }
      return observation;
    }
    if (!${JSON.stringify(configure)}) return observation;

    const controls = [
      { key: 'mcpEnabled', element: mcp, checked: rendered.mcpEnabled, visible: rendered.mcpVisible },
      { key: 'isPushMode', element: push, checked: rendered.pushContentMode, visible: rendered.pushContentModeVisible },
      { key: 'autoInsert', element: find('#auto-insert-toggle'), checked: rendered.autoInsert?.checked, visible: rendered.autoInsert?.visible },
      { key: 'autoSubmit', element: find('#auto-submit-toggle'), checked: rendered.autoSubmit?.checked, visible: rendered.autoSubmit?.visible },
      { key: 'autoExecute', element: find('#auto-execute-toggle'), checked: rendered.autoExecute?.checked, visible: rendered.autoExecute?.visible }
    ];
    const control = controls.find(item => item.checked === false && item.visible &&
      item.element && !item.element.disabled && item.element.getAttribute('aria-disabled') !== 'true');
    if (control) {
      control.element.click();
      observation.action = 'enable-' + control.key;
      return observation;
    }

    if (rendered.mcpEnabled === true && persisted.sidebarVisible && !rendered.sidebarVisible) {
      const manager = window.activeSidebarManager;
      if (manager && typeof manager.show === 'function') {
        await manager.show();
        observation.action = 'show-sidebar';
      }
      return observation;
    }
    const minimize = sidebar?.querySelector('button[aria-label="Minimize sidebar"]');
    if (!minimized && visible(minimize) && !minimize.disabled &&
        !sidebar.classList.contains('sidebar-transitioning')) {
      minimize.click();
      observation.action = 'minimize-sidebar';
    }
    return observation;
  })()`
}

export async function runSAStartupAutomationControls(
  evaluate: SAAutomationEvaluator,
  options: {
    platformId: string
    configure: boolean
    timeoutMs?: number
    pollIntervalMs?: number
  },
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  const interval = options.pollIntervalMs ?? 500
  let openedPanel = false
  let panelWasExpanded = false
  let stableSamples = 0
  let validConfigurationObserved = false
  let lastState: ControlObservation | undefined
  try {
    while (Date.now() < deadline) {
      lastState = await evaluate<ControlObservation>(
        inspectionScript(options.configure, !panelWasExpanded),
      )
      openedPanel ||= lastState?.openedPanel === true
      panelWasExpanded ||= lastState?.panel.expanded === true || lastState?.panel.visible === true
      validConfigurationObserved ||= lastState?.valid === true
      if (openedPanel && !lastState?.panel.visible && validConfigurationObserved) return
      stableSamples = lastState?.valid === true && !lastState.action ? stableSamples + 1 : 0
      if (stableSamples >= 2) return
      const remaining = deadline - Date.now()
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)))
    }
    const phase = options.configure ? 'configuration through the interface' : 'verification after reload'
    throw new Error(
      `SuperAssistant automation ${phase} failed on the ${options.platformId} page: ` +
      JSON.stringify(lastState ?? { ready: false }),
    )
  } finally {
    if (openedPanel) {
      try {
        await evaluate(`(() => {
          ${DOM_HELPERS}
          const close = popover?.querySelector('.mcp-close-button');
          if (close && !close.disabled) close.click();
          return Boolean(close);
        })()`)
      } catch {
        // Navigation can dispose the execution context; preserve the original outcome.
      }
    }
  }
}
