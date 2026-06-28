import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#eceef2",
        panel: "#1a1d22",
        "panel-2": "#141619",
        edge: "#2a2e36",
        accent: "#f3b13c", // backlit-gauge amber (brand)
        good: "#38c890", // andon green
        warn: "#f0b429", // andon amber
        bad: "#e5544b", // andon red
        mute: "#9a9ea8",
        faint: "#646872",
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
