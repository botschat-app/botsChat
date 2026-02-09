/**
 * Google Analytics (GA4). Only loads when VITE_GA_MEASUREMENT_ID is set (e.g. in .env.production).
 * Set VITE_GA_MEASUREMENT_ID to your GA4 Measurement ID (e.g. G-XXXXXXXXXX) to enable.
 */

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

function loadGtag(): boolean {
  if (!MEASUREMENT_ID || typeof window === "undefined") return false;
  if (window.gtag) return true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID);

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
  return true;
}

let initialized = false;

export function initAnalytics(): void {
  if (initialized) return;
  initialized = loadGtag();
}

export function isAnalyticsEnabled(): boolean {
  return initialized && !!window.gtag;
}

/**
 * Send a page_view or custom event to GA4. Use after route/view changes in the SPA.
 */
export function gtagEvent(name: string, params?: Record<string, string>): void {
  if (!MEASUREMENT_ID || !window.gtag) return;
  window.gtag("event", name, params);
}

/**
 * Track a virtual page view (e.g. "Messages" / "Automations" tab).
 */
export function gtagPageView(page: string): void {
  gtagEvent("page_view", { page_path: `/${page}`, page_title: page });
}
