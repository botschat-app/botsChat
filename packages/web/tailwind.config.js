/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f7ff",
          100: "#e0efff",
          500: "#1264A3",
          600: "#1164A3",
          700: "#0d5289",
        },
        surface: "var(--bg-surface)",
        "bg-primary": "var(--bg-primary)",
        "bg-secondary": "var(--bg-secondary)",
        "bg-hover": "var(--bg-hover)",
        "bg-active": "var(--bg-active)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        "text-link": "var(--text-link)",
        "text-sidebar": "var(--text-sidebar)",
        "text-sidebar-active": "var(--text-sidebar-active)",
        "accent-green": "var(--accent-green)",
        "accent-yellow": "var(--accent-yellow)",
        "accent-red": "var(--accent-red)",
        border: "var(--border)",
      },
      fontFamily: {
        sans: ["Lato", "Noto Sans SC", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Helvetica", "Arial", "sans-serif"],
        mono: ["SF Mono", "Consolas", "Monaco", "monospace"],
      },
      fontSize: {
        h1: ["18px", { lineHeight: "1.33", fontWeight: "700" }],
        h2: ["15px", { lineHeight: "1.46", fontWeight: "700" }],
        body: ["15px", { lineHeight: "1.46", fontWeight: "400" }],
        caption: ["13px", { lineHeight: "1.38", fontWeight: "400" }],
        tiny: ["11px", { lineHeight: "1.27", fontWeight: "500" }],
      },
      spacing: {
        "space-1": "4px",
        "space-2": "8px",
        "space-3": "12px",
        "space-4": "16px",
        "space-5": "20px",
        "space-6": "24px",
      },
      borderRadius: {
        sm: "4px",
        md: "8px",
        lg: "12px",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      maxWidth: {
        message: "700px",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
