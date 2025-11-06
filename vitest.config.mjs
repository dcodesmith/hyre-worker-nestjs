/// <reference types="vitest" />

import { resolve } from "node:path";
import swc from "unplugin-swc";
import tsconfigPaths from "vite-tsconfig-paths";
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
  coverage: {
    provider: "v8",
    reporter: ["text", "lcov", "html"],
    reportsDirectory: "./coverage",
    exclude: [
      "node_modules/",
      "dist/",
      "build/",
      "test/",
      "**/*.spec.ts",
      "**/*.test.ts",
      "**/types/",
      "**/dto/",
      "**/*.interface.ts",
      "**/*.module.ts",
      "src/main.ts",
      "prisma/",
      "cucumber.cjs",
      "vitest.config.mjs",
    ],
    include: ["src/**/*.ts"],
    all: true,
  },
  plugins: [
    tsconfigPaths(),
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022",
        keepClassNames: true,
      },
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
