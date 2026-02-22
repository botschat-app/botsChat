import { useRef, useCallback } from "react";

/**
 * Tracks IME composition state to prevent Enter-to-send during
 * Chinese/Japanese/Korean input confirmation.
 *
 * In WebKit/WKWebView, when a user presses Enter to accept an IME candidate,
 * the event order is: compositionend → keydown(Enter, isComposing=false).
 * The native `isComposing` flag is already false by the time keydown fires,
 * so checking it alone is insufficient. This hook keeps a flag active for one
 * animation frame after compositionend to swallow that trailing Enter.
 */
export function useIMEComposition() {
  const composingRef = useRef(false);
  const justEndedRef = useRef(false);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    justEndedRef.current = false;
  }, []);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    justEndedRef.current = true;
    requestAnimationFrame(() => {
      justEndedRef.current = false;
    });
  }, []);

  const isIMEActive = useCallback(
    () => composingRef.current || justEndedRef.current,
    [],
  );

  return { onCompositionStart, onCompositionEnd, isIMEActive } as const;
}
