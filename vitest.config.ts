// import { defineConfig } from "vitest/config";

// export default defineConfig({
//   test: {
//     globals: true,
//     environment: "node",
//     include: ["src/**/*.{test,spec}.ts"],
//     setupFiles: ["./test/setup.ts"],
//     coverage: {
//       provider: "v8",
//       reporter: ["text", "json", "html"],
//       exclude: [
//         "node_modules/",
//         "dist/",
//         "coverage/",
//         "**/*.d.ts",
//         "**/*.config.ts",
//         "**/main.ts",
//         "**/types.ts",
//       ],
//     },
//   },
//   resolve: {
//     alias: {
//       "@": "/src",
//     },
//   },
// });
// import { defineConfig } from "vitest/config";

// export default defineConfig({
//   test: {
//     globals: true,
//     environment: "node",
//     coverage: {
//       provider: "v8",
//       reporter: ["text", "lcov", "html"],
//       reportsDirectory: "./coverage",
//       exclude: [
//         "node_modules/",
//         "dist/",
//         "build/",
//         "test/",
//         "**/*.spec.ts",
//         "**/*.test.ts",
//         "**/types/",
//         "**/dto/",
//         "**/*.interface.ts",
//         "**/*.module.ts",
//         "src/main.ts",
//         "prisma/",
//         "cucumber.cjs",
//         "vitest.config.mjs",
//       ],
//       include: ["src/**/*.ts"],
//       all: true,
//     },
//   },
//   esbuild: {
//     target: "node14",
//   },
// });
import { resolve } from "node:path";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["node_modules/**", "dist/**"],
    setupFiles: ["./test/setup.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "~": resolve(__dirname, "./"),
    },
  },
});
