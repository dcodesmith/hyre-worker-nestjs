import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type NestCliConfig = {
  compilerOptions?: {
    typeCheck?: boolean;
    builder?: {
      type?: string;
      options?: {
        extensions?: string[];
        ignore?: string[];
      };
    };
  };
};

describe("nest compiler config", () => {
  const nestCli = JSON.parse(readFileSync("nest-cli.json", "utf8")) as NestCliConfig;

  it("uses SWC without blocking start:dev on a full tsc typecheck", () => {
    expect(nestCli.compilerOptions?.builder?.type).toBe("swc");
    expect(nestCli.compilerOptions?.typeCheck).toBe(false);
  });

  it("compiles TSX email templates and skips spec files", () => {
    expect(nestCli.compilerOptions?.builder?.options?.extensions).toEqual(
      expect.arrayContaining([".ts", ".tsx"]),
    );
    expect(nestCli.compilerOptions?.builder?.options?.ignore).toEqual(
      expect.arrayContaining(["**/*.spec.ts", "**/email-previews/**"]),
    );
  });
});
