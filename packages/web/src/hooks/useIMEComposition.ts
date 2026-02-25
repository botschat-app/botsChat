import { useRef, useCallback } from "react";

/**
 * Tracks IME composition state to prevent Enter-to-send during
 * Chinese/Japanese/Korean input confirmation.
 *
 * In WebKit/WKWebView, when a user presses Enter to accept an IME candidate,
 * the event order is: compositionend → keydown(Enter, isComposing=false).
 * The native `isComposing` flag is already false by the time keydown fires,
 * so checking it alone is insufficient.
 *
 * We use a timestamp-based guard instead of requestAnimationFrame because
 * rAF timing is unreliable in WKWebView — the callback may fire before the
 * trailing keydown, causing a race condition where Enter is sometimes
 * swallowed and sometimes not.
 */
const COMPOSITION_END_GUARD_MS = 80;

export function useIMEComposition() {
  const composingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    compositionEndTimeRef.current = 0;
  }, []);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    compositionEndTimeRef.current = Date.now();
  }, []);

  const isIMEActive = useCallback(
    () =>
      composingRef.current ||
      Date.now() - compositionEndTimeRef.current < COMPOSITION_END_GUARD_MS,
    [],
  );

  return { onCompositionStart, onCompositionEnd, isIMEActive } as const;
}
