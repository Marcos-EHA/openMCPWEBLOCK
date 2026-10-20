/** Labels remain fallbacks for older extension builds. */
export const SA_COMPOSER_BUTTON_SELECTOR =
  '#mcp-popover-container button[data-testid="mcp-settings-button"], ' +
  '#mcp-popover-container button[aria-label^="Ajustes MCP"], ' +
  '#mcp-popover-container button[aria-label^="MCP Settings"]'

/** Shared with browser regression tests and the runtime readiness gate. */
export const SA_COMPOSER_READINESS_SCRIPT = `(() => {
  const button = document.querySelector(${JSON.stringify(SA_COMPOSER_BUTTON_SELECTOR)});
  const mount = document.querySelector('#mcp-popover-container');
  const container = button?.closest('#mcp-popover-container');
  const composer = container?.closest('form') ||
    container?.closest('[data-testid*="composer"]') ||
    container?.closest('#inputfielddiv');
  const bounds = button?.getBoundingClientRect();
  const composerBounds = composer?.getBoundingClientRect();
  const style = button ? getComputedStyle(button) : null;
  const width = bounds?.width || 0;
  const height = bounds?.height || 0;
  const inViewport = Boolean(bounds && width > 0 && height > 0 &&
    bounds.left >= 0 && bounds.top >= 0 &&
    bounds.right <= innerWidth && bounds.bottom <= innerHeight);
  const withinComposerBounds = Boolean(bounds && composerBounds &&
    bounds.left >= composerBounds.left - 1 && bounds.top >= composerBounds.top - 1 &&
    bounds.right <= composerBounds.right + 1 && bounds.bottom <= composerBounds.bottom + 1);
  const text = container?.querySelector('.mcp-chatgpt-button-text');
  const textStyle = text ? getComputedStyle(text) : null;
  return {
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    buttonPresent: Boolean(button),
    compact: Boolean(button && (
      container?.classList.contains('mcp-chatgpt-inline-composer-control') ||
      (width > 0 && height > 0 && width <= 40 && height <= 40 &&
        (!text || textStyle?.display === 'none' || textStyle?.visibility === 'hidden'))
    )),
    insideComposer: Boolean(composer && container && composer.contains(container) && withinComposerBounds),
    visible: Boolean(button && inViewport && style?.display !== 'none' && style?.visibility !== 'hidden'),
    inViewport,
    width,
    height,
    containerPresent: Boolean(mount),
    containerButtonCount: mount?.querySelectorAll('button').length || 0,
    editors: Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).slice(0,4).map(editor => {
      const editorBounds = editor.getBoundingClientRect();
      const ancestors = [];
      let parent = editor.parentElement;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        ancestors.push({ tag: parent.tagName, id: parent.id, testId: parent.getAttribute('data-testid'), buttonCount: parent.querySelectorAll('button').length });
      }
      return { tag: editor.tagName, id: editor.id, width: editorBounds.width, height: editorBounds.height, ancestors };
    }),
    dialogCount: document.querySelectorAll('[role="dialog"]').length
  };
})()`
