import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

/** A completed hold consumes its click; a short press preserves the normal action. */
export function useHoldAction(enabled: boolean, onHold: () => void, durationMs = 1000) {
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);
  const started = useRef<number | null>(null);
  const input = useRef<'pointer' | 'keyboard' | null>(null);
  const consumed = useRef(false);
  const action = useRef(onHold);
  const allowed = useRef(enabled);
  action.current = onHold;
  allowed.current = enabled;

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    started.current = null;
    input.current = null;
    setProgress(0);
  }, []);

  const begin = useCallback((kind: 'pointer' | 'keyboard') => {
    if (input.current !== null) return;
    consumed.current = false;
    if (!allowed.current) return;
    input.current = kind;
    started.current = performance.now();
    const tick = (now: number) => {
      if (started.current === null || !allowed.current || document.hidden) {
        cancel();
        return;
      }
      const next = Math.min(1, (now - started.current) / durationMs);
      setProgress(next);
      if (next < 1) {
        frame.current = requestAnimationFrame(tick);
        return;
      }
      frame.current = null;
      started.current = null;
      consumed.current = true;
      action.current();
    };
    frame.current = requestAnimationFrame(tick);
  }, [cancel, durationMs]);

  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointercancel', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pointerup', cancel);
      window.removeEventListener('pointercancel', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [cancel]);

  return {
    progress,
    cancel,
    consumeClick: () => {
      const result = consumed.current;
      consumed.current = false;
      return result;
    },
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.isPrimary && event.button === 0) begin('pointer');
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Escape') cancel();
      if (event.key === 'Enter') consumed.current = false;
      if (!allowed.current) return;
      if (event.key !== ' ' || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!event.repeat) begin('keyboard');
    },
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== ' ') return;
      if (input.current !== 'keyboard' && !consumed.current) return;
      event.preventDefault();
      const wasKeyboard = input.current === 'keyboard';
      const wasConsumed = consumed.current;
      cancel();
      if (wasKeyboard && !wasConsumed) event.currentTarget.click();
      if (wasConsumed) consumed.current = false;
    },
  };
}
