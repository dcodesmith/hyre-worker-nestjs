import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const IMAGES_BUCKET = "hyre-assets-images-development";
const DOCS_BUCKET = "hyre-assets-docs-development";
const SOURCE_BUCKET = "legacy-dev-bucket";
const PUBLIC_BASE = "https://pub-7f459f6039f54e9b896f12bc832985f5.r2.dev";
const DEV_HOST = "ep-red-water-a53rrmcm-pooler.us-east-2.aws.neon.tech";
const MAIN_HOST = "ep-noisy-wind-a5v44fc6-pooler.us-east-2.aws.neon.tech";

const db = vi.hoisted(() => ({
  vehicleImage: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  documentApproval: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  $connect: vi.fn(),
  $disconnect: vi.fn(),
}));

const s3 = vi.hoisted(() => {
  const objects = new Map<string, Buffer>();
  const faults = new Map<string, Error>();
  const calls: Array<{
    store: "r2" | "s3";
    command: string;
    bucket?: string;
    key?: string;
    contentType?: string;
    cacheControl?: string;
  }> = [];

  return {
    objects,
    faults,
    calls,
    id: (bucket: string, key: string) => `${bucket}:${key}`,
    reset() {
      objects.clear();
      faults.clear();
      calls.length = 0;
    },
  };
});

vi.mock("dotenv/config", () => ({}));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class PrismaPg {} }));
vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(function PrismaClient() {
    return db;
  }),
}));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();

  class S3Client {
    private readonly store: "r2" | "s3";

    constructor(config: { endpoint?: string }) {
      this.store = config.endpoint?.includes("r2.cloudflarestorage.com") ? "r2" : "s3";
    }

    destroy() {}

    async send(command: {
      constructor: { name: string };
      input: {
        Bucket?: string;
        Key?: string;
        Body?: Buffer;
        ContentType?: string;
        CacheControl?: string;
      };
    }) {
      const commandName = command.constructor.name;
      const { Bucket, Key, Body, ContentType, CacheControl } = command.input;
      s3.calls.push({
        store: this.store,
        command: commandName,
        bucket: Bucket,
        key: Key,
        contentType: ContentType,
        cacheControl: CacheControl,
      });

      if (!Bucket || !Key) return {};
      const objectId = s3.id(Bucket, Key);
      const fault = s3.faults.get(`${this.store}:${objectId}`);
      if (fault) throw fault;

      if (commandName === "GetObjectCommand") {
        const body = s3.objects.get(objectId);
        if (!body) {
          const error = new Error("missing");
          error.name = "NoSuchKey";
          throw error;
        }
        return { Body: { transformToByteArray: async () => Uint8Array.from(body) } };
      }
      if (commandName === "HeadObjectCommand") {
        if (!s3.objects.has(objectId)) {
          const error = new Error("missing");
          error.name = "NotFound";
          throw error;
        }
        return {};
      }
      if (commandName === "PutObjectCommand") {
        s3.objects.set(objectId, Body as Buffer);
        return {};
      }
      if (commandName === "DeleteObjectCommand") {
        s3.objects.delete(objectId);
        return {};
      }
      return {};
    }
  }

  return { ...actual, S3Client };
});

const ENV_KEYS = [
  "APP_ENV",
  "STORAGE_DRIVER",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_IMAGES_BUCKET_NAME",
  "R2_DOCS_BUCKET_NAME",
  "ASSET_PUBLIC_BASE_URL",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BUCKET_NAME",
  "DATABASE_URL",
] as const;

const validEnv = {
  APP_ENV: "development",
  STORAGE_DRIVER: "r2",
  R2_ACCOUNT_ID: "ea5151b6637ce5379c9fea75e7e52aaa",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_SECRET_ACCESS_KEY: "r2-secret-key",
  R2_IMAGES_BUCKET_NAME: IMAGES_BUCKET,
  R2_DOCS_BUCKET_NAME: DOCS_BUCKET,
  ASSET_PUBLIC_BASE_URL: PUBLIC_BASE,
  AWS_REGION: "eu-west-2",
  AWS_ACCESS_KEY_ID: "aws-access-key",
  AWS_SECRET_ACCESS_KEY: "aws-secret-key",
  AWS_BUCKET_NAME: SOURCE_BUCKET,
  DATABASE_URL: `postgresql://user:pass@${DEV_HOST}/hyre`,
} as const;

function s3Url(key: string): string {
  return `https://${SOURCE_BUCKET}.s3.eu-west-2.amazonaws.com/${key}`;
}

async function raster(format: "jpeg" | "png", width = 32, height = 24) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 90, b: 100 } },
  })
    [format]()
    .toBuffer();
}

async function losslessWebp() {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .webp({ lossless: true })
    .toBuffer();
}

function pdfBuffer() {
  return Buffer.from("%PDF-1.4 fixture");
}

function put(bucket: string, key: string, body: Buffer) {
  s3.objects.set(s3.id(bucket, key), body);
}

function resetDb() {
  db.vehicleImage.findMany.mockReset().mockResolvedValue([]);
  db.vehicleImage.findUnique.mockReset();
  db.vehicleImage.updateMany.mockReset().mockResolvedValue({ count: 1 });
  db.documentApproval.findMany.mockReset().mockResolvedValue([]);
  db.documentApproval.findUnique.mockReset();
  db.documentApproval.updateMany.mockReset().mockResolvedValue({ count: 1 });
  db.$connect.mockReset().mockResolvedValue(undefined);
  db.$disconnect.mockReset().mockResolvedValue(undefined);
}

describe("migrate-development-assets", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let manifestDir: string;

  beforeEach(async () => {
    vi.resetModules();
    resetDb();
    s3.reset();
    process.exitCode = undefined;
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    Object.assign(process.env, validEnv);
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    manifestDir = await mkdtemp(join(tmpdir(), "r2-migrate-"));
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  async function runCli(args: string[] = []) {
    process.argv = ["node", "migrate-development-assets.ts", ...args];
    await import("./migrate-development-assets");
    await vi.waitFor(() => {
      expect(db.$disconnect.mock.calls.length > 0 || process.exitCode === 1).toBe(true);
    });
  }

  function summary() {
    const line = consoleLog.mock.calls
      .map(([value]) => value)
      .find((value): value is string => typeof value === "string" && value.startsWith("{"));
    expect(line).toBeDefined();
    return JSON.parse(line as string) as {
      mode: string;
      discovered: number;
      processed: number;
      changed: number;
      skipped: number;
      failed: number;
      manifest: string;
    };
  }

  function configError() {
    return consoleError.mock.calls.map(([value]) => String(value)).join("\n");
  }

  function manifestPath(name = "manifest.jsonl") {
    return join(manifestDir, name);
  }

  it("defaults to a dry run and does not mutate storage or the database", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([{ id: "img-1", url: s3Url(key) }]);

    await runCli([`--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({
      mode: "dry-run",
      discovered: 1,
      processed: 1,
      changed: 0,
      skipped: 1,
      failed: 0,
      manifest: "not-written",
    });
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    await expect(readFile(manifestPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["the main Neon endpoint", `postgresql://user:pass@${MAIN_HOST}/hyre`],
    ["localhost", "postgresql://user:pass@localhost:5432/hyre"],
    ["another Neon endpoint", "postgresql://user:pass@ep-other-host.us-east-2.aws.neon.tech/hyre"],
  ])("rejects a DATABASE_URL that uses %s", async (_label, databaseUrl) => {
    process.env.DATABASE_URL = databaseUrl;

    await runCli(["--apply"]);

    expect(configError()).toContain("approved Neon development endpoint");
    expect(db.$connect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects a malformed DATABASE_URL", async () => {
    process.env.DATABASE_URL = "not-a-url";

    await runCli();

    expect(configError()).toContain("DATABASE_URL must be a valid URL.");
    expect(db.$connect).not.toHaveBeenCalled();
  });

  it("discovers S3 URLs and constrained key-only /documents/ values", async () => {
    put(SOURCE_BUCKET, "owner/car/images/photo.jpg", await raster("jpeg"));
    put(DOCS_BUCKET, "owner/car/documents/scan.png", await raster("png"));
    db.vehicleImage.findMany.mockResolvedValueOnce([
      { id: "img-1", url: s3Url("owner/car/images/photo.jpg") },
    ]);
    db.documentApproval.findMany.mockResolvedValueOnce([
      { id: "doc-1", documentUrl: "owner/car/documents/scan.png" },
      { id: "doc-skip", documentUrl: "owner/car/images/not-a-document.png" },
      { id: "doc-unsafe", documentUrl: "owner/../documents/escape.png" },
    ]);

    await runCli();

    expect(summary()).toMatchObject({ discovered: 2, processed: 2, skipped: 2, failed: 0 });
  });

  it("fails unsafe discovered S3 image URLs without writing", async () => {
    db.vehicleImage.findMany.mockResolvedValueOnce([
      { id: "img-1", url: `https://evil.example/${SOURCE_BUCKET}/owner/car/images/photo.jpg` },
      {
        id: "img-2",
        url: `https://${SOURCE_BUCKET}.s3.eu-west-2.amazonaws.com/owner/car/images/photo.jpg?x=1`,
      },
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 2, failed: 2, changed: 0 });
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
  });

  it("probes R2 first for key-only documents and skips canonical PDF and lossless WebP", async () => {
    put(DOCS_BUCKET, "owner/car/documents/file.pdf", pdfBuffer());
    put(DOCS_BUCKET, "owner/car/documents/scan.webp", await losslessWebp());
    db.documentApproval.findMany.mockResolvedValueOnce([
      { id: "pdf-1", documentUrl: "owner/car/documents/file.pdf" },
      { id: "webp-1", documentUrl: "owner/car/documents/scan.webp" },
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 2, processed: 2, skipped: 2, failed: 0 });
    expect(s3.calls.filter((call) => call.store === "s3")).toEqual([]);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
  });

  it("converts a noncanonical R2 raster to a distinct private WebP key", async () => {
    put(DOCS_BUCKET, "owner/car/documents/scan.png", await raster("png", 16, 16));
    db.documentApproval.findMany.mockResolvedValueOnce([
      { id: "doc-1", documentUrl: "owner/car/documents/scan.png" },
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    const destination = s3.objects.get(s3.id(DOCS_BUCKET, "r2-migration/documents/doc-1.webp"));
    expect(destination).toBeDefined();
    expect(destination?.subarray(12, 16).toString("ascii")).toBe("VP8L");
    expect(s3.calls.some((call) => call.store === "s3")).toBe(false);
    expect(db.documentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", documentUrl: "owner/car/documents/scan.png" },
      data: { documentUrl: "r2-migration/documents/doc-1.webp" },
    });
    expect(summary()).toMatchObject({ changed: 1, failed: 0 });
  });

  it("falls back to S3 only after a confirmed R2 miss and fails if both are missing", async () => {
    put(SOURCE_BUCKET, "owner/car/documents/from-s3.png", await raster("png"));
    db.documentApproval.findMany.mockResolvedValueOnce([
      { id: "doc-1", documentUrl: "owner/car/documents/from-s3.png" },
      { id: "doc-2", documentUrl: "owner/car/documents/missing.png" },
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(
      s3.calls.filter(
        (call) =>
          call.command === "GetObjectCommand" && call.key === "owner/car/documents/from-s3.png",
      ),
    ).toEqual([
      expect.objectContaining({ store: "r2", bucket: DOCS_BUCKET }),
      expect.objectContaining({ store: "s3", bucket: SOURCE_BUCKET }),
    ]);
    expect(db.documentApproval.updateMany).toHaveBeenCalledTimes(1);
    expect(summary()).toMatchObject({ changed: 1, failed: 1 });
  });

  it("does not fall back to S3 when R2 returns a non-missing error", async () => {
    const denied = Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
    s3.faults.set(`r2:${s3.id(DOCS_BUCKET, "owner/car/documents/scan.png")}`, denied);
    put(SOURCE_BUCKET, "owner/car/documents/scan.png", await raster("png"));
    db.documentApproval.findMany.mockResolvedValueOnce([
      { id: "doc-1", documentUrl: "owner/car/documents/scan.png" },
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(s3.calls.some((call) => call.store === "s3")).toBe(false);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("uploads a public image as quality WebP before the conditional DB update", async () => {
    const key = "owner/car/images/hero.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg", 64, 48));
    db.vehicleImage.findMany.mockResolvedValueOnce([{ id: "img-1", url: s3Url(key) }]);
    db.vehicleImage.updateMany.mockImplementation(async () => {
      expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(true);
      return { count: 1 };
    });

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    const putCall = s3.calls.find((call) => call.command === "PutObjectCommand");
    expect(putCall).toMatchObject({
      store: "r2",
      bucket: IMAGES_BUCKET,
      key: "r2-migration/vehicle-images/img-1.webp",
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(db.vehicleImage.updateMany).toHaveBeenCalledWith({
      where: { id: "img-1", url: s3Url(key) },
      data: { url: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-1.webp` },
    });
  });

  it("preserves PDFs and writes the manifest as owner-only", async () => {
    const key = "owner/car/documents/file.pdf";
    put(SOURCE_BUCKET, key, pdfBuffer());
    db.documentApproval.findMany.mockResolvedValueOnce([{ id: "doc-1", documentUrl: s3Url(key) }]);
    const path = manifestPath();

    await runCli(["--apply", `--manifest=${path}`]);

    const putCall = s3.calls.find((call) => call.command === "PutObjectCommand");
    expect(putCall).toMatchObject({
      bucket: DOCS_BUCKET,
      key: "r2-migration/documents/doc-1.pdf",
      contentType: "application/pdf",
    });
    expect(putCall?.cacheControl).toBeUndefined();
    expect(s3.objects.get(s3.id(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf"))).toEqual(
      pdfBuffer(),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const [entry] = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sourceStore: string; destinationKey: string });
    expect(entry).toMatchObject({
      sourceStore: "s3",
      destinationKey: "r2-migration/documents/doc-1.pdf",
    });
  });

  it("is idempotent for already-canonical private R2 objects on rerun", async () => {
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.webp", await losslessWebp());
    db.documentApproval.findMany.mockResolvedValueOnce([
      { id: "doc-1", documentUrl: "r2-migration/documents/doc-1.webp" },
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ processed: 1, skipped: 1, changed: 0 });
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
  });

  it("treats a concurrent destination write as a skip and a different value as a failure", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([{ id: "img-1", url: s3Url(key) }]);
    db.vehicleImage.updateMany.mockResolvedValueOnce({ count: 0 });
    db.vehicleImage.findUnique.mockResolvedValueOnce({
      url: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-1.webp`,
    });

    await runCli(["--apply", `--manifest=${manifestPath("first.jsonl")}`]);
    expect(summary()).toMatchObject({ changed: 0, skipped: 1, failed: 0 });

    vi.resetModules();
    resetDb();
    s3.calls.length = 0;
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([{ id: "img-1", url: s3Url(key) }]);
    db.vehicleImage.updateMany.mockResolvedValueOnce({ count: 0 });
    db.vehicleImage.findUnique.mockResolvedValueOnce({ url: "https://other.example/changed.jpg" });
    consoleLog.mockClear();

    await runCli(["--apply", `--manifest=${manifestPath("second.jsonl")}`]);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("continues after a partial apply failure", async () => {
    put(SOURCE_BUCKET, "owner/car/images/ok.jpg", await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([
      { id: "img-bad", url: "https://evil.example/owner/car/images/bad.jpg" },
      { id: "img-ok", url: s3Url("owner/car/images/ok.jpg") },
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 2, changed: 1, failed: 1, processed: 1 });
    expect(db.vehicleImage.updateMany).toHaveBeenCalledWith({
      where: { id: "img-ok", url: s3Url("owner/car/images/ok.jpg") },
      data: { url: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-ok.webp` },
    });
    expect(process.exitCode).toBe(1);
  });

  it("rejects an invalid manifest before rollback or cleanup", async () => {
    const path = manifestPath();
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        table: "VehicleImage",
        id: "img-1",
        sourceValue: s3Url("owner/car/images/photo.jpg"),
        sourceStore: "r2",
        sourceKey: "owner/car/images/photo.jpg",
        destinationBucket: IMAGES_BUCKET,
        destinationKey: "r2-migration/vehicle-images/img-1.webp",
        destinationValue: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-1.webp`,
      })}\n`,
    );

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest entry does not match the development migration.");
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back after verifying the recorded source store", async () => {
    const sourceKey = "owner/car/documents/scan.png";
    const destinationKey = "r2-migration/documents/doc-1.webp";
    put(DOCS_BUCKET, sourceKey, await raster("png"));
    put(DOCS_BUCKET, destinationKey, await losslessWebp());
    const path = manifestPath();
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        table: "DocumentApproval",
        id: "doc-1",
        sourceValue: sourceKey,
        sourceStore: "r2",
        sourceKey,
        destinationBucket: DOCS_BUCKET,
        destinationKey,
        destinationValue: destinationKey,
      })}\n`,
    );
    await chmod(path, 0o600);
    db.documentApproval.findUnique.mockResolvedValue({ documentUrl: destinationKey });
    db.documentApproval.updateMany.mockResolvedValue({ count: 1 });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(s3.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "r2",
          command: "HeadObjectCommand",
          bucket: DOCS_BUCKET,
          key: sourceKey,
        }),
      ]),
    );
    expect(s3.calls.some((call) => call.store === "s3")).toBe(false);
    expect(db.documentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", documentUrl: destinationKey },
      data: { documentUrl: sourceKey },
    });
    expect(summary()).toMatchObject({ changed: 1, failed: 0 });
  });

  it("fails rollback when the row changed concurrently", async () => {
    const path = manifestPath();
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        table: "VehicleImage",
        id: "img-1",
        sourceValue: s3Url("owner/car/images/photo.jpg"),
        sourceStore: "s3",
        sourceKey: "owner/car/images/photo.jpg",
        destinationBucket: IMAGES_BUCKET,
        destinationKey: "r2-migration/vehicle-images/img-1.webp",
        destinationValue: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-1.webp`,
      })}\n`,
    );
    db.vehicleImage.findUnique.mockResolvedValue({ url: "https://other.example/changed.jpg" });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(summary()).toMatchObject({ failed: 1 });
  });

  it("cleans up only unreferenced manifest-scoped destination objects", async () => {
    const referenced = "r2-migration/documents/doc-keep.webp";
    const orphan = "r2-migration/documents/doc-drop.webp";
    put(DOCS_BUCKET, referenced, await losslessWebp());
    put(DOCS_BUCKET, orphan, await losslessWebp());
    put(DOCS_BUCKET, "unrelated/keep.webp", await losslessWebp());
    const path = manifestPath();
    await writeFile(
      path,
      [
        {
          version: 1,
          table: "DocumentApproval",
          id: "doc-keep",
          sourceValue: "owner/car/documents/keep.png",
          sourceStore: "s3",
          sourceKey: "owner/car/documents/keep.png",
          destinationBucket: DOCS_BUCKET,
          destinationKey: referenced,
          destinationValue: referenced,
        },
        {
          version: 1,
          table: "DocumentApproval",
          id: "doc-drop",
          sourceValue: "owner/car/documents/drop.png",
          sourceStore: "s3",
          sourceKey: "owner/car/documents/drop.png",
          destinationBucket: DOCS_BUCKET,
          destinationKey: orphan,
          destinationValue: orphan,
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
    );
    db.documentApproval.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        documentUrl: where.id === "doc-keep" ? referenced : "owner/car/documents/drop.png",
      }),
    );

    await runCli(["--cleanup-r2", `--manifest=${path}`]);

    expect(s3.calls.filter((call) => call.command === "DeleteObjectCommand")).toEqual([
      expect.objectContaining({ bucket: DOCS_BUCKET, key: orphan }),
    ]);
    expect(s3.objects.has(s3.id(DOCS_BUCKET, referenced))).toBe(true);
    expect(s3.objects.has(s3.id(DOCS_BUCKET, "unrelated/keep.webp"))).toBe(true);
    expect(summary()).toMatchObject({ changed: 1, skipped: 1, failed: 0 });
  });
});
