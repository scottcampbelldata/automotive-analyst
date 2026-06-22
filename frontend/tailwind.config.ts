import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f1729",
        panel: "#121a2e",
        edge: "#1f2a44",
        accent: "#e0653f",
        good: "#3aa17a",
        mute: "#8896b4",
        faint: "#5d6a86",
      },
    },
  },
  plugins: [],
};
export default config;
