import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function githubExpression(value: string): string {
  return ["$", "{{ ", value, " }}"].join("");
}

describe("deployment environment configuration", () => {
  it("keeps development and production on separate Fly apps", () => {
    const developmentConfig = readRepositoryFile("fly.toml");
    const productionConfig = readRepositoryFile("fly.production.toml");

    expect(developmentConfig).toContain("app = 'hyre-worker-nestjs'");
    expect(developmentConfig).toContain("APP_ENV = 'development'");
    expect(productionConfig).toContain('app = "hyre-worker-nestjs-production"');
    expect(productionConfig).toContain('APP_ENV = "production"');
    expect(productionConfig).toContain(
      'release_command = "/bin/sh scripts/run-prisma-migrations.sh"',
    );
  });

  it("deploys development against the long-lived Neon development branch", () => {
    const workflow = readRepositoryFile(".github/workflows/fly-deploy.yml");

    expect(workflow).toContain("branch_name: development");
    expect(workflow).toContain("parent_branch: main");
    expect(workflow).toContain(
      `DATABASE_URL: ${githubExpression("steps.neon_development.outputs.db_url_pooled")}`,
    );
    expect(workflow).toContain(
      `DIRECT_DATABASE_URL: ${githubExpression("steps.neon_development.outputs.db_url")}`,
    );
    expect(workflow).toContain('--env "APP_ENV=development"');
  });

  it("forks disposable preview databases from development", () => {
    const workflow = readRepositoryFile(".github/workflows/fly-preview.yml");

    expect(workflow).toContain(
      `branch_name: ${githubExpression("needs.setup.outputs.neon_branch")}`,
    );
    expect(workflow).toContain("parent_branch: development");
  });

  it("only deploys production through an approved manual workflow", () => {
    const workflow = readRepositoryFile(".github/workflows/fly-production.yml");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toMatch(/\n\s+push:/);
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("name: production");
    expect(workflow).toContain("branch_name: main");
    expect(workflow).toContain("branch_name: backup/production-");
    expect(workflow).toContain("fly.production.toml");
    expect(workflow).toContain('.environment == "production"');
  });

  it("validates both long-lived Fly configurations before merge", () => {
    const workflow = readRepositoryFile(".github/workflows/fly-validate.yml");

    expect(workflow).toContain("flyctl config validate --config fly.toml");
    expect(workflow).toContain("flyctl config validate --config fly.production.toml");
  });

  it("creates a version only after a healthy production deployment", () => {
    const packageJson = JSON.parse(readRepositoryFile("package.json")) as { version: string };
    const workflow = readRepositoryFile(".github/workflows/fly-production.yml");

    expect(packageJson.version).toBe("0.1.0");
    expect(workflow).toContain("version:");
    expect(workflow).toContain(
      "Version must use stable semantic version format vMAJOR.MINOR.PATCH.",
    );
    expect(workflow).toContain("needs: [verify, deploy]");
    expect(workflow).toContain('gh release create "$RELEASE_VERSION"');
    expect(workflow.indexOf("Verify production health")).toBeLessThan(
      workflow.indexOf('gh release create "$RELEASE_VERSION"'),
    );
    expect(existsSync(join(process.cwd(), ".github/workflows/release-please.yml"))).toBe(false);
  });

  it("keeps Cursor and Claude release commands on the shared procedure", () => {
    const cursorCommand = readRepositoryFile(".cursor/commands/release.md");
    const claudeCommand = readRepositoryFile(".claude/commands/release.md");
    const procedure = readRepositoryFile("docs/release-command.md");

    expect(cursorCommand).toContain("docs/release-command.md");
    expect(claudeCommand).toContain("docs/release-command.md");
    expect(procedure).toContain(".github/workflows/fly-production.yml");
    expect(procedure).toContain("/release status");
    expect(procedure).toContain("never bypass that gate");
  });
});
