import type { Config } from "tailwindcss";

// The legacy color names stay in place so every existing feature screen
// inherits the new visual system without a risky class-by-class rewrite.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        royal: {
          50: "#F0F7F4", 100: "#DCECE7", 200: "#BBD8CF", 300: "#8DBCAD",
          400: "#5A9A88", 500: "#377A69", 600: "#246052", 700: "#174F43",
          800: "#123D35", 900: "#0D2E28", 950: "#071D19",
        },
        gold: {
          50: "#FFF9EA", 100: "#FFF1C9", 200: "#FBE29A", 300: "#F6CE6E",
          400: "#F2B84B", 500: "#DB9830", 600: "#B87721", 700: "#8E571C",
          800: "#6A421C", 900: "#4C321A",
        },
        cream: {
          50: "#FFFFFF", 100: "#F6F7F4", 200: "#ECEFEB", 300: "#DEE4DF", 400: "#CBD5CF",
        },
        ruby: { 100: "#FCE9E8", 200: "#F4C6C3", 600: "#B94042", 700: "#973337" },
        emerald: { 100: "#E3F4ED", 200: "#BDE4D7", 600: "#248063", 700: "#17684F" },
      },
      boxShadow: {
        gem: "0 1px 2px rgba(20,45,36,0.05), 0 8px 24px rgba(20,45,36,0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
