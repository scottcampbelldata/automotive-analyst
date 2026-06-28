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
        accent: "var(--signal)", // brand amber, deepened on paper
        good: "var(--good)", // andon green
        warn: "var(--warn)", // andon amber
        bad: "var(--bad)", // andon red
        mute: "var(--mute)",
        faint: "var(--faint)",
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
