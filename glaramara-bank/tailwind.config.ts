import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        forest: "#173F33",
        "forest-secondary": "#275A47",
        sage: "#D6E9B8",
        paper: "#F5F7F3",
        ink: "#172C25",
      },
      boxShadow: {
        soft: "0 7px 30px rgba(24, 47, 32, 0.055)",
      },
      borderRadius: {
        xl: "0.95rem",
        "2xl": "1.15rem",
      },
    },
  },
  plugins: [],
};

export default config;
