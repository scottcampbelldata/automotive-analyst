import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // All colors are theme tokens defined in globals.css (:root = light,
        // [data-theme="dark"] = dark). Utilities like text-mute/border-edge
        // follow the active theme automatically.
        ink: "var(--ink)",
        strong: "var(--strong)", // headings / values (near-black on paper, white in dark)
        panel: "var(--panel)",
        "panel-2": "var(--panel-2)",
        edge: "var(--edge)",
        accent: "var(--signal)", // slate accent from the site tokens
        good: "var(--good)", // pipeline status: passed
        warn: "var(--warn)", // pipeline status: caution
        bad: "var(--bad)", // pipeline status: failed
        mute: "var(--mute)",
        faint: "var(--faint)",
      },
      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};
export default config;
