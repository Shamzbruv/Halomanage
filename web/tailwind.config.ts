import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          200: "#b3cdff",
          300: "#82adff",
          400: "#5087ff",
          500: "#2b63f5",
          600: "#1c48d6",
          700: "#1638a8",
          800: "#152f80",
          900: "#152a63",
        },
      },
    },
  },
  plugins: [],
};

export default config;
