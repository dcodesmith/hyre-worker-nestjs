import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("entrypoint.sh", () => {
  const entrypoint = join(process.cwd(), "entrypoint.sh");
  let temporaryDirectory: string;
  let binaryDirectory: string;
  let callsFile: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "app-entrypoint-"));
    binaryDirectory = join(temporaryDirectory, "bin");
    callsFile = join(temporaryDirectory, "calls.log");
    mkdirSync(binaryDirectory);

    const nodeBinary = join(binaryDirectory, "node");
    writeFileSync(
      nodeBinary,
      `#!/bin/sh
printf 'node:%s\\n' "$*" > "$CALLS_FILE"
`,
    );
    chmodSync(nodeBinary, 0o755);
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("starts the application without running database migrations", () => {
    const result = spawnSync("sh", [entrypoint], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        CALLS_FILE: callsFile,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(callsFile, "utf8").trim()).toBe("node:dist/main");
  });
});
