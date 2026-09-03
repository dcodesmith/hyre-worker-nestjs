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
    expect(workflow).toContain(
      "if: github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'",
    );
  });

  it("forks disposable preview databases from development", () => {
    const workflow = readRepositoryFile(".github/workflows/fly-preview.yml");

    expect(workflow).toContain("Create or reuse Neon development parent");
    expect(workflow).toContain(
      `branch_name: ${githubExpression("needs.setup.outputs.neon_branch")}`,
    );
    expect(workflow).toContain("parent_branch: development");
    expect(workflow).toContain("Migrate legacy preview branch parent");
    expect(workflow).toContain('PREVIEW_PARENT_ID" != "$DEVELOPMENT_BRANCH_ID');
    expect(workflow).toContain("?hard_delete=true");
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
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain('require_successful_workflow e2e.yml "E2E Tests"');
    expect(workflow).toContain('require_successful_workflow typecheck.yml "Type Check"');
    expect(workflow).toContain(
      'require_successful_workflow fly-deploy.yml "Development deployment"',
    );
    expect(workflow.match(/--connect-timeout 5 --max-time 10/g)).toHaveLength(2);
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
    expect(workflow).toContain('"repos/$GITHUB_REPOSITORY/releases"');
    expect(workflow).toContain("The first stable production release must be v1.0.0.");
    expect(workflow).not.toContain("git tag --list");
    expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7");
    expect(workflow).toContain(
      "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
    );
    expect(workflow).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7");
    expect(workflow).toContain(
      "superfly/flyctl-actions/setup-flyctl@dfdfedc86b296f5e5384f755a18bf400409a15d0 # v1.4",
    );
    expect(workflow).toContain("needs: [verify, deploy]");
    expect(workflow).toContain('gh release create "$RELEASE_VERSION"');
    expect(workflow.indexOf("Verify production health")).toBeLessThan(
      workflow.indexOf('gh release create "$RELEASE_VERSION"'),
    );
    expect(existsSync(join(process.cwd(), ".github/workflows/release-please.yml"))).toBe(false);
  });

  it("keeps the cross-agent release skill on the shared procedure", () => {
    const releaseSkill = readRepositoryFile(".agents/skills/release/SKILL.md");
    const codexPolicy = readRepositoryFile(".agents/skills/release/agents/openai.yaml");
    const procedure = readRepositoryFile("docs/release-command.md");

    expect(releaseSkill).toContain("name: release");
    expect(releaseSkill).toContain("disable-model-invocation: true");
    expect(releaseSkill).toContain("docs/release-command.md");
    expect(codexPolicy).toContain("allow_implicit_invocation: false");
    expect(existsSync(join(process.cwd(), ".cursor/commands/release.md"))).toBe(false);
    expect(existsSync(join(process.cwd(), ".claude/commands/release.md"))).toBe(false);
    expect(procedure).toContain(".github/workflows/fly-production.yml");
    expect(procedure).toContain("protected `production` environment");
    expect(procedure).toContain("/release status");
    expect(procedure).toContain("never bypass that gate");
  });
});
