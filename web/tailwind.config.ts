import type { Config } from "tailwindcss";

// Halomanage skeuomorphic theme: Royal Blue + Gold + White/parchment.
// These scales back the hand-built surfaces in app/globals.css (buttons,
// panels, inputs, badges all use real multi-stop gradients + layered
// shadows there, since Tailwind's flat utility classes can't express a
// bevel by themselves) as well as ordinary utility usage (text-royal-700,
// border-gold-300, etc.) in components.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        // Primary chrome — deep, rich monarch blue.
        royal: {
          50: "#EFF3FC",
          100: "#DCE6F8",
          200: "#B9CDF1",
          300: "#8CAAE6",
          400: "#5C81D6",
          500: "#3A62BF",
          600: "#26439C",
          700: "#1E3480",
          800: "#16265F",
          900: "#0E1A42",
          950: "#080F28",
        },
        // Accent metal — antique/polished gold.
        gold: {
          50: "#FDF9EC",
          100: "#FBF0CB",
          200: "#F5DE95",
          300: "#EDC85F",
          400: "#DDAE3C",
          500: "#C4922A",
          600: "#A2761F",
          700: "#7D5A19",
          800: "#5C4213",
          900: "#3D2C0D",
        },
        // Base surface — warm parchment/ivory rather than clinical white.
        cream: {
          50: "#FFFEFA",
          100: "#FBF7ED",
          200: "#F5EDD8",
          300: "#EDE0BE",
          400: "#DFCB99",
        },
        // Jewel-toned status colors, kept semantically conventional
        // (approve=green, reject=red) but pulled into the same rich,
        // saturated family as royal/gold rather than stock Tailwind hues.
        ruby: {
          100: "#FBE2E4",
          200: "#F3B8BE",
          600: "#A6233A",
          700: "#841B2E",
        },
        emerald: {
          100: "#DCEEE1",
          200: "#AEDBBB",
          600: "#1F7A45",
          700: "#185E36",
        },
      },
      boxShadow: {
        gem: "inset 0 1px 1px rgba(255,255,255,0.6), inset 0 -1px 2px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.15)",
      },
    },
  },
  plugins: [],
};

export default config;
