import type { ParamValueElement } from '../core/types';
import { CONFIG } from '../core/config';
import { freshAutoExecutionToken, isFreshAutoExecutionAllowed } from './freshAutoExecution';
import { containsFunctionCalls, extractLanguageTag } from '../parser/index';
import { safelySetContent } from '../utils/index';
import { applyThemeClass } from '../utils/themeDetector';
import {
  addRawXmlToggle,
  addExecuteButton,
  setupAutoScroll,
  smoothlyUpdateBlockContent,
  extractFunctionParameters,
} from './components';
import {
  getPreviousExecution,
  getPreviousExecutionLegacy,
  generateContentSignature,
  getScopeKey,
  buildLogicalCallKey,
  getExecutionClaim,
  claimExecutionAtomic,
  releaseUnstartedExecutionClaim,
  isTerminalStatus,
  findDraftClaim,
} from '../mcpexecute/storage';
import { extractJSONFunctionInfo, extractJSONParameters } from '../parser/jsonFunctionParser';
import { findAutoExecutionTarget } from './autoExecutionTarget';
import { createLogger } from '@extension/shared/lib/logger';
import { recordExecutionDiagnostic } from '@extension/shared/lib/execution-diagnostics';

// Define custom property for tracking scroll state

const logger = createLogger('FunctionBlockRenderer');

declare global {
  interface HTMLElement {
    _userHasScrolled?: boolean;
    _scrollInitialized?: boolean;
    _scrollCleanup?: () => void;
    _scrollHandlersInitialized?: boolean;
    value?: string; // For compatibility with input elements
  }
}

// Constants
const STREAMING_DEBOUNCE_MS = 16; // ~60fps for smooth updates
const MAX_AUTO_EXECUTE_ATTEMPTS = 3;
const CACHE_TTL = 1000; // 1 second cache TTL
const STREAMING_TIMEOUT = 1500;

// Performance optimizations: Pre-compiled regex patterns
const REGEX_CACHE = {
  paramStartRegex: /<parameter\s+name="([^"]+)"[^>]*>/gs,
  invokeMatch: /<invoke name="([^"]+)"(?:\s+call_id="([^"]+)")?>/i,
  cdataMatch: /<!\[CDATA\[(.*?)(?:\]\]>)?$/s,
  endParameterTag: '</parameter>',
} as const;

// Type definitions
interface ParsedContent {
  functionName: string;
  callId: string;
  parameters: Record<string, string>;
}

interface CachedElements {
  functionNameElement?: HTMLDivElement;
  paramsContainer?: HTMLDivElement;
  buttonContainer?: HTMLDivElement;
  lastCacheTime: number;
}

interface ContentCache {
  content: string;
  functionName: string;
  callId: string;
  parameters: Record<string, string>;
  lastHash: string;
}

interface ScrollHandler {
  element: HTMLElement;
  timeout?: number;
  cleanup: () => void;
}

// Performance caches
const contentParsingCache = new WeakMap<HTMLElement, ContentCache>();
const elementQueryCache = new WeakMap<HTMLElement, CachedElements>();
const pendingDOMUpdates = new Map<string, (() => void)[]>();
const streamingDebouncers = new Map<string, number>();
const activeTimeouts = new Map<string, number>();

// RAF scheduling
let rafScheduled = false;

// Utility function to get automation state
function getAutomationState() {
  // First try the new store-based state (exposed by automation service)
  const automationState = (window as any).__mcpAutomationState;
  if (automationState) {
    return {
      autoInsert: automationState.autoInsert || false,
      autoSubmit: automationState.autoSubmit || false,
      autoExecute: automationState.autoExecute || false,
    };
  }
  
  // Fallback to legacy toggle state
  const legacyState = (window as any).toggleState;
  return {
    autoInsert: legacyState?.autoInsert === true,
    autoSubmit: legacyState?.autoSubmit === true,
    autoExecute: legacyState?.autoExecute === true,
  };
}

// Common style configurations
const STREAMING_STYLES = {
  pre: {
    margin: '0',
    padding: '12px 14px',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    width: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    lineHeight: '1.5',
    transition: 'opacity 0.1s ease-out',
    transform: 'translateZ(0)',
    backfaceVisibility: 'hidden',
    perspective: '1000px',
    color: 'inherit',
    background: 'transparent',
    border: 'none',
    overflow: 'auto',
    maxHeight: '300px',
    scrollBehavior: 'smooth',
  },
  paramValue: {
    transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
    transformOrigin: 'top left',
    willChange: 'auto',
    contain: 'layout style paint',
    minHeight: '1.2em',
    position: 'relative',
  },
  contentWrapper: {
    position: 'relative',
    overflow: 'hidden',
    minHeight: 'inherit',
  },
  paramsContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    width: '100%',
  },
} as const;

// Common DOM utilities
const DOMUtils = {
  applyStyles: (element: HTMLElement, styles: Record<string, any>): void => {
    Object.assign(element.style, styles);
  },

  createElement: <T extends HTMLElement>(
    tag: string,
    className?: string,
    attributes?: Record<string, string>,
    styles?: Record<string, any>,
  ): T => {
    const element = document.createElement(tag) as T;
    if (className) element.className = className;
    if (attributes) {
      Object.entries(attributes).forEach(([key, value]) => {
        element.setAttribute(key, value);
      });
    }
    if (styles) DOMUtils.applyStyles(element, styles);
    return element;
  },

  setContent: (element: HTMLElement, content: string, isHTML = false): void => {
    if (isHTML) {
      element.innerHTML = content;
    } else {
      element.textContent = content;
    }
  },

  updateTextIfChanged: (element: HTMLElement, newText: string): boolean => {
    if (element.textContent !== newText) {
      element.textContent = newText;
      return true;
    }
    return false;
  },
};

// Cache management utilities
const CacheUtils = {
  generateContentHash: (content: string): string => {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  },

  getCachedElements: (
    blockDiv: HTMLElement,
  ): {
    functionNameElement?: HTMLDivElement;
    paramsContainer?: HTMLDivElement;
    buttonContainer?: HTMLDivElement;
  } => {
    const now = Date.now();
    let cache = elementQueryCache.get(blockDiv);

    if (!cache || now - cache.lastCacheTime > CACHE_TTL) {
      cache = {
        functionNameElement: blockDiv.querySelector<HTMLDivElement>('.function-name') || undefined,
        paramsContainer: blockDiv.querySelector<HTMLDivElement>('.function-params') || undefined,
        buttonContainer: blockDiv.querySelector<HTMLDivElement>('.function-buttons') || undefined,
        lastCacheTime: now,
      };
      elementQueryCache.set(blockDiv, cache);
    }

    return cache;
  },

  parseContentEfficiently: (block: HTMLElement, rawContent: string): ParsedContent => {
    const contentHash = CacheUtils.generateContentHash(rawContent);
    let cached = contentParsingCache.get(block);

    if (cached && cached.lastHash === contentHash) {
      return {
        functionName: cached.functionName,
        callId: cached.callId,
        parameters: cached.parameters,
      };
    }

    const invokeMatch = REGEX_CACHE.invokeMatch.exec(rawContent);
    const functionName = invokeMatch ? invokeMatch[1] : 'function';
    const callId =
      invokeMatch && invokeMatch[2]
        ? invokeMatch[2]
        : `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const parameters: Record<string, string> = {};
    REGEX_CACHE.paramStartRegex.lastIndex = 0;

    let match;
    while ((match = REGEX_CACHE.paramStartRegex.exec(rawContent)) !== null) {
      const paramName = match[1];
      const startIndex = match.index + match[0].length;
      const endTagIndex = rawContent.indexOf(REGEX_CACHE.endParameterTag, startIndex);

      let extractedValue =
        endTagIndex !== -1 ? rawContent.substring(startIndex, endTagIndex) : rawContent.substring(startIndex);

      const cdataMatch = REGEX_CACHE.cdataMatch.exec(extractedValue);
      extractedValue = cdataMatch ? cdataMatch[1] : extractedValue.trim();

      parameters[paramName] = extractedValue;
    }

    cached = {
      content: rawContent,
      functionName,
      callId,
      parameters,
      lastHash: contentHash,
    };
    contentParsingCache.set(block, cached);

    return { functionName, callId, parameters };
  },
};

// Performance utilities
const PerformanceUtils = {
  batchDOMOperation: (blockId: string, operation: () => void): void => {
    if (!pendingDOMUpdates.has(blockId)) {
      pendingDOMUpdates.set(blockId, []);
    }
    pendingDOMUpdates.get(blockId)!.push(operation);

    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        pendingDOMUpdates.forEach(operations => {
          operations.forEach(op => op());
        });
        pendingDOMUpdates.clear();
        rafScheduled = false;
      });
    }
  },

  batchStreamingUpdate: (paramId: string, operation: () => void): void => {
    const existing = streamingDebouncers.get(paramId);
    if (existing) {
      clearTimeout(existing);
    }

    streamingDebouncers.set(
      paramId,
      window.setTimeout(() => {
        requestAnimationFrame(() => {
          operation();
          streamingDebouncers.delete(paramId);
        });
      }, STREAMING_DEBOUNCE_MS),
    );
  },

  cleanupTimeout: (key: string): void => {
    const timeoutId = activeTimeouts.get(key);
    if (timeoutId) {
      clearTimeout(timeoutId);
      activeTimeouts.delete(key);
    }
  },

  setManagedTimeout: (key: string, callback: () => void, delay: number): void => {
    PerformanceUtils.cleanupTimeout(key);
    const timeoutId = window.setTimeout(() => {
      callback();
      activeTimeouts.delete(key);
    }, delay);
    activeTimeouts.set(key, timeoutId);
  },
};

// Scroll management utilities
const ScrollUtils = {
  createScrollHandler: (element: HTMLElement): ScrollHandler => {
    let scrollTimeout: number | undefined;

    const onScroll = () => {
      (element as any)._userHasScrolled = true;

      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = window.setTimeout(() => {
        const isNearBottom = element.scrollTop >= element.scrollHeight - element.clientHeight - 50;
        if (isNearBottom) {
          (element as any)._userHasScrolled = false;
        }
      }, 3000);
    };

    const cleanup = () => {
      element.removeEventListener('scroll', onScroll);
      if (scrollTimeout) clearTimeout(scrollTimeout);
      (element as any)._scrollInitialized = false;
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    (element as any)._scrollInitialized = true;
    (element as any)._scrollCleanup = cleanup;

    return { element, timeout: scrollTimeout, cleanup };
  },

  setupScrollTracking: (paramValueElement: HTMLElement): void => {
    if (!(paramValueElement as any)._scrollHandlersInitialized) {
      ScrollUtils.createScrollHandler(paramValueElement);

      const preElement = paramValueElement.querySelector('pre');
      if (preElement) {
        ScrollUtils.createScrollHandler(preElement);
      }

      (paramValueElement as any)._scrollHandlersInitialized = true;
    }
  },

  performOptimizedScroll: (paramValueElement: HTMLElement, forceScroll: boolean = false): void => {
    requestAnimationFrame(() => {
      // Auto-scroll the parameter value container
      if (paramValueElement.scrollHeight > paramValueElement.clientHeight) {
        const shouldAutoScroll = forceScroll || !(paramValueElement as any)._userHasScrolled;

        if (shouldAutoScroll) {
          const targetScroll = paramValueElement.scrollHeight - paramValueElement.clientHeight;
          const currentScroll = paramValueElement.scrollTop;
          const diff = targetScroll - currentScroll;

          if (diff > 10) {
            paramValueElement.scrollTo({
              top: targetScroll,
              behavior: 'smooth',
            });
          } else if (diff > 0) {
            paramValueElement.scrollTop = targetScroll;
          }
        }
      }

      // Auto-scroll the inner pre element if it exists and has content
      const preElement = paramValueElement.querySelector('pre');
      if (preElement && preElement.scrollHeight > preElement.clientHeight) {
        const shouldAutoScrollPre = forceScroll || !(preElement as any)._userHasScrolled;

        if (shouldAutoScrollPre) {
          const targetScroll = preElement.scrollHeight - preElement.clientHeight;
          const currentScroll = preElement.scrollTop;
          const diff = targetScroll - currentScroll;

          if (diff > 10) {
            preElement.scrollTo({
              top: targetScroll,
              behavior: 'smooth',
            });
          } else if (diff > 0) {
            preElement.scrollTop = targetScroll;
          }
        }
      }
    });
  },

  // Enhanced scroll function specifically for streaming content
  performStreamingScroll: (paramValueElement: HTMLElement): void => {
    // Reset user scroll tracking during active streaming
    (paramValueElement as any)._userHasScrolled = false;
    const preElement = paramValueElement.querySelector('pre');
    if (preElement) {
      (preElement as any)._userHasScrolled = false;
    }
    
    // Force scroll to bottom for streaming content
    ScrollUtils.performOptimizedScroll(paramValueElement, true);
  },
};

// Monaco editor CSP-compatible configuration
const configureMonacoEditorForCSP = (): void => {
  if (typeof window !== 'undefined' && (window as any).monaco) {
    try {
      (window as any).monaco.editor.onDidCreateEditor((editor: any) => {
        editor.updateOptions({
          wordBasedSuggestions: false,
          snippetSuggestions: false,
          suggestOnTriggerCharacters: false,
          semanticHighlighting: { enabled: false },
          codeLens: false,
          formatOnType: false,
          folding: false,
        });
      });

      (window as any).MonacoEnvironment = {
        getWorkerUrl: () =>
          'data:text/javascript;charset=utf-8,logger.debug("Monaco worker disabled for CSP compatibility");',
      };

      logger.debug('Monaco editor configured for CSP compatibility');
    } catch (e) {
      logger.error('Failed to configure Monaco editor for CSP:', e);
    }
  }
};

// Inject enhanced streaming styles for better UX
const injectStreamingStyles = (() => {
  let injected = false;
  return () => {
    if (injected) return;
    injected = true;

    const style = DOMUtils.createElement<HTMLStyleElement>('style');
    style.textContent = `
      .streaming-param-name {
        position: relative;
      }
      
      .param-value[data-streaming="true"] {
        position: relative;
        background: linear-gradient(135deg, 
          rgba(0, 212, 255, 0.03) 0%, 
          rgba(0, 153, 204, 0.01) 100%);
        border-left: 2px solid rgba(0, 212, 255, 0.2);
        padding-left: 8px;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      
      .param-value[data-streaming="true"] .content-wrapper {
        animation: subtle-breathe 3s ease-in-out infinite;
      }
      
      @keyframes subtle-breathe {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.001); }
      }
      
      /* Enhanced scrolling styles */
      .param-value[data-streaming="true"] {
        overflow-y: auto !important;
        max-height: 300px !important;
        scroll-behavior: smooth !important;
      }
      
      .param-value[data-streaming="true"]::-webkit-scrollbar {
        width: 6px;
      }
      
      .param-value[data-streaming="true"]::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.1);
        border-radius: 3px;
      }
      
      .param-value[data-streaming="true"]::-webkit-scrollbar-thumb {
        background: rgba(0, 212, 255, 0.5);
        border-radius: 3px;
        transition: background 0.2s ease;
      }
      
      .param-value[data-streaming="true"]::-webkit-scrollbar-thumb:hover {
        background: rgba(0, 212, 255, 0.8);
      }
      
      /* Fix text color inheritance for both themes */
      .function-block.theme-light .param-value[data-streaming="true"] pre,
      .function-block:not(.theme-dark) .param-value[data-streaming="true"] pre {
        color: inherit !important;
      }
      
      .function-block.theme-dark .param-value[data-streaming="true"] pre {
        color: inherit !important;
      }
      
      /* Spinner animation styles - ensure they're loaded */
      .spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(26, 115, 232, 0.3);
        border-top: 2px solid #1a73e8;
        border-radius: 50%;
        animation: spinner-spin 1s linear infinite;
        flex-shrink: 0;
        will-change: transform;
        transform: translate3d(0, 0, 0);
        backface-visibility: hidden;
        contain: layout style;
      }
      
      .function-block.theme-dark .spinner {
        border: 2px solid rgba(138, 180, 248, 0.3);
        border-top: 2px solid #8ab4f8;
      }
      
      @keyframes spinner-spin {
        0% { transform: rotate(0deg) translate3d(0,0,0); }
        100% { transform: rotate(360deg) translate3d(0,0,0); }
      }
    `;
    document.head.appendChild(style);
  };
})();

// State management for rendered elements
export const processedElements = new WeakSet<HTMLElement>();
export const renderedFunctionBlocks = new Map<string, HTMLDivElement>();

// Centralized execution tracking system to prevent race conditions and duplicate executions
interface ExecutionTracker {
  attempts: Map<string, number>;
  executed: Set<string>;
  executedFunctions: Set<string>;
  isFunctionExecuted(callId: string, contentSignature: string, functionName?: string): boolean;
  markFunctionExecuted(callId: string, contentSignature: string, functionName?: string): void;
  isBlockExecuted(blockId: string): boolean;
  markBlockExecuted(blockId: string): void;
  getAttempts(blockId: string): number;
  incrementAttempts(blockId: string): number;
  cleanupBlock(blockId: string): void;
}

// Implementation of the execution tracker
export const executionTracker: ExecutionTracker = {
  attempts: new Map<string, number>(),
  executed: new Set<string>(),
  executedFunctions: new Set<string>(),

  isFunctionExecuted(callId: string, contentSignature: string, functionName?: string): boolean {
    const scopeKey = getScopeKey();
    const effectiveName = functionName || 'unknown';
    const logicalCallKey = buildLogicalCallKey(scopeKey, effectiveName, callId, contentSignature);

    logger.debug(`isFunctionExecuted: logicalCallKey='${logicalCallKey}'`);

    // Check in-memory execution set
    if (this.executedFunctions.has(logicalCallKey)) {
      return true;
    }

    // Check canonical claims
    const claim = getExecutionClaim(logicalCallKey);
    if (claim && (isTerminalStatus(claim.status) || claim.status === 'unknown' || claim.status === 'running')) {
      return true;
    }

    // Check ambiguous draft conflict in conversations
    if (scopeKey.startsWith('chatgpt:c:')) {
      const draftClaim = findDraftClaim(effectiveName, callId, contentSignature);
      if (draftClaim) {
        logger.debug(`isFunctionExecuted: Draft conflict detected for ${logicalCallKey}, blocking auto-execution.`);
        return true;
      }
    }

    // Legacy fallback check
    if (typeof functionName === 'string') {
      const legacyKey = `${functionName}:${callId}:${contentSignature}`;
      if (this.executedFunctions.has(legacyKey)) return true;
      return getPreviousExecution(functionName, callId, contentSignature) !== null;
    } else {
      const legacyKey = `${callId}:${contentSignature}`;
      if (this.executedFunctions.has(legacyKey)) return true;
      return getPreviousExecutionLegacy(callId, contentSignature) !== null;
    }
  },

  markFunctionExecuted(callId: string, contentSignature: string, functionName?: string): void {
    const scopeKey = getScopeKey();
    const effectiveName = functionName || 'unknown';
    const logicalCallKey = buildLogicalCallKey(scopeKey, effectiveName, callId, contentSignature);
    this.executedFunctions.add(logicalCallKey);

    const legacyKey = functionName ? `${functionName}:${callId}:${contentSignature}` : `${callId}:${contentSignature}`;
    this.executedFunctions.add(legacyKey);
  },

  isBlockExecuted(blockId: string): boolean {
    return this.executed.has(blockId) === true;
  },

  markBlockExecuted(blockId: string): void {
    this.executed.add(blockId);
  },

  getAttempts(blockId: string): number {
    return this.attempts.get(blockId) || 0;
  },

  incrementAttempts(blockId: string): number {
    const current = this.getAttempts(blockId);
    const newValue = current + 1;
    this.attempts.set(blockId, newValue);
    return newValue;
  },

  cleanupBlock(blockId: string): void {
    this.attempts.delete(blockId);
  },
};

// Auto expand/collapse utilities
const AutoExpandUtils = {
  expandBlock: (blockDiv: HTMLDivElement, animate: boolean = true): void => {
    if (blockDiv.classList.contains('expanded')) return;
    
    const expandButton = blockDiv.querySelector('.expand-button') as HTMLButtonElement;
    const expandableContent = blockDiv.querySelector('.expandable-content') as HTMLDivElement;
    
    if (!expandButton || !expandableContent) return;
    
    blockDiv.classList.add('expanded', 'auto-expanded');
    
    if (animate) {
      // Smooth expansion animation
      DOMUtils.applyStyles(expandableContent, {
        display: 'block',
        maxHeight: '0px',
        opacity: '0',
        paddingTop: '0',
        paddingBottom: '0',
      });
      
      const targetHeight = expandableContent.scrollHeight + 24;
      
      requestAnimationFrame(() => {
        DOMUtils.applyStyles(expandableContent, {
          maxHeight: targetHeight + 'px',
          opacity: '1',
          paddingTop: '12px',
          paddingBottom: '12px',
          transition: 'all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        });
        
        const expandIcon = expandButton.querySelector('svg path');
        if (expandIcon) {
          expandIcon.setAttribute('d', 'M16 14l-4-4-4 4');
        }
        expandButton.title = 'Collapse function details';
      });
    } else {
      // Instant expansion
      DOMUtils.applyStyles(expandableContent, {
        display: 'block',
        maxHeight: 'none',
        opacity: '1',
        paddingTop: '12px',
        paddingBottom: '12px',
      });
    }
  },
  
  collapseBlock: (blockDiv: HTMLDivElement, animate: boolean = true): void => {
    if (!blockDiv.classList.contains('expanded') || !blockDiv.classList.contains('auto-expanded')) return;
    
    const expandButton = blockDiv.querySelector('.expand-button') as HTMLButtonElement;
    const expandableContent = blockDiv.querySelector('.expandable-content') as HTMLDivElement;
    
    if (!expandButton || !expandableContent) return;
    
    blockDiv.classList.remove('expanded', 'auto-expanded');
    
    if (animate) {
      // Smooth collapse animation
      const currentHeight = expandableContent.scrollHeight;
      expandableContent.style.maxHeight = currentHeight + 'px';
      expandableContent.offsetHeight; // Force reflow
      
      requestAnimationFrame(() => {
        DOMUtils.applyStyles(expandableContent, {
          maxHeight: '0px',
          opacity: '0',
          paddingTop: '0',
          paddingBottom: '0',
          transition: 'all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        });
        
        const expandIcon = expandButton.querySelector('svg path');
        if (expandIcon) {
          expandIcon.setAttribute('d', 'M8 10l4 4 4-4');
        }
        expandButton.title = 'Expand function details';
      });
      
      // Hide after animation completes
      setTimeout(() => {
        if (!blockDiv.classList.contains('expanded')) {
          expandableContent.style.display = 'none';
        }
      }, 400);
    } else {
      // Instant collapse
      DOMUtils.applyStyles(expandableContent, {
        display: 'none',
        maxHeight: '0px',
        opacity: '0',
        paddingTop: '0',
        paddingBottom: '0',
      });
    }
  },
  
  scheduleAutoCollapse: (blockDiv: HTMLDivElement, delay: number = 2000): void => {
    const blockId = blockDiv.getAttribute('data-block-id');
    if (!blockId) return;
    
    const timeoutKey = `auto-collapse-${blockId}`;
    PerformanceUtils.cleanupTimeout(timeoutKey);
    
    PerformanceUtils.setManagedTimeout(
      timeoutKey,
      () => {
        // Only collapse if no streaming is active and block is auto-expanded
        const stillStreaming = blockDiv.querySelector('[data-streaming="true"]');
        if (!stillStreaming && blockDiv.classList.contains('auto-expanded')) {
          AutoExpandUtils.collapseBlock(blockDiv, true);
        }
      },
      delay
    );
  },
};

// Function block element creation utilities
const BlockElementUtils = {
  createFunctionNameSection: (
    functionName: string,
    callId: string,
    isComplete: boolean,
    isPreExistingIncomplete: boolean,
  ): HTMLDivElement => {
    const functionNameElement = DOMUtils.createElement<HTMLDivElement>('div', 'function-name');

    const leftSection = DOMUtils.createElement<HTMLDivElement>('div', 'function-name-left');

    // Create a container for function name and spinner (inline)
    const functionNameRow = DOMUtils.createElement<HTMLDivElement>('div', 'function-name-row');
    DOMUtils.applyStyles(functionNameRow, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    });

    const functionNameText = DOMUtils.createElement<HTMLSpanElement>('span', 'function-name-text');
    functionNameText.textContent = functionName;
    functionNameRow.appendChild(functionNameText);

    if (!isComplete && !isPreExistingIncomplete) {
      const spinner = DOMUtils.createElement<HTMLDivElement>('div', 'spinner');
      functionNameRow.appendChild(spinner);
    }

    leftSection.appendChild(functionNameRow);

    const rightSection = DOMUtils.createElement<HTMLDivElement>('div', 'function-name-right');

    if (callId) {
      const callIdElement = DOMUtils.createElement<HTMLSpanElement>('span', 'call-id');
      callIdElement.textContent = callId;
      rightSection.appendChild(callIdElement);
    }

    functionNameElement.appendChild(leftSection);
    functionNameElement.appendChild(rightSection);

    return functionNameElement;
  },

  createExpandButton: (): HTMLButtonElement => {
    const expandButton = DOMUtils.createElement<HTMLButtonElement>('button', 'expand-button');
    expandButton.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    expandButton.title = 'Expand function details';
    return expandButton;
  },

  createExpandableContent: (): HTMLDivElement => {
    const expandableContent = DOMUtils.createElement<HTMLDivElement>('div', 'expandable-content');
    DOMUtils.applyStyles(expandableContent, {
      display: 'none',
      overflow: 'hidden',
      transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
      maxHeight: '0px',
      opacity: '0',
    });
    return expandableContent;
  },

  setupExpandCollapse: (
    blockDiv: HTMLDivElement,
    expandButton: HTMLButtonElement,
    expandableContent: HTMLDivElement,
  ): void => {
    const toggleExpandCollapse = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();

      const isCurrentlyExpanded = blockDiv.classList.contains('expanded');
      const expandIcon = expandButton.querySelector('svg path');

      if (isCurrentlyExpanded) {
        // Collapse
        blockDiv.classList.remove('expanded');

        // Get current computed height including padding
        const currentHeight = expandableContent.scrollHeight;
        expandableContent.style.maxHeight = currentHeight + 'px';
        expandableContent.offsetHeight; // Force reflow

        requestAnimationFrame(() => {
          DOMUtils.applyStyles(expandableContent, {
            maxHeight: '0px',
            opacity: '0',
            paddingTop: '0',
            paddingBottom: '0',
          });

          if (expandIcon) {
            expandIcon.setAttribute('d', 'M8 10l4 4 4-4');
          }
          expandButton.title = 'Expand function details';
        });

        // Hide after animation completes
        setTimeout(() => {
          if (!blockDiv.classList.contains('expanded')) {
            expandableContent.style.display = 'none';
          }
        }, 250);
      } else {
        // Expand
        blockDiv.classList.add('expanded');

        // Prepare for expansion
        DOMUtils.applyStyles(expandableContent, {
          display: 'block',
          maxHeight: '0px',
          opacity: '0',
          paddingTop: '0',
          paddingBottom: '0',
        });

        // Calculate target height with padding
        const targetHeight = expandableContent.scrollHeight + 24; // 12px top + 12px bottom padding

        requestAnimationFrame(() => {
          DOMUtils.applyStyles(expandableContent, {
            maxHeight: targetHeight + 'px',
            opacity: '1',
            paddingTop: '12px',
            paddingBottom: '12px',
          });

          if (expandIcon) {
            expandIcon.setAttribute('d', 'M16 14l-4-4-4 4');
          }
          expandButton.title = 'Collapse function details';
        });
      }
    };

    // Attach click handler to expand button
    expandButton.onclick = toggleExpandCollapse;

    // Make entire function-name area clickable
    const functionNameElement = blockDiv.querySelector('.function-name') as HTMLDivElement;
    if (functionNameElement) {
      DOMUtils.applyStyles(functionNameElement, {
        cursor: 'pointer',
      });
      functionNameElement.onclick = toggleExpandCollapse;
    }
  },
};

// Parameter element utilities
const ParamElementUtils = {
  createParamName: (name: string, paramId: string): HTMLDivElement => {
    const paramNameElement = DOMUtils.createElement<HTMLDivElement>('div', 'param-name', { 'data-param-id': paramId });
    paramNameElement.textContent = name;
    return paramNameElement;
  },

  createParamValue: (paramId: string, name: string): HTMLDivElement => {
    const paramValueElement = DOMUtils.createElement<HTMLDivElement>('div', 'param-value', {
      'data-param-id': paramId,
      'data-param-name': name,
    });

    DOMUtils.applyStyles(paramValueElement, STREAMING_STYLES.paramValue);
    return paramValueElement;
  },

  createStreamingContent: (
    paramValueElement: HTMLDivElement,
  ): { preElement: HTMLPreElement; contentWrapper: HTMLDivElement } => {
    paramValueElement.innerHTML = '';

    const contentWrapper = DOMUtils.createElement<HTMLDivElement>('div', 'content-wrapper');
    DOMUtils.applyStyles(contentWrapper, STREAMING_STYLES.contentWrapper);

    const preElement = DOMUtils.createElement<HTMLPreElement>('pre');
    DOMUtils.applyStyles(preElement, STREAMING_STYLES.pre);

    contentWrapper.appendChild(preElement);
    paramValueElement.appendChild(contentWrapper);

    return { preElement, contentWrapper };
  },

  updateContent: (preElement: HTMLPreElement, displayValue: string, isStreaming: boolean): void => {
    const currentText = preElement.textContent || '';
    if (currentText !== displayValue) {
      if (isStreaming && displayValue.length > currentText.length + 50) {
        preElement.style.opacity = '0.85';
        setTimeout(() => {
          preElement.textContent = displayValue;
          preElement.style.opacity = '1';
        }, 8);
      } else {
        preElement.textContent = displayValue;
      }
    }
  },

  handleStreamingState: (
    paramNameElement: HTMLDivElement,
    paramValueElement: HTMLDivElement,
    paramId: string,
    isStreaming: boolean,
  ): void => {
    const timeoutKey = `streaming-timeout-${paramId}`;
    PerformanceUtils.cleanupTimeout(timeoutKey);

    if (isStreaming) {
      if (!paramNameElement.classList.contains('streaming-param-name')) {
        paramNameElement.classList.add('streaming-param-name');
      }
      paramValueElement.setAttribute('data-streaming', 'true');

      if (!paramValueElement.hasAttribute('data-streaming-styled')) {
        DOMUtils.applyStyles(paramValueElement, {
          willChange: 'scroll-position, contents',
          containIntrinsicSize: 'auto 1.2em',
        });

        ParamElementUtils.checkAndApplyOverflow(paramValueElement);
        paramValueElement.setAttribute('data-streaming-styled', 'true');
        ScrollUtils.setupScrollTracking(paramValueElement);
      }

      setupAutoScroll(paramValueElement as ParamValueElement);
      ScrollUtils.performStreamingScroll(paramValueElement);

      PerformanceUtils.setManagedTimeout(
        timeoutKey,
        () => {
          if (paramNameElement && document.body.contains(paramNameElement)) {
            paramNameElement.classList.remove('streaming-param-name');
            if (paramValueElement) {
              paramValueElement.removeAttribute('data-streaming');
              paramValueElement.removeAttribute('data-streaming-styled');
              DOMUtils.applyStyles(paramValueElement, {
                willChange: 'auto',
                containIntrinsicSize: 'auto',
              });
            }
          }
        },
        STREAMING_TIMEOUT,
      );
    } else {
      if (paramNameElement.classList.contains('streaming-param-name')) {
        setTimeout(() => {
          paramNameElement.classList.remove('streaming-param-name');
          paramValueElement.removeAttribute('data-streaming');
          paramValueElement.removeAttribute('data-streaming-styled');
          DOMUtils.applyStyles(paramValueElement, {
            willChange: 'auto',
            containIntrinsicSize: 'auto',
          });
          
          // Check if block should auto-collapse when streaming ends
          const blockDiv = paramValueElement.closest('.function-block') as HTMLDivElement;
          if (blockDiv && blockDiv.classList.contains('auto-expanded')) {
            // Check if any other parameters are still streaming
            const stillStreaming = blockDiv.querySelector('[data-streaming="true"]');
            if (!stillStreaming) {
              AutoExpandUtils.scheduleAutoCollapse(blockDiv, 1200);
            }
          }
        }, 100);
      }

      setTimeout(() => ParamElementUtils.checkAndApplyOverflow(paramValueElement), 200);
    }
  },

  checkAndApplyOverflow: (paramValueElement: HTMLDivElement): void => {
    const needsScroll = paramValueElement.scrollHeight > 300;
    const hasScroll = paramValueElement.style.overflow === 'auto';

    if (needsScroll && !hasScroll) {
      DOMUtils.applyStyles(paramValueElement, {
        overflow: 'auto',
        maxHeight: '300px',
        scrollBehavior: 'smooth',
        scrollbarWidth: 'thin',
      });
    } else if (!needsScroll && hasScroll) {
      DOMUtils.applyStyles(paramValueElement, {
        overflow: 'visible',
        maxHeight: 'none',
      });
    }
  },
};

// Auto-execution utilities
const AutoExecutionUtils = {
  setupOptimizedAutoExecution: (blockId: string, functionDetails: any): void => {
  const setupAutoExecution = () => {
      const attempts = executionTracker.incrementAttempts(blockId);
      recordExecutionDiagnostic('AUTO_EXECUTION_ATTEMPT', {
        callId: String(functionDetails.callId),
        instanceId: getScopeKey(),
        toolName: functionDetails.functionName,
        attempt: attempts,
      });

      if (attempts > MAX_AUTO_EXECUTE_ATTEMPTS) {
        logger.debug(`Auto-execute: Giving up on block ${blockId} after ${attempts - 1} attempts`);
        executionTracker.cleanupBlock(blockId);
        return;
      }

      logger.debug(`Auto-execute attempt ${attempts}/${MAX_AUTO_EXECUTE_ATTEMPTS} for block ${blockId}`);

      // Get auto execute delay from window state
      const automationState = (window as any).__mcpAutomationState;
      const autoExecuteDelay = (automationState?.autoExecuteDelay || 0) * 1000; // Convert to milliseconds

      logger.debug(`Using delay of ${autoExecuteDelay}ms for block ${blockId}`);

      PerformanceUtils.setManagedTimeout(
        `auto-exec-${blockId}-${attempts}`,
        () => {
          recordExecutionDiagnostic('AUTO_EXECUTION_TIMER_FIRED', {
            callId: String(functionDetails.callId),
            instanceId: getScopeKey(),
            toolName: functionDetails.functionName,
            attempt: attempts,
          });
          let currentBlock = document.querySelector<HTMLDivElement>(`.function-block[data-block-id="${blockId}"]`);

          if (!currentBlock) {
            logger.debug(`Auto-execute: Original block ${blockId} not found. Searching for replacement...`);
            currentBlock = AutoExecutionUtils.findReplacementBlock(functionDetails);
          }

          currentBlock = AutoExecutionUtils.findExecutableBlock(functionDetails, currentBlock);

          if (!currentBlock) {
            logger.debug(
              `Auto-execute: No visible, enabled matching block found (attempt ${attempts}/${MAX_AUTO_EXECUTE_ATTEMPTS})`,
            );
            recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
              callId: String(functionDetails.callId),
              instanceId: getScopeKey(),
              toolName: functionDetails.functionName,
              reason: 'executable_block_not_visible_or_ready',
            });
            if (attempts < MAX_AUTO_EXECUTE_ATTEMPTS) {
              setupAutoExecution();
            } else {
              logger.debug(`Auto-execute: Giving up on block ${blockId} - no visible, enabled matching control`);
              executionTracker.cleanupBlock(blockId);
            }
            return;
          }

          const executeButton = currentBlock.querySelector<HTMLButtonElement>('.execute-button');
          if (!executeButton || !executeButton.isConnected || executeButton.disabled) {
            recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
              callId: String(functionDetails.callId),
              instanceId: getScopeKey(),
              toolName: functionDetails.functionName,
              reason: executeButton?.disabled ? 'execute_button_busy' : 'execute_button_missing',
            });
            if (attempts < MAX_AUTO_EXECUTE_ATTEMPTS && !executeButton?.disabled) {
              setupAutoExecution();
            } else {
              executionTracker.cleanupBlock(blockId);
            }
            return;
          }

          if (!isFreshAutoExecutionAllowed(functionDetails.freshToken) || !getAutomationState().autoExecute) {
            recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
              callId: String(functionDetails.callId),
              instanceId: getScopeKey(),
              toolName: functionDetails.functionName,
              reason: 'fresh_turn_ended_before_dispatch',
            });
            executionTracker.cleanupBlock(blockId);
            return;
          }
          const scopeKey = getScopeKey();
          const logicalCallKey = buildLogicalCallKey(
            scopeKey,
            functionDetails.functionName,
            functionDetails.callId,
            functionDetails.contentSignature,
          );

          // 1. Check existing claim in canonical storage
          const existingClaim = getExecutionClaim(logicalCallKey);
          if (existingClaim && (isTerminalStatus(existingClaim.status) || existingClaim.status === 'unknown' || existingClaim.status === 'running')) {
            recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
              callId: String(functionDetails.callId),
              instanceId: scopeKey,
              toolName: functionDetails.functionName,
              reason: 'existing_execution_claim',
              claimStatus: existingClaim.status,
            });
            logger.debug(`Auto-execute: Function already executed or in-flight (${existingClaim.status}) for ${logicalCallKey}, skipping.`);
            executionTracker.cleanupBlock(blockId);
            return;
          }

          // 2. Check draft conflict if inside a conversation
          if (scopeKey.startsWith('chatgpt:c:')) {
            const draftClaim = findDraftClaim(
              functionDetails.functionName,
              functionDetails.callId,
              functionDetails.contentSignature,
            );
            if (draftClaim) {
              recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
                callId: String(functionDetails.callId),
                instanceId: scopeKey,
                toolName: functionDetails.functionName,
                reason: 'draft_claim_conflict',
              });
              logger.debug(`Auto-execute: Ambiguous draft conflict detected for ${logicalCallKey}. Auto-execution blocked.`);
              executionTracker.cleanupBlock(blockId);
              return;
            }
          }

          // 3. Fallback check for legacy storage
          const finalCheckExecuted = getPreviousExecution(
            functionDetails.functionName,
            functionDetails.callId,
            functionDetails.contentSignature,
          );
          if (finalCheckExecuted) {
            recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
              callId: String(functionDetails.callId),
              instanceId: scopeKey,
              toolName: functionDetails.functionName,
              reason: 'legacy_execution_record',
            });
            logger.debug(`Auto-execute: Function already executed in legacy storage, skipping.`);
            executionTracker.cleanupBlock(blockId);
            return;
          }

          // 4. Opportunistic check with Service Worker using deterministic address ${scopeKey}:${callId}
          const persistentClient = (window as any).mcpClient;
          const deterministicAddress = `${scopeKey}:${functionDetails.callId}`;

          void (async () => {
            if (persistentClient && typeof persistentClient.getExecution === 'function') {
              try {
                const persistentExecution = await persistentClient.getExecution(deterministicAddress, {
                  callId: String(functionDetails.callId),
                  scopeKey,
                  byAddress: true,
                });
                recordExecutionDiagnostic('AUTO_EXECUTION_PERSISTENT_CHECK_RESULT', {
                  callId: String(functionDetails.callId),
                  instanceId: scopeKey,
                  toolName: functionDetails.functionName,
                  success: Boolean(persistentExecution),
                  executionStatus: persistentExecution?.status,
                });
                if (persistentExecution && (persistentExecution.status === 'success' || persistentExecution.status === 'running')) {
                  recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
                    callId: String(functionDetails.callId),
                    instanceId: scopeKey,
                    toolName: functionDetails.functionName,
                    reason: 'persistent_execution_exists',
                    executionStatus: persistentExecution.status,
                  });
                  logger.debug(`Auto-execute: Persistent execution already exists at ${deterministicAddress} (${persistentExecution.status}), skipping duplicate execution.`);
                  executionTracker.cleanupBlock(blockId);
                  return;
                }
              } catch (persistentCheckError) {
                logger.debug(`Auto-execute: Persistent execution opportunistic check skipped for ${deterministicAddress}:`, persistentCheckError);
              }
            }

            // 5. ATOMIC CLAIM: acquire exclusive cross-tab claim using Web Locks before executing
            recordExecutionDiagnostic('AUTO_EXECUTION_CLAIM_REQUEST', {
              callId: String(functionDetails.callId),
              instanceId: scopeKey,
              toolName: functionDetails.functionName,
              success: typeof navigator !== 'undefined' &&
                'locks' in navigator &&
                typeof navigator.locks?.request === 'function',
            });
            const claimResult = await claimExecutionAtomic(logicalCallKey, {
              scopeKey,
              functionName: functionDetails.functionName,
              callId: String(functionDetails.callId),
              contentSignature: functionDetails.contentSignature,
              params: functionDetails.params,
            });
            recordExecutionDiagnostic('AUTO_EXECUTION_CLAIM_RESULT', {
              callId: String(functionDetails.callId),
              instanceId: scopeKey,
              toolName: functionDetails.functionName,
              success: claimResult.granted,
              reason: claimResult.reason,
            });

            if (!claimResult.granted) {
              recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
                callId: String(functionDetails.callId),
                instanceId: scopeKey,
                toolName: functionDetails.functionName,
                reason: claimResult.reason,
              });
              logger.debug(`Auto-execute: Claim not granted (${claimResult.reason}) for ${logicalCallKey}, skipping execution.`);
              executionTracker.cleanupBlock(blockId);
              return;
            }

            const buttonStillExecutable =
              isFreshAutoExecutionAllowed(functionDetails.freshToken) &&
              getAutomationState().autoExecute === true &&
              executeButton.isConnected &&
              !executeButton.disabled &&
              currentBlock.getBoundingClientRect().width > 0 &&
              currentBlock.getBoundingClientRect().height > 0;
            if (!buttonStillExecutable) {
              const claim = claimResult.claim;
              const released =
                claim && (await releaseUnstartedExecutionClaim(logicalCallKey, claim.timestamp));
              if (!released) {
                logger.error(
                  `[FunctionBlockRenderer] Could not release stale pre-dispatch claim for ${logicalCallKey}`,
                );
                executionTracker.cleanupBlock(blockId);
                return;
              }

              recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
                callId: String(functionDetails.callId),
                instanceId: scopeKey,
                toolName: functionDetails.functionName,
                reason: 'execute_target_unavailable_before_dispatch',
              });
              if (attempts < MAX_AUTO_EXECUTE_ATTEMPTS) {
                setupAutoExecution();
              } else {
                executionTracker.cleanupBlock(blockId);
              }
              return;
            }

            recordExecutionDiagnostic('AUTO_EXECUTION_TRIGGERED', {
              callId: String(functionDetails.callId),
              instanceId: scopeKey,
              toolName: functionDetails.functionName,
            });
            logger.debug(`Auto-execute: Executing function ${functionDetails.functionName}`);
            executeButton.click();
            executionTracker.cleanupBlock(blockId);
          })();
        },
        autoExecuteDelay + 500, // Add base delay to the configured delay
      );
    };

    setupAutoExecution();
  },

  findReplacementBlock: (functionDetails: any): HTMLDivElement | null => {
    const potentialBlocks = Array.from(document.querySelectorAll<HTMLDivElement>('.function-block'));
    for (const block of potentialBlocks) {
      const preElement = block.querySelector('pre');
      if (!preElement?.textContent) continue;

      const text = preElement.textContent;
      let matchName: string | null = null;
      let matchCallId: string | null = null;

      // Support JSONL format
      if (text.includes('"type"') && text.includes('function_call_start')) {
        const jsonInfo = extractJSONFunctionInfo(text);
        matchName = jsonInfo.functionName;
        matchCallId = jsonInfo.callId;
      } else {
        // Fallback to XML format
        const match = REGEX_CACHE.invokeMatch.exec(text);
        REGEX_CACHE.invokeMatch.lastIndex = 0;
        if (match) {
          matchName = match[1];
          matchCallId = match[2];
        }
      }

      if (matchName === functionDetails.functionName && String(matchCallId) === String(functionDetails.callId)) {
        const scopeKey = getScopeKey();
        const logicalCallKey = buildLogicalCallKey(
          scopeKey,
          functionDetails.functionName,
          functionDetails.callId,
          functionDetails.contentSignature,
        );
        const claim = getExecutionClaim(logicalCallKey);

        if (!claim || (!isTerminalStatus(claim.status) && claim.status !== 'unknown')) {
          logger.debug(`Auto-execute: Found replacement block, attempting execution.`);
          return block;
        }
      }
    }
    return null;
  },

  findExecutableBlock: (
    functionDetails: any,
    preferredBlock: HTMLDivElement | null,
  ): HTMLDivElement | null => {
    const blocks = Array.from(
      new Set([
        ...(preferredBlock ? [preferredBlock] : []),
        ...Array.from(document.querySelectorAll<HTMLDivElement>('.function-block')),
      ]),
    );
    const candidates = blocks.map(block => ({
      target: block,
      functionName: block.querySelector('.function-name-text')?.textContent?.trim() || null,
      callId: block.querySelector('.call-id')?.textContent?.trim() || null,
      contentSignature: block.dataset.contentSignature || null,
      hasExecuteButton: Boolean(block.querySelector<HTMLButtonElement>('.execute-button')?.isConnected),
      isVisible: (() => {
        const bounds = block.getBoundingClientRect();
        const style = getComputedStyle(block);
        return bounds.width > 0 &&
          bounds.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden';
      })(),
      executeButtonEnabled: (() => {
        const button = block.querySelector<HTMLButtonElement>('.execute-button');
        return Boolean(button?.isConnected && !button.disabled);
      })(),
    }));

    return findAutoExecutionTarget(candidates, {
      functionName: functionDetails.functionName,
      callId: String(functionDetails.callId),
      contentSignature: functionDetails.contentSignature,
    });
  },
};

// Configure Monaco once before rendering any blocks
if (typeof window !== 'undefined') {
  configureMonacoEditorForCSP();
}

/**
 * Main function to render a function call block
 */
export const renderFunctionCall = (block: HTMLPreElement, isProcessingRef: { current: boolean }): boolean => {
  injectStreamingStyles();

  const functionInfo = containsFunctionCalls(block);

  if (CONFIG.debug) {
    logger.debug('[Render] containsFunctionCalls result:', {
      hasFunctionCalls: functionInfo.hasFunctionCalls,
      detectedBlockType: functionInfo.detectedBlockType,
      isComplete: functionInfo.isComplete,
      hasParameters: functionInfo.hasParameters,
      invokeName: functionInfo.invokeName
    });
  }

  // Early exit checks
  if (!functionInfo.hasFunctionCalls || block.closest('.function-block')) {
    if (CONFIG.debug && !functionInfo.hasFunctionCalls) {
      const textContent = block.textContent?.trim() || '';
      if (textContent.length === 0) {
        logger.debug('[Render] Skipping empty block - waiting for content');
      } else if (textContent.length < 10) {
        logger.debug('[Render] Skipping very short content - waiting for more data');
      } else {
        logger.debug('[Render] Early exit - no function calls detected');
      }
    }
    return false;
  }

  const textContent = block.textContent?.trim() || '';
  if (textContent.length < 10) {
    if (CONFIG.debug) {
      logger.debug('[Render] Skipping block with insufficient content (length:', textContent.length, ')');
    }
    return false;
  }

  const blockId =
    block.getAttribute('data-block-id') || `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Skip if resyncing or already complete and stable
  if ((window as any).resyncingBlocks?.has(blockId)) {
    if (CONFIG.debug) logger.debug(`Skipping render for resyncing block ${blockId}`);
    return false;
  }

  const existingFunctionBlock = document.querySelector(`.function-block[data-block-id="${blockId}"]`);
  if (
    existingFunctionBlock?.classList.contains('function-complete') &&
    existingFunctionBlock.querySelector('.execute-button')
  ) {
    if (CONFIG.debug) logger.debug(`Skipping render for completed block ${blockId}`);
    return false;
  }

  const preExistingIncompleteBlocks = (window as any).preExistingIncompleteBlocks || new Set<string>();
  const isPreExistingIncomplete = preExistingIncompleteBlocks.has(blockId);

  let existingDiv = renderedFunctionBlocks.get(blockId);
  let isNewRender = false;
  let previousCompletionStatus: boolean | null = null;

  // Handle existing div lookup and caching
  if (processedElements.has(block)) {
    if (!existingDiv) {
      existingDiv = document.querySelector<HTMLDivElement>(`.function-block[data-block-id="${blockId}"]`) || undefined;
      if (existingDiv) {
        renderedFunctionBlocks.set(blockId, existingDiv);
      } else {
        processedElements.delete(block);
      }
    }
  }

  if (!existingDiv) {
    isNewRender = true;
    if (!processedElements.has(block)) {
      processedElements.add(block);
      block.setAttribute('data-block-id', blockId);
    }
  } else {
    // Check if block was previously complete (has function-complete class)
    // Once complete, it should stay complete to prevent flickering
    previousCompletionStatus = existingDiv.classList.contains('function-complete');
  }

  const rawContent = block.textContent?.trim() || '';
  const { tag, content } = extractLanguageTag(rawContent);

  // Determine if JSON or XML format
  const isJSONFormat = functionInfo.detectedBlockType === 'json';
  let functionName: string;
  let callId: string;
  let partialParameters: Record<string, string>;
  let description: string | null = null;

  if (isJSONFormat) {
    const jsonInfo = extractJSONFunctionInfo(rawContent);
    functionName = jsonInfo.functionName || 'function';
    callId = jsonInfo.callId || `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    description = jsonInfo.description;
    partialParameters = extractJSONParameters(rawContent);
    recordExecutionDiagnostic('JSONL_PARSER_OUTPUT', {
      callId,
      instanceId: getScopeKey(),
      toolName: functionName,
      executionIdPresent: false,
      executionKeyPresent: false,
      commandPresent: Object.prototype.hasOwnProperty.call(partialParameters, 'command'),
      argumentKeys: Object.keys(partialParameters),
    });
  } else {
    const parsed = CacheUtils.parseContentEfficiently(block, rawContent);
    functionName = parsed.functionName;
    callId = parsed.callId;
    partialParameters = parsed.parameters;
  }

  const blockDiv = existingDiv || DOMUtils.createElement<HTMLDivElement>('div');

  // Setup new render
  if (isNewRender) {
    blockDiv.className = 'function-block';
    blockDiv.setAttribute('data-block-id', blockId);
    applyThemeClass(blockDiv);
    renderedFunctionBlocks.set(blockId, blockDiv);
    
    // Ensure blocks start collapsed by default
    blockDiv.classList.remove('expanded', 'auto-expanded');
  }

  // Handle state transitions
  if (!isNewRender) {
    const justCompleted = previousCompletionStatus === false && functionInfo.isComplete;
    // Prevent flickering: once a block is complete, don't allow it to become incomplete
    // This prevents re-rendering loops caused by temporary parsing issues
    const justBecameIncomplete = previousCompletionStatus === true && !functionInfo.isComplete;

    if (justCompleted) {
      blockDiv.classList.remove('function-loading');
      blockDiv.classList.add('function-complete');
      const spinner = blockDiv.querySelector('.spinner');
      if (spinner) spinner.remove();
    } else if (justBecameIncomplete && !blockDiv.classList.contains('function-complete')) {
      // Only transition to incomplete if the block wasn't already marked as complete
      // This prevents flickering from temporary state changes
      blockDiv.classList.remove('function-complete');
      blockDiv.classList.add('function-loading');
    }
  } else {
    if (!functionInfo.isComplete && !isPreExistingIncomplete) {
      blockDiv.classList.add('function-loading');
    }

    if (tag || functionInfo.languageTag) {
      const langTag = DOMUtils.createElement<HTMLDivElement>('div', 'language-tag');
      langTag.textContent = tag || functionInfo.languageTag;
      blockDiv.appendChild(langTag);
    }
  }

  const cachedElements = CacheUtils.getCachedElements(blockDiv);

  // Handle function name creation or update
  let functionNameElement = cachedElements.functionNameElement;
  if (!functionNameElement) {
    functionNameElement = BlockElementUtils.createFunctionNameSection(
      functionName,
      callId,
      functionInfo.isComplete,
      isPreExistingIncomplete,
    );
    blockDiv.appendChild(functionNameElement);

    cachedElements.functionNameElement = functionNameElement;
    elementQueryCache.set(blockDiv, { ...cachedElements, lastCacheTime: Date.now() });
  } else {
    const nameText = functionNameElement.querySelector<HTMLSpanElement>('.function-name-text');
    if (nameText) DOMUtils.updateTextIfChanged(nameText, functionName);

    const callIdElement = functionNameElement.querySelector<HTMLSpanElement>('.call-id');
    if (callId) {
      if (callIdElement) {
        DOMUtils.updateTextIfChanged(callIdElement, callId);
      } else {
        const newCallId = DOMUtils.createElement<HTMLSpanElement>('span', 'call-id');
        newCallId.textContent = callId;
        functionNameElement.appendChild(newCallId);
      }
    }
  }

  // Setup expand/collapse functionality
  let expandButton = functionNameElement?.querySelector('.expand-button') as HTMLButtonElement | null;
  let expandableContent = blockDiv.querySelector('.expandable-content') as HTMLDivElement | null;

  if (!expandButton && functionNameElement) {
    expandButton = BlockElementUtils.createExpandButton();
    const rightSection = functionNameElement.querySelector('.function-name-right');
    if (rightSection) {
      rightSection.appendChild(expandButton);
    } else {
      functionNameElement.appendChild(expandButton);
    }
  }

  if (!expandableContent) {
    expandableContent = BlockElementUtils.createExpandableContent();
    blockDiv.appendChild(expandableContent);
    
    // Ensure content starts hidden for new blocks
    if (isNewRender) {
      DOMUtils.applyStyles(expandableContent, {
        display: 'none',
        maxHeight: '0px',
        opacity: '0',
        paddingTop: '0',
        paddingBottom: '0',
      });
    }
  }

  if (expandButton && expandableContent) {
    BlockElementUtils.setupExpandCollapse(blockDiv, expandButton, expandableContent);
  }

  // Add description section if present (JSON format)
  // Insert it inside the function-name-left section, below the function name
  if (description && functionNameElement) {
    const leftSection = functionNameElement.querySelector('.function-name-left') as HTMLDivElement;
    if (leftSection && !leftSection.querySelector('.function-description')) {
      // Change flex direction to column to stack elements vertically
      DOMUtils.applyStyles(leftSection, {
        flexDirection: 'column',
        alignItems: 'flex-start',
      });

      const descriptionElement = DOMUtils.createElement<HTMLDivElement>('div', 'function-description');
      descriptionElement.textContent = description;
      DOMUtils.applyStyles(descriptionElement, {
        fontSize: '12px',
        color: 'inherit',
        marginTop: '4px',
        fontStyle: 'bold',
        lineHeight: '1.4',
        display: 'block',
        opacity: '0.8',
      });

      // Append description to the left section (below function name)
      leftSection.appendChild(descriptionElement);
    }
  }

  // Create parameter container
  let paramsContainer = cachedElements.paramsContainer;
  if (!paramsContainer) {
    paramsContainer = DOMUtils.createElement<HTMLDivElement>('div', 'function-params');
    DOMUtils.applyStyles(paramsContainer, STREAMING_STYLES.paramsContainer);
    expandableContent!.appendChild(paramsContainer);

    cachedElements.paramsContainer = paramsContainer;
    elementQueryCache.set(blockDiv, { ...cachedElements, lastCacheTime: Date.now() });
  }

  // Process parameters
  Object.entries(partialParameters).forEach(([paramName, extractedValue]) => {
    let isParamStreaming: boolean;

    if (isJSONFormat) {
      // For JSON: parameter is streaming if function_call_end hasn't arrived
      isParamStreaming = !functionInfo.isComplete;
    } else {
      // For XML: check if parameter closing tag exists
      isParamStreaming =
        !rawContent.includes(`</parameter>`) ||
        rawContent.indexOf('</parameter>', rawContent.indexOf(`<parameter name="${paramName}"`)) === -1;
    }

    const paramId = `${blockId}-${paramName}`;
    PerformanceUtils.batchStreamingUpdate(paramId, () => {
      createOrUpdateParamElement(paramsContainer!, paramName, extractedValue, blockId, isNewRender, isParamStreaming);
    });
  });

  // Handle completion and auto-execution
  let completeParameters: Record<string, any> | null = null;
  if (functionInfo.isComplete) {
    if (isJSONFormat) {
      completeParameters = extractJSONParameters(rawContent);
    } else {
      completeParameters = extractFunctionParameters(rawContent);
    }

    // Auto-collapse if the block was auto-expanded and is now complete
    if (blockDiv.classList.contains('auto-expanded')) {
      AutoExpandUtils.scheduleAutoCollapse(blockDiv, 1500);
    }
  }

  let contentSignature: string | null = null;
  if (functionInfo.isComplete && completeParameters) {
    contentSignature = generateContentSignature(functionName, completeParameters);
    blockDiv.dataset.contentSignature = contentSignature;
  }

  // Replace original element on new render
  if (isNewRender) {
    if (block.parentNode) {
      block.parentNode.insertBefore(blockDiv, block);
      block.style.display = 'none';
    } else {
      if (CONFIG.debug) logger.warn('Function call block has no parent element, cannot insert rendered block');
      return false;
    }
  }

  // Create button container
  let buttonContainer = cachedElements.buttonContainer;
  if (!buttonContainer) {
    buttonContainer = DOMUtils.createElement<HTMLDivElement>('div', 'function-buttons');
    buttonContainer.style.marginTop = '12px';
    blockDiv.appendChild(buttonContainer);

    cachedElements.buttonContainer = buttonContainer;
    elementQueryCache.set(blockDiv, { ...cachedElements, lastCacheTime: Date.now() });
  }

  // Add buttons for complete functions
  if (functionInfo.isComplete) {
    if (!blockDiv.querySelector('.raw-toggle')) {
      addRawXmlToggle(buttonContainer!, rawContent);
    }

    if (!blockDiv.querySelector('.execute-button')) {
      if (!completeParameters) {
        if (isJSONFormat) {
          completeParameters = extractJSONParameters(rawContent);
        } else {
          completeParameters = extractFunctionParameters(rawContent);
        }
      }
      addExecuteButton(buttonContainer!, rawContent);

      // Setup auto-execution
      const automationState = getAutomationState();
      const autoExecuteEnabled = automationState.autoExecute;
      const alreadyExecuted =
        !!contentSignature && executionTracker.isFunctionExecuted(callId, contentSignature, functionName);
      recordExecutionDiagnostic('AUTO_EXECUTION_CHECK', {
        callId: String(callId),
        instanceId: getScopeKey(),
        toolName: functionName,
        autoExecuteEnabled,
        contentSignaturePresent: !!contentSignature,
        alreadyExecuted,
      });
      if (contentSignature && !alreadyExecuted) {
        if (autoExecuteEnabled !== true) {
          recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
            callId: String(callId),
            instanceId: getScopeKey(),
            toolName: functionName,
            reason: 'disabled_by_settings',
          });
          logger.debug(`Auto-execution disabled by user settings for block ${blockId} (${functionName})`);
          return true;
        }

        if (executionTracker.isBlockExecuted(blockId) === true) {
          recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
            callId: String(callId),
            instanceId: getScopeKey(),
            toolName: functionName,
            reason: 'block_already_executed',
          });
          logger.debug(`Auto-execution skipped: Block ${blockId} (${functionName}) has already been processed`);
          return true;
        }

        const freshToken = freshAutoExecutionToken(block, JSON.stringify([functionName, String(callId), contentSignature]));
        if (!freshToken) {
          recordExecutionDiagnostic('AUTO_EXECUTION_SKIPPED', {
            callId: String(callId),
            instanceId: getScopeKey(),
            toolName: functionName,
            reason: 'historical_or_unproven_response',
          });
          return true;
        }
        executionTracker.markFunctionExecuted(callId, contentSignature, functionName);
        executionTracker.markBlockExecuted(blockId); // Fresh current-turn call only.
        recordExecutionDiagnostic('AUTO_EXECUTION_SCHEDULED', {
          callId: String(callId),
          instanceId: getScopeKey(),
          toolName: functionName,
        });

        logger.debug(`Setting up auto-execution for block ${blockId} (${functionName})`);

        const functionDetails = {
          functionName,
          callId,
          contentSignature,
          params: completeParameters || {},
          freshToken,
        };

        AutoExecutionUtils.setupOptimizedAutoExecution(blockId, functionDetails);
      }
    }
  }

  return true;
};

/**
 * Create or update a parameter element in the function block
 */
export const createOrUpdateParamElement = (
  container: HTMLDivElement,
  name: string,
  value: any,
  blockId: string,
  isNewRender: boolean,
  isStreaming: boolean = false,
): void => {
  const paramId = `${blockId}-${name}`;
  const paramElementCache = elementQueryCache.get(container) || { lastCacheTime: Date.now() };
  const paramCache = paramElementCache as any;

  let paramNameElement = paramCache[`name-${paramId}`] as HTMLDivElement | undefined;
  let paramValueElement = paramCache[`value-${paramId}`] as HTMLDivElement | undefined;

  // Query DOM if not in cache
  if (!paramNameElement || !paramValueElement) {
    paramNameElement =
      paramNameElement ||
      container.querySelector<HTMLDivElement>(`.param-name[data-param-id="${paramId}"]`) ||
      document.querySelector<HTMLDivElement>(`.param-name[data-param-id="${paramId}"]`) ||
      undefined;
    paramValueElement =
      paramValueElement ||
      container.querySelector<HTMLDivElement>(`.param-value[data-param-id="${paramId}"]`) ||
      document.querySelector<HTMLDivElement>(`.param-value[data-param-id="${paramId}"]`) ||
      undefined;

    if (paramNameElement) paramCache[`name-${paramId}`] = paramNameElement;
    if (paramValueElement) paramCache[`value-${paramId}`] = paramValueElement;
    elementQueryCache.set(container, paramCache);
  }

  // Create elements if they don't exist
  if (!paramNameElement) {
    paramNameElement = ParamElementUtils.createParamName(name, paramId);
    container.appendChild(paramNameElement);
    paramCache[`name-${paramId}`] = paramNameElement;
    elementQueryCache.set(container, paramCache);
  }

  if (!paramValueElement) {
    paramValueElement = ParamElementUtils.createParamValue(paramId, name);
    container.appendChild(paramValueElement);
    paramCache[`value-${paramId}`] = paramValueElement;
    elementQueryCache.set(container, paramCache);
  }

  // Update content if changed
  const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const currentValue = paramValueElement.getAttribute('data-current-value');

  if (currentValue === displayValue && !isStreaming) {
    return;
  }

  paramValueElement.setAttribute('data-current-value', displayValue);

  // Handle streaming vs static content
  if (isStreaming || paramValueElement.hasAttribute('data-streaming')) {
    let preElement = paramValueElement.querySelector('pre') as HTMLPreElement;
    let contentWrapper = paramValueElement.querySelector('.content-wrapper') as HTMLDivElement;

    if (!preElement || !contentWrapper) {
      const elements = ParamElementUtils.createStreamingContent(paramValueElement);
      preElement = elements.preElement;
      contentWrapper = elements.contentWrapper;
    }

    const updateContent = () => {
      ParamElementUtils.updateContent(preElement, displayValue, isStreaming);
    };

    if (isStreaming) {
      requestAnimationFrame(() => {
        updateContent();
        // Enhanced scroll for streaming content
        ScrollUtils.performStreamingScroll(paramValueElement);
      });
    } else {
      updateContent();
    }
  } else {
    if (paramValueElement.textContent !== displayValue) {
      if (paramValueElement.textContent && paramValueElement.textContent.length > 0) {
        paramValueElement.style.opacity = '0.9';
        setTimeout(() => {
          paramValueElement.textContent = displayValue;
          paramValueElement.style.opacity = '1';
        }, 50);
      } else {
        paramValueElement.textContent = displayValue;
      }
    }
  }

  paramValueElement.setAttribute('data-param-value', JSON.stringify(value));
  ParamElementUtils.handleStreamingState(paramNameElement, paramValueElement, paramId, isStreaming);
  
  // Handle auto-expansion for streaming content
  if (isStreaming) {
    const blockDiv = container.closest('.function-block') as HTMLDivElement;
    if (blockDiv && !blockDiv.classList.contains('expanded')) {
      AutoExpandUtils.expandBlock(blockDiv, true);
    }
  }
};

// Performance: Cleanup functions for memory management
export const performanceCleanup = {
  clearAllCaches: (): void => {
    renderedFunctionBlocks.clear();
    pendingDOMUpdates.clear();
    activeTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    activeTimeouts.clear();
  },

  clearBlockCache: (blockId: string): void => {
    renderedFunctionBlocks.delete(blockId);
    pendingDOMUpdates.delete(blockId);

    const timeoutKeysToClean = Array.from(activeTimeouts.keys()).filter(key => key.includes(blockId));
    timeoutKeysToClean.forEach(key => {
      const timeoutId = activeTimeouts.get(key);
      if (timeoutId) {
        clearTimeout(timeoutId);
        activeTimeouts.delete(key);
      }
    });
  },

  getCacheStats: () => ({
    contentParsingCacheSize: 'WeakMap (size not available - auto-managed)',
    elementQueryCacheSize: 'WeakMap (size not available - auto-managed)',
    renderedFunctionBlocksSize: renderedFunctionBlocks.size,
    pendingDOMUpdatesSize: pendingDOMUpdates.size,
    activeTimeoutsSize: activeTimeouts.size,
  }),
};

// Performance: Export utilities for external monitoring
export const performanceUtils = {
  generateContentHash: CacheUtils.generateContentHash,
  parseContentEfficiently: CacheUtils.parseContentEfficiently,
  batchDOMOperation: PerformanceUtils.batchDOMOperation,
  getCachedElements: CacheUtils.getCachedElements,
  cleanupTimeout: PerformanceUtils.cleanupTimeout,
  setManagedTimeout: PerformanceUtils.setManagedTimeout,
  REGEX_CACHE,
};

// Cleanup on page unload to prevent memory leaks
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    performanceCleanup.clearAllCaches();
  });
}
