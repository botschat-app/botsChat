import { useState, useEffect } from "react";

const MOBILE_BREAKPOINT = 768; // px — matches Tailwind's `md`

/**
 * Returns true when the viewport is narrower than the mobile breakpoint.
 * Listens to `matchMedia` changes so it updates live on window resize.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);

    // Set initial value (SSR hydration guard)
    setIsMobile(mql.matches);

    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isMobile;
}
