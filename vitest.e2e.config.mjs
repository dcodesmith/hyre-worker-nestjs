import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 1. Target only files ending with .e2e-spec.ts in test directory
    include: ["test/**/*.e2e-spec.ts"],
    // Exclude everything else
    exclude: [
      "src/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/*.spec.ts",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
    ],
    globals: true,
    // 2. Must be 'node' for Supertest/HTTP requests
    environment: "node",
    // 3. Optional: Point to your container setup if using Testcontainers
    globalSetup: "./test/e2e.setup.ts",
    // 4. Increase timeout to allow external services to start
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  plugins: [
    // Keep SWC plugin for NestJS decorator support.
    // useDefineForClassFields: false is required to ensure decorators can
    // modify class fields before they are initialized (NestJS dependency injection).
    swc.vite({
      module: { type: "es6" },
      jsc: { transform: { useDefineForClassFields: false } },
    }),
  ],
});
