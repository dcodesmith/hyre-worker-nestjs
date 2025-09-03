// Email-specific Tailwind configuration
// This is separate from the main tailwind.config.ts to avoid TypeScript rootDir issues
export default {
  content: ["./src/emails/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        nunito: ["Nunito Sans", "sans-serif"],
        dancingscript: ["Dancing Script", "cursive"],
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
