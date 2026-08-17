import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("run-prisma-migrations.sh", () => {
  const migrationScript = join(process.cwd(), "scripts/run-prisma-migrations.sh");
  let temporaryDirectory: string;
  let prismaBinary: string;
  let callsFile: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "prisma-migrations-"));
    prismaBinary = join(temporaryDirectory, "prisma");
    callsFile = join(temporaryDirectory, "calls.log");

    writeFileSync(
      prismaBinary,
      `#!/bin/sh
printf '%s\\n%s\\n' "$DATABASE_URL" "$*" > "$CALLS_FILE"
`,
    );
    chmodSync(prismaBinary, 0o755);
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function runMigration(overrides: NodeJS.ProcessEnv = {}) {
    const environment = { ...process.env };
    delete environment.DIRECT_DATABASE_URL;

    const result = spawnSync("sh", [migrationScript], {
      encoding: "utf8",
      env: {
        ...environment,
        DATABASE_URL:
          "postgresql://user:password@ep-example-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require",
        PRISMA_BIN: prismaBinary,
        CALLS_FILE: callsFile,
        ...overrides,
      },
    });

    return {
      calls: result.status === 0 ? readFileSync(callsFile, "utf8").trim().split("\n") : [],
      output: `${result.stdout}${result.stderr}`,
      status: result.status,
    };
  }

  it("uses the direct Neon endpoint for a pooled connection", () => {
    const result = runMigration();

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "postgresql://user:password@ep-example.eu-west-2.aws.neon.tech/neondb?sslmode=require",
      "migrate deploy",
    ]);
  });

  it("leaves a direct database URL unchanged", () => {
    const databaseUrl = "postgresql://user:password@database.example.com/app?schema=public";

    const result = runMigration({ DATABASE_URL: databaseUrl });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([databaseUrl, "migrate deploy"]);
  });

  it("does not rewrite non-Neon pooler hosts", () => {
    const databaseUrl = "postgresql://user:password@company-pooler.example.com/app";

    const result = runMigration({ DATABASE_URL: databaseUrl });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([databaseUrl, "migrate deploy"]);
  });

  it("prefers an explicit direct database URL", () => {
    const directDatabaseUrl =
      "postgresql://user:password@ep-explicit.eu-west-2.aws.neon.tech/neondb?sslmode=require";

    const result = runMigration({ DIRECT_DATABASE_URL: directDatabaseUrl });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([directDatabaseUrl, "migrate deploy"]);
  });

  it("fails before invoking Prisma when DATABASE_URL is missing", () => {
    const result = runMigration({ DATABASE_URL: "" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("DATABASE_URL is required");
    expect(result.calls).toEqual([]);
  });
});
