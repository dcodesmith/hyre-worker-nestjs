import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
  const contentTypes = new Map<string, string>();
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
    contentTypes,
    faults,
    calls,
    id: (bucket: string, key: string) => `${bucket}:${key}`,
    reset() {
      objects.clear();
      contentTypes.clear();
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
      const fault =
        s3.faults.get(`${this.store}:${commandName}:${objectId}`) ??
        s3.faults.get(`${this.store}:${objectId}`);
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
        return { ContentType: s3.contentTypes.get(objectId) };
      }
      if (commandName === "PutObjectCommand") {
        s3.objects.set(objectId, Body as Buffer);
        if (ContentType) s3.contentTypes.set(objectId, ContentType);
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

function publicUrl(key: string): string {
  return `${PUBLIC_BASE}/${key}`;
}

function imageRow(
  id: string,
  url: string,
  ownerId = "owner",
  carId = "car",
): { id: string; url: string; carId: string; car: { ownerId: string } } {
  return { id, url, carId, car: { ownerId } };
}

function carDocRow(
  id: string,
  documentUrl: string,
  ownerId = "owner",
  carId = "car",
): {
  id: string;
  documentUrl: string;
  userId: null;
  carId: string;
  car: { ownerId: string };
} {
  return { id, documentUrl, userId: null, carId, car: { ownerId } };
}

function userDocRow(
  id: string,
  documentUrl: string,
  userId = "user-1",
): {
  id: string;
  documentUrl: string;
  userId: string;
  carId: null;
  car: null;
} {
  return { id, documentUrl, userId, carId: null, car: null };
}

function keyOnlyDocRow(
  id: string,
  documentUrl: string,
): {
  id: string;
  documentUrl: string;
  userId: null;
  carId: string;
  car: { ownerId: string };
} {
  return { id, documentUrl, userId: null, carId: "car", car: { ownerId: "owner" } };
}

function truncatedJpeg(): Buffer {
  const header = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
  const buffer = Buffer.alloc(136);
  header.copy(buffer);
  return buffer;
}

function bindingFields(
  ownerId: string | null = "owner",
  carId: string | null = "car",
  userId: string | null = null,
) {
  return { ownerId, carId, userId };
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

function put(bucket: string, key: string, body: Buffer, contentType?: string) {
  const objectId = s3.id(bucket, key);
  s3.objects.set(objectId, body);
  if (contentType) s3.contentTypes.set(objectId, contentType);
}

function destinationProof(body: Buffer) {
  return {
    destinationDigest: createHash("sha256").update(body).digest("hex"),
    destinationSize: body.byteLength,
  };
}

function r2ImagesManifestEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sourceKey = "owner/car/documents/file.pdf";
  return {
    version: 3,
    table: "DocumentApproval",
    id: "doc-1",
    sourceValue: publicUrl(sourceKey),
    sourceStore: "r2-images",
    sourceKey,
    destinationBucket: DOCS_BUCKET,
    destinationKey: "r2-migration/documents/doc-1.pdf",
    destinationValue: "r2-migration/documents/doc-1.pdf",
    ...bindingFields(),
    ...destinationProof(pdfBuffer()),
    ...overrides,
  };
}

function vehicleManifestEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sourceKey = "owner/car/images/photo.jpg";
  return {
    version: 3,
    table: "VehicleImage",
    id: "img-1",
    sourceValue: s3Url(sourceKey),
    sourceStore: "s3",
    sourceKey,
    destinationBucket: IMAGES_BUCKET,
    destinationKey: "r2-migration/vehicle-images/img-1.webp",
    destinationValue: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-1.webp`,
    ...bindingFields(),
    ...destinationProof(Buffer.from("webp-fixture")),
    ...overrides,
  };
}

async function writeSecureManifest(path: string, entries: unknown[]) {
  await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  await chmod(path, 0o600);
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

  function failureCategories() {
    const counts: Record<string, number> = {};
    for (const [value] of consoleError.mock.calls) {
      const match = String(value).match(/failed \(([^)]+)\)\.$/);
      if (match?.[1]) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
    }
    return counts;
  }

  function manifestPath(name = "manifest.jsonl") {
    return join(manifestDir, name);
  }

  it("defaults to a dry run and does not mutate storage or the database", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);

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
      imageRow("img-1", s3Url("owner/car/images/photo.jpg")),
    ]);
    db.documentApproval.findMany.mockResolvedValueOnce([
      keyOnlyDocRow("doc-1", "owner/car/documents/scan.png"),
      keyOnlyDocRow("doc-skip", "owner/car/images/not-a-document.png"),
      keyOnlyDocRow("doc-unsafe", "owner/../documents/escape.png"),
    ]);

    await runCli();

    expect(summary()).toMatchObject({ discovered: 2, processed: 2, skipped: 2, failed: 0 });
  });

  it("fails unsafe discovered S3 image URLs without writing", async () => {
    db.vehicleImage.findMany.mockResolvedValueOnce([
      imageRow("img-1", `https://evil.example/${SOURCE_BUCKET}/owner/car/images/photo.jpg`),
      imageRow(
        "img-2",
        `https://${SOURCE_BUCKET}.s3.eu-west-2.amazonaws.com/owner/car/images/photo.jpg?x=1`,
      ),
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
      keyOnlyDocRow("pdf-1", "owner/car/documents/file.pdf"),
      keyOnlyDocRow("webp-1", "owner/car/documents/scan.webp"),
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
      keyOnlyDocRow("doc-1", "owner/car/documents/scan.png"),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    const destination = s3.objects.get(s3.id(DOCS_BUCKET, "owner/car/documents/scan.webp"));
    expect(destination).toBeDefined();
    expect(destination?.subarray(12, 16).toString("ascii")).toBe("VP8L");
    expect(s3.calls.some((call) => call.store === "s3")).toBe(false);
    expect(db.documentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", documentUrl: "owner/car/documents/scan.png" },
      data: { documentUrl: "owner/car/documents/scan.webp" },
    });
    expect(summary()).toMatchObject({ changed: 1, failed: 0 });
  });

  it("falls back to S3 only after a confirmed R2 miss and fails if both are missing", async () => {
    put(SOURCE_BUCKET, "owner/car/documents/from-s3.png", await raster("png"));
    db.documentApproval.findMany.mockResolvedValueOnce([
      keyOnlyDocRow("doc-1", "owner/car/documents/from-s3.png"),
      keyOnlyDocRow("doc-2", "owner/car/documents/missing.png"),
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
      keyOnlyDocRow("doc-1", "owner/car/documents/scan.png"),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(s3.calls.some((call) => call.store === "s3")).toBe(false);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("uploads a public image as quality WebP before the conditional DB update", async () => {
    const key = "owner/car/images/hero.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg", 64, 48));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    db.vehicleImage.updateMany.mockImplementation(async () => {
      expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(true);
      return { count: 1 };
    });

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    const putCall = s3.calls.find((call) => call.command === "PutObjectCommand");
    expect(putCall).toMatchObject({
      store: "r2",
      bucket: IMAGES_BUCKET,
      key: "owner/car/images/hero.webp",
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(db.vehicleImage.updateMany).toHaveBeenCalledWith({
      where: { id: "img-1", url: s3Url(key) },
      data: { url: `${PUBLIC_BASE}/owner/car/images/hero.webp` },
    });
  });

  it("preserves PDFs and writes the manifest as owner-only", async () => {
    const key = "owner/car/documents/file.pdf";
    put(SOURCE_BUCKET, key, pdfBuffer());
    db.documentApproval.findMany.mockResolvedValueOnce([carDocRow("doc-1", s3Url(key))]);
    const path = manifestPath();

    await runCli(["--apply", `--manifest=${path}`]);

    const putCall = s3.calls.find((call) => call.command === "PutObjectCommand");
    expect(putCall).toMatchObject({
      bucket: DOCS_BUCKET,
      key: "owner/car/documents/file.pdf",
      contentType: "application/pdf",
    });
    expect(putCall?.cacheControl).toBeUndefined();
    expect(s3.objects.get(s3.id(DOCS_BUCKET, "owner/car/documents/file.pdf"))).toEqual(pdfBuffer());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const [entry] = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entry).toMatchObject({
      version: 3,
      sourceStore: "s3",
      destinationKey: "owner/car/documents/file.pdf",
      ...bindingFields(),
      ...destinationProof(pdfBuffer()),
    });
    expect(entry).not.toHaveProperty("email");
    expect(entry).not.toHaveProperty("name");
  });

  it("is idempotent for already-canonical private R2 objects on rerun", async () => {
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.webp", await losslessWebp());
    db.documentApproval.findMany.mockResolvedValueOnce([
      keyOnlyDocRow("doc-1", "r2-migration/documents/doc-1.webp"),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ processed: 1, skipped: 1, changed: 0 });
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
  });

  it("treats a concurrent destination write as a skip and a different value as a failure", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    db.vehicleImage.updateMany.mockResolvedValueOnce({ count: 0 });
    db.vehicleImage.findUnique.mockResolvedValueOnce({
      url: `${PUBLIC_BASE}/owner/car/images/photo.webp`,
    });

    await runCli(["--apply", `--manifest=${manifestPath("first.jsonl")}`]);
    expect(summary()).toMatchObject({ changed: 0, skipped: 1, failed: 0 });

    vi.resetModules();
    resetDb();
    s3.calls.length = 0;
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    db.vehicleImage.updateMany.mockResolvedValueOnce({ count: 0 });
    db.vehicleImage.findUnique.mockResolvedValueOnce({ url: "https://other.example/changed.jpg" });
    consoleLog.mockClear();

    await runCli(["--apply", `--manifest=${manifestPath("second.jsonl")}`]);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("continues after a partial apply failure", async () => {
    put(SOURCE_BUCKET, "owner/car/images/ok.jpg", await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([
      imageRow("img-bad", "https://evil.example/owner/car/images/bad.jpg"),
      imageRow("img-ok", s3Url("owner/car/images/ok.jpg")),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 2, changed: 1, failed: 1, processed: 1 });
    expect(db.vehicleImage.updateMany).toHaveBeenCalledWith({
      where: { id: "img-ok", url: s3Url("owner/car/images/ok.jpg") },
      data: { url: `${PUBLIC_BASE}/owner/car/images/ok.webp` },
    });
    expect(process.exitCode).toBe(1);
  });

  it("rejects an unversioned or v1 manifest before rollback or cleanup", async () => {
    const path = manifestPath();
    await writeSecureManifest(path, [vehicleManifestEntry({ version: 1 })]);

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is invalid.");
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(s3.calls.some((call) => call.command === "HeadObjectCommand")).toBe(false);
  });

  it("rolls back after verifying the recorded source store", async () => {
    const sourceKey = "owner/car/documents/scan.png";
    const destinationKey = "r2-migration/documents/doc-1.webp";
    put(DOCS_BUCKET, sourceKey, await raster("png"));
    const destBody = await losslessWebp();
    put(DOCS_BUCKET, destinationKey, destBody);
    const path = manifestPath();
    await writeSecureManifest(path, [
      {
        version: 3,
        table: "DocumentApproval",
        id: "doc-1",
        sourceValue: sourceKey,
        sourceStore: "r2",
        sourceKey,
        destinationBucket: DOCS_BUCKET,
        destinationKey,
        destinationValue: destinationKey,
        ...bindingFields(),
        ...destinationProof(destBody),
      },
    ]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: destinationKey,
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });
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
    await writeSecureManifest(path, [vehicleManifestEntry()]);
    db.vehicleImage.findUnique.mockResolvedValue({
      url: "https://other.example/changed.jpg",
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(summary()).toMatchObject({ failed: 1 });
  });

  it("cleans up only unreferenced manifest-scoped destination objects", async () => {
    const referenced = "r2-migration/documents/doc-keep.webp";
    const orphan = "r2-migration/documents/doc-drop.webp";
    const keepBody = await losslessWebp();
    const dropBody = await losslessWebp();
    put(DOCS_BUCKET, referenced, keepBody);
    put(DOCS_BUCKET, orphan, dropBody);
    put(DOCS_BUCKET, "unrelated/keep.webp", await losslessWebp());
    const path = manifestPath();
    await writeSecureManifest(path, [
      {
        version: 3,
        table: "DocumentApproval",
        id: "doc-keep",
        sourceValue: "owner/car/documents/keep.png",
        sourceStore: "s3",
        sourceKey: "owner/car/documents/keep.png",
        destinationBucket: DOCS_BUCKET,
        destinationKey: referenced,
        destinationValue: referenced,
        ...bindingFields(),
        ...destinationProof(keepBody),
      },
      {
        version: 3,
        table: "DocumentApproval",
        id: "doc-drop",
        sourceValue: "owner/car/documents/drop.png",
        sourceStore: "s3",
        sourceKey: "owner/car/documents/drop.png",
        destinationBucket: DOCS_BUCKET,
        destinationKey: orphan,
        destinationValue: orphan,
        ...bindingFields(),
        ...destinationProof(dropBody),
      },
    ]);
    db.documentApproval.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        documentUrl: where.id === "doc-keep" ? referenced : "owner/car/documents/drop.png",
        userId: null,
        carId: "car",
        car: { ownerId: "owner" },
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

  it("writes depth-2 vehicle images to the live owner/car/images key", async () => {
    const key = "owner/car-1700000000000-photo.jpeg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(s3.calls.find((call) => call.command === "PutObjectCommand")).toMatchObject({
      key: "owner/car/images/1700000000000-photo.webp",
    });
    expect(db.vehicleImage.updateMany).toHaveBeenCalledWith({
      where: { id: "img-1", url: s3Url(key) },
      data: { url: `${PUBLIC_BASE}/owner/car/images/1700000000000-photo.webp` },
    });
  });

  it("migrates hireApp depth-2 vehicle keys bound to ownerId and carId", async () => {
    const key = "owner/car-1700000000000-photo.jpeg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);

    await runCli([`--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({
      discovered: 1,
      processed: 1,
      skipped: 1,
      failed: 0,
      changed: 0,
    });
  });

  it("rejects a depth-2 vehicle key whose first segment is not the car owner", async () => {
    const key = "other-owner/car-1700000000000-photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ LegacyKeyOwnerMismatch: 1 });
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
  });

  it("rejects unsupported vehicle extensions even when the owner path matches", async () => {
    db.vehicleImage.findMany.mockResolvedValueOnce([
      imageRow("img-1", s3Url("owner/car-1700000000000-photo.gif")),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ UnsupportedLegacyExtension: 1 });
  });

  it("discovers exact-host depth-2 S3 documents and leaves key-only /documents/ intact", async () => {
    put(SOURCE_BUCKET, "owner/car-1700000000000-mot.pdf", pdfBuffer());
    put(SOURCE_BUCKET, "user-1/1700000000000-nin.png", await raster("png"));
    put(DOCS_BUCKET, "owner/car/documents/scan.webp", await losslessWebp());
    db.vehicleImage.findMany.mockResolvedValueOnce([]);
    db.documentApproval.findMany.mockResolvedValueOnce([
      carDocRow("mot-1", s3Url("owner/car-1700000000000-mot.pdf")),
      userDocRow("nin-1", s3Url("user-1/1700000000000-nin.png")),
      keyOnlyDocRow("doc-canonical", "owner/car/documents/scan.webp"),
      carDocRow("doc-wrong-host", "https://evil.example/owner/car-1700000000000-mot.pdf"),
      keyOnlyDocRow("doc-not-documents", "owner/car/images/not-a-document.png"),
    ]);

    await runCli();

    expect(summary()).toMatchObject({ discovered: 3, processed: 3, skipped: 3, failed: 0 });
  });

  it("rejects a car document whose filename is not prefixed by that car id", async () => {
    db.documentApproval.findMany.mockResolvedValueOnce([
      carDocRow("doc-1", s3Url("owner/othercar-1700000000000-mot.pdf")),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ LegacyKeyOwnerMismatch: 1 });
  });

  it("rejects unsupported document extensions on exact-host S3 URLs", async () => {
    db.documentApproval.findMany.mockResolvedValueOnce([
      userDocRow("doc-1", s3Url("user-1/1700000000000-nin.html")),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ UnsupportedLegacyExtension: 1 });
  });

  it("fail-closes a truncated JPEG with SourceImageDecodeError and does not write", async () => {
    const key = "owner/car/images/broken.jpg";
    const fixture = truncatedJpeg();
    expect(fixture.byteLength).toBe(136);
    put(SOURCE_BUCKET, key, fixture);
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ SourceImageDecodeError: 1 });
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a key-only R2 document whose path is not bound to the current row before fetch", async () => {
    put(DOCS_BUCKET, "owner/car/documents/scan.png", await raster("png"));
    db.documentApproval.findMany.mockResolvedValueOnce([
      carDocRow("doc-1", "owner/car/documents/scan.png", "other-owner", "car"),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ LegacyKeyOwnerMismatch: 1 });
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a key-only S3-fallback document whose path is not bound before fetch", async () => {
    put(SOURCE_BUCKET, "owner/car/documents/scan.png", await raster("png"));
    db.documentApproval.findMany.mockResolvedValueOnce([
      carDocRow("doc-1", "owner/car/documents/scan.png", "other-owner", "car"),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ LegacyKeyOwnerMismatch: 1 });
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a versioned manifest that omits ownership binding fields", async () => {
    const path = manifestPath();
    const unbound = vehicleManifestEntry();
    delete unbound.ownerId;
    delete unbound.carId;
    delete unbound.userId;
    await writeSecureManifest(path, [unbound]);
    db.vehicleImage.findUnique.mockResolvedValue({
      url: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-1.webp`,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is invalid.");
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(s3.calls.some((call) => call.command === "HeadObjectCommand")).toBe(false);
  });

  it("rejects a manifest whose binding does not match current row relationships", async () => {
    const path = manifestPath();
    await writeSecureManifest(path, [
      {
        version: 3,
        table: "DocumentApproval",
        id: "doc-1",
        sourceValue: "owner/car/documents/scan.png",
        sourceStore: "r2",
        sourceKey: "owner/car/documents/scan.png",
        destinationBucket: DOCS_BUCKET,
        destinationKey: "r2-migration/documents/doc-1.webp",
        destinationValue: "r2-migration/documents/doc-1.webp",
        ...bindingFields(),
        ...destinationProof(Buffer.from("webp-fixture")),
      },
    ]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.webp",
      userId: null,
      carId: "car",
      car: { ownerId: "other-owner" },
    });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest binding does not match current row relationships.");
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    expect(s3.calls.some((call) => call.command === "HeadObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
  });

  it.each([
    {
      label: "legacy vehicle",
      seed: async () => {
        const sourceKey = "owner/car-1700000000000-photo.jpg";
        put(SOURCE_BUCKET, sourceKey, await raster("jpeg"));
        db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(sourceKey))]);
        return {
          table: "VehicleImage" as const,
          id: "img-1",
          sourceValue: s3Url(sourceKey),
          sourceKey,
          destinationKey: "owner/car/images/1700000000000-photo.webp",
          destinationValue: `${PUBLIC_BASE}/owner/car/images/1700000000000-photo.webp`,
          sourceStore: "s3" as const,
          sourceBucket: SOURCE_BUCKET,
          updateModel: db.vehicleImage,
          currentRow: {
            url: `${PUBLIC_BASE}/owner/car/images/1700000000000-photo.webp`,
            carId: "car",
            car: { ownerId: "owner" },
          },
          restoreWhere: {
            id: "img-1",
            url: `${PUBLIC_BASE}/owner/car/images/1700000000000-photo.webp`,
          },
          restoreData: { url: s3Url(sourceKey) },
          binding: bindingFields(),
        };
      },
    },
    {
      label: "car document",
      seed: async () => {
        const sourceKey = "owner/car-1700000000000-mot.pdf";
        put(SOURCE_BUCKET, sourceKey, pdfBuffer());
        db.documentApproval.findMany.mockResolvedValueOnce([carDocRow("mot-1", s3Url(sourceKey))]);
        return {
          table: "DocumentApproval" as const,
          id: "mot-1",
          sourceValue: s3Url(sourceKey),
          sourceKey,
          destinationKey: "owner/car/documents/1700000000000-mot.pdf",
          destinationValue: "owner/car/documents/1700000000000-mot.pdf",
          sourceStore: "s3" as const,
          sourceBucket: SOURCE_BUCKET,
          updateModel: db.documentApproval,
          currentRow: {
            documentUrl: "owner/car/documents/1700000000000-mot.pdf",
            userId: null,
            carId: "car",
            car: { ownerId: "owner" },
          },
          restoreWhere: {
            id: "mot-1",
            documentUrl: "owner/car/documents/1700000000000-mot.pdf",
          },
          restoreData: { documentUrl: s3Url(sourceKey) },
          binding: bindingFields(),
        };
      },
    },
    {
      label: "user document",
      seed: async () => {
        const sourceKey = "user-1/1700000000000-nin.png";
        put(SOURCE_BUCKET, sourceKey, await raster("png"));
        db.documentApproval.findMany.mockResolvedValueOnce([userDocRow("nin-1", s3Url(sourceKey))]);
        return {
          table: "DocumentApproval" as const,
          id: "nin-1",
          sourceValue: s3Url(sourceKey),
          sourceKey,
          destinationKey: "user-1/documents/1700000000000-nin.webp",
          destinationValue: "user-1/documents/1700000000000-nin.webp",
          sourceStore: "s3" as const,
          sourceBucket: SOURCE_BUCKET,
          updateModel: db.documentApproval,
          currentRow: {
            documentUrl: "user-1/documents/1700000000000-nin.webp",
            userId: "user-1",
            carId: null,
            car: null,
          },
          restoreWhere: {
            id: "nin-1",
            documentUrl: "user-1/documents/1700000000000-nin.webp",
          },
          restoreData: { documentUrl: s3Url(sourceKey) },
          binding: bindingFields(null, null, "user-1"),
        };
      },
    },
  ])(
    "applies, records bindings, and rolls back a $label after source-store verification",
    async ({ seed }) => {
      const path = manifestPath();
      const expected = await seed();

      await runCli(["--apply", `--manifest=${path}`]);

      expect(summary()).toMatchObject({ changed: 1, failed: 0, processed: 1 });
      expect(expected.updateModel.updateMany).toHaveBeenCalledWith({
        where:
          expected.table === "VehicleImage"
            ? { id: expected.id, url: expected.sourceValue }
            : { id: expected.id, documentUrl: expected.sourceValue },
        data:
          expected.table === "VehicleImage"
            ? { url: expected.destinationValue }
            : { documentUrl: expected.destinationValue },
      });
      const [entry] = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entry).toMatchObject({
        version: 3,
        table: expected.table,
        id: expected.id,
        sourceValue: expected.sourceValue,
        sourceStore: expected.sourceStore,
        sourceKey: expected.sourceKey,
        destinationKey: expected.destinationKey,
        destinationValue: expected.destinationValue,
        destinationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        destinationSize: expect.any(Number),
        ...expected.binding,
      });
      expect(entry.destinationSize).toBeGreaterThan(0);

      vi.resetModules();
      resetDb();
      s3.calls.length = 0;
      consoleLog.mockClear();
      consoleError.mockClear();
      if (expected.table === "VehicleImage") {
        db.vehicleImage.findUnique.mockResolvedValue(expected.currentRow);
      } else {
        db.documentApproval.findUnique.mockResolvedValue(expected.currentRow);
      }

      await runCli(["--rollback", `--manifest=${path}`]);

      expect(s3.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            store: expected.sourceStore,
            command: "HeadObjectCommand",
            bucket: expected.sourceBucket,
            key: expected.sourceKey,
          }),
        ]),
      );
      expect(expected.updateModel.updateMany).toHaveBeenCalledWith({
        where: expected.restoreWhere,
        data: expected.restoreData,
      });
      expect(summary()).toMatchObject({ changed: 1, failed: 0, processed: 1 });
    },
  );

  it("migrates an exact-host public document from the images bucket to a private docs key", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    db.documentApproval.findMany.mockResolvedValueOnce([carDocRow("doc-1", publicUrl(sourceKey))]);
    const path = manifestPath();

    await runCli(["--apply", `--manifest=${path}`]);

    expect(
      s3.calls.filter((call) => call.command === "GetObjectCommand" && call.key === sourceKey),
    ).toEqual([expect.objectContaining({ store: "r2", bucket: IMAGES_BUCKET, key: sourceKey })]);
    expect(
      s3.calls.some(
        (call) =>
          call.command === "GetObjectCommand" &&
          (call.bucket === DOCS_BUCKET || call.bucket === SOURCE_BUCKET) &&
          call.key === sourceKey,
      ),
    ).toBe(false);
    expect(s3.calls.find((call) => call.command === "PutObjectCommand")).toMatchObject({
      store: "r2",
      bucket: DOCS_BUCKET,
      key: "owner/car/documents/file.pdf",
      contentType: "application/pdf",
    });
    expect(s3.objects.get(s3.id(IMAGES_BUCKET, sourceKey))).toEqual(pdfBuffer());
    expect(s3.objects.get(s3.id(DOCS_BUCKET, "owner/car/documents/file.pdf"))).toEqual(pdfBuffer());
    expect(db.documentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", documentUrl: publicUrl(sourceKey) },
      data: { documentUrl: "owner/car/documents/file.pdf" },
    });
    const [entry] = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entry).toMatchObject({
      version: 3,
      sourceStore: "r2-images",
      sourceKey,
      destinationBucket: DOCS_BUCKET,
      destinationKey: "owner/car/documents/file.pdf",
      destinationValue: "owner/car/documents/file.pdf",
      ...bindingFields(),
      ...destinationProof(pdfBuffer()),
    });
    expect(summary()).toMatchObject({ discovered: 1, changed: 1, failed: 0 });
  });

  it("relocates a legacy CLI destination onto the live upload key", async () => {
    const body = pdfBuffer();
    const path = manifestPath();
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", body, "application/pdf");
    await writeSecureManifest(path, [r2ImagesManifestEntry({ ...destinationProof(body) })]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--relocate", `--manifest=${path}`]);

    expect(s3.objects.get(s3.id(DOCS_BUCKET, "owner/car/documents/file.pdf"))).toEqual(body);
    expect(db.documentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", documentUrl: "r2-migration/documents/doc-1.pdf" },
      data: { documentUrl: "owner/car/documents/file.pdf" },
    });
    expect(summary()).toMatchObject({ mode: "relocate", changed: 1, failed: 0, processed: 1 });
  });

  it("fails relocate when the recorded destination digest does not match R2", async () => {
    const path = manifestPath();
    put(
      DOCS_BUCKET,
      "r2-migration/documents/doc-1.pdf",
      Buffer.from("%PDF-tampered"),
      "application/pdf",
    );
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--relocate", `--manifest=${path}`]);

    expect(s3.objects.has(s3.id(DOCS_BUCKET, "owner/car/documents/file.pdf"))).toBe(false);
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ DestinationIntegrityMismatch: 1 });
  });

  it("does not discover a document URL on another r2.dev host", async () => {
    put(IMAGES_BUCKET, "owner/car/documents/file.pdf", pdfBuffer());
    db.documentApproval.findMany.mockResolvedValueOnce([
      carDocRow("doc-1", "https://pub-other.r2.dev/owner/car/documents/file.pdf"),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 0, processed: 0, changed: 0, failed: 0 });
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an exact-host public document whose path is not bound before fetch", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    db.documentApproval.findMany.mockResolvedValueOnce([
      carDocRow("doc-1", publicUrl(sourceKey), "other-owner", "car"),
    ]);

    await runCli(["--apply", `--manifest=${manifestPath()}`]);

    expect(summary()).toMatchObject({ discovered: 1, failed: 1, changed: 0 });
    expect(failureCategories()).toEqual({ LegacyKeyOwnerMismatch: 1 });
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back an r2-images document after verifying the images-bucket source", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destinationKey = "r2-migration/documents/doc-1.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, destinationKey, pdfBuffer());
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: destinationKey,
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(s3.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "r2",
          command: "HeadObjectCommand",
          bucket: IMAGES_BUCKET,
          key: sourceKey,
        }),
      ]),
    );
    expect(
      s3.calls.some((call) => call.command === "HeadObjectCommand" && call.bucket === DOCS_BUCKET),
    ).toBe(false);
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(db.documentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", documentUrl: destinationKey },
      data: { documentUrl: publicUrl(sourceKey) },
    });
    expect(summary()).toMatchObject({ changed: 1, failed: 0 });
  });

  it("cleans up an r2-images destination without deleting the images-bucket source", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destinationKey = "r2-migration/documents/doc-1.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, destinationKey, pdfBuffer());
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "already-restored-key",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-r2", `--manifest=${path}`]);

    expect(s3.calls.filter((call) => call.command === "DeleteObjectCommand")).toEqual([
      expect.objectContaining({ bucket: DOCS_BUCKET, key: destinationKey }),
    ]);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(s3.objects.has(s3.id(DOCS_BUCKET, destinationKey))).toBe(false);
    expect(summary()).toMatchObject({ changed: 1, failed: 0 });
  });

  it("deletes only a verified r2-images public source after the private destination is in use", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destinationKey = "r2-migration/documents/doc-1.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, destinationKey, pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: destinationKey,
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(s3.calls.filter((call) => call.command === "DeleteObjectCommand")).toEqual([
      expect.objectContaining({ store: "r2", bucket: IMAGES_BUCKET, key: sourceKey }),
    ]);
    expect(s3.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "GetObjectCommand",
          bucket: DOCS_BUCKET,
          key: destinationKey,
        }),
      ]),
    );
    expect(db.documentApproval.findMany).toHaveBeenCalledWith({
      where: { documentUrl: { contains: sourceKey } },
      select: { documentUrl: true },
    });
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(false);
    expect(s3.objects.has(s3.id(DOCS_BUCKET, destinationKey))).toBe(true);
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    expect(summary()).toMatchObject({
      mode: "cleanup-public-sources",
      changed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(configError()).toContain("cannot be rolled back");
  });

  it("leaves unrelated manifest sources untouched during public-source cleanup", async () => {
    const publicSource = "owner/car/documents/file.pdf";
    const vehicleSource = "owner/car/images/photo.jpg";
    const vehicleDest = "r2-migration/vehicle-images/img-1.webp";
    put(IMAGES_BUCKET, publicSource, pdfBuffer());
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
    put(SOURCE_BUCKET, vehicleSource, await raster("jpeg"));
    put(IMAGES_BUCKET, vehicleDest, await losslessWebp(), "image/webp");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry(), vehicleManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });
    db.vehicleImage.findUnique.mockResolvedValue({
      url: `${PUBLIC_BASE}/${vehicleDest}`,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(s3.calls.filter((call) => call.command === "DeleteObjectCommand")).toEqual([
      expect.objectContaining({ bucket: IMAGES_BUCKET, key: publicSource }),
    ]);
    expect(s3.objects.has(s3.id(SOURCE_BUCKET, vehicleSource))).toBe(true);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, vehicleDest))).toBe(true);
    expect(s3.objects.has(s3.id(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf"))).toBe(true);
    expect(summary()).toMatchObject({ changed: 1, skipped: 1, failed: 0 });
  });

  it("does not delete a public source when the row is not on the private destination", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: publicUrl(sourceKey),
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({ DestinationNotInUse: 1 });
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("does not delete a public source when the private destination is missing", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({ DestinationObjectNotFound: 1 });
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("rejects public-source cleanup when manifest bindings do not match the current row", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "other-owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest binding does not match current row relationships.");
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(db.$connect).toHaveBeenCalled();
  });

  it("treats an already-missing public source as a successful skip", async () => {
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(summary()).toMatchObject({ changed: 0, skipped: 1, failed: 0, processed: 1 });
    expect(process.exitCode).toBeUndefined();
  });

  it("fails visibly when deleting a public source returns a non-missing error", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
    s3.faults.set(
      `r2:DeleteObjectCommand:${s3.id(IMAGES_BUCKET, sourceKey)}`,
      Object.assign(new Error("denied"), {
        $metadata: { httpStatusCode: 403 },
        name: "AccessDenied",
      }),
    );
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({ AccessDenied: 1 });
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(s3.objects.has(s3.id(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf"))).toBe(true);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
    expect(process.exitCode).toBe(1);
  });

  it("fails rollback closed after public-source cleanup and does not restore the public URL", async () => {
    const destinationKey = "r2-migration/documents/doc-1.pdf";
    put(DOCS_BUCKET, destinationKey, pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: destinationKey,
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({ SourceObjectNotFound: 1 });
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    expect(s3.objects.has(s3.id(DOCS_BUCKET, destinationKey))).toBe(true);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("rejects apply against a stale v1 manifest before any fetch or write", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    const path = manifestPath();
    await writeFile(path, `${JSON.stringify(vehicleManifestEntry({ version: 1 }))}\n`);
    await chmod(path, 0o600);

    await runCli(["--apply", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is invalid.");
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects apply against a mixed v1/v3 manifest before any fetch or write", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    const path = manifestPath();
    await writeFile(
      path,
      `${JSON.stringify(vehicleManifestEntry({ version: 1 }))}\n${JSON.stringify(vehicleManifestEntry())}\n`,
    );
    await chmod(path, 0o600);

    await runCli(["--apply", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is invalid.");
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
  });

  it("rejects apply against a malformed manifest before any fetch or write", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    const path = manifestPath();
    await writeFile(path, "{not-json\n");
    await chmod(path, 0o600);

    await runCli(["--apply", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is invalid.");
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
  });

  it("rejects apply when the manifest is world-readable", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    const path = manifestPath();
    await writeFile(path, `${JSON.stringify(vehicleManifestEntry())}\n`);
    await chmod(path, 0o644);
    db.vehicleImage.findUnique.mockResolvedValue({
      url: s3Url(key),
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--apply", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest permissions are unsafe.");
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
  });

  it("applies when the manifest file is missing or empty", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    const emptyPath = manifestPath("empty.jsonl");
    await writeFile(emptyPath, "");
    await chmod(emptyPath, 0o600);

    await runCli(["--apply", `--manifest=${emptyPath}`]);

    expect(summary()).toMatchObject({ changed: 1, failed: 0 });
    expect(db.vehicleImage.updateMany).toHaveBeenCalled();

    vi.resetModules();
    resetDb();
    s3.calls.length = 0;
    consoleLog.mockClear();
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-2", s3Url(key))]);

    await runCli(["--apply", `--manifest=${manifestPath("missing.jsonl")}`]);

    expect(summary()).toMatchObject({ changed: 1, failed: 0 });
    expect(db.vehicleImage.updateMany).toHaveBeenCalled();
  });

  it("resumes apply against a valid v3 partial manifest without requiring prior destination values", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    const path = manifestPath();
    await writeSecureManifest(path, [vehicleManifestEntry()]);
    db.vehicleImage.findUnique.mockResolvedValue({
      url: s3Url(key),
      carId: "car",
      car: { ownerId: "owner" },
    });
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);

    await runCli(["--apply", `--manifest=${path}`]);

    expect(summary()).toMatchObject({ changed: 1, failed: 0, processed: 1 });
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(true);
    expect(db.vehicleImage.updateMany).toHaveBeenCalledWith({
      where: { id: "img-1", url: s3Url(key) },
      data: { url: `${PUBLIC_BASE}/owner/car/images/photo.webp` },
    });
    const written = await readFile(path, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    const lines = written.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => JSON.parse(line).version === 3)).toBe(true);
  });

  it("rejects apply against a nonempty manifest without a trailing newline before any fetch or write", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    const path = manifestPath();
    await writeFile(path, JSON.stringify(vehicleManifestEntry()));
    await chmod(path, 0o600);
    db.vehicleImage.findUnique.mockResolvedValue({
      url: s3Url(key),
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--apply", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is missing a trailing newline.");
    expect(s3.calls.length).toBe(0);
    expect(db.vehicleImage.findUnique).not.toHaveBeenCalled();
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not delete a public source while another DocumentApproval row still references it", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });
    db.documentApproval.findMany.mockResolvedValue([{ documentUrl: publicUrl(sourceKey) }]);

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({ SourceStillReferenced: 1 });
    expect(db.documentApproval.findMany).toHaveBeenCalledWith({
      where: { documentUrl: { contains: sourceKey } },
      select: { documentUrl: true },
    });
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("deletes a shared public source once after every referencing row has moved", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destA = "r2-migration/documents/doc-1.pdf";
    const destB = "r2-migration/documents/doc-2.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, destA, pdfBuffer(), "application/pdf");
    put(DOCS_BUCKET, destB, pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [
      r2ImagesManifestEntry(),
      r2ImagesManifestEntry({
        id: "doc-2",
        destinationKey: destB,
        destinationValue: destB,
      }),
    ]);
    db.documentApproval.findUnique.mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id;
      return id === "doc-2"
        ? { documentUrl: destB, userId: null, carId: "car", car: { ownerId: "owner" } }
        : { documentUrl: destA, userId: null, carId: "car", car: { ownerId: "owner" } };
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(s3.calls.filter((call) => call.command === "DeleteObjectCommand")).toEqual([
      expect.objectContaining({ bucket: IMAGES_BUCKET, key: sourceKey }),
    ]);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(false);
    expect(summary()).toMatchObject({ changed: 1, skipped: 1, failed: 0 });
  });

  it("does not delete a shared public source when another destination in the group is missing", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destA = "r2-migration/documents/doc-1.pdf";
    const destB = "r2-migration/documents/doc-2.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, destA, pdfBuffer(), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [
      r2ImagesManifestEntry(),
      r2ImagesManifestEntry({
        id: "doc-2",
        destinationKey: destB,
        destinationValue: destB,
      }),
    ]);
    db.documentApproval.findUnique.mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id;
      return id === "doc-2"
        ? { documentUrl: destB, userId: null, carId: "car", car: { ownerId: "owner" } }
        : { documentUrl: destA, userId: null, carId: "car", car: { ownerId: "owner" } };
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({
      DestinationObjectNotFound: 1,
      SourceGroupInvalid: 1,
    });
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(summary()).toMatchObject({ failed: 2, changed: 0 });
  });

  it("does not delete a shared public source when another destination in the group is corrupt", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destA = "r2-migration/documents/doc-1.pdf";
    const destB = "r2-migration/documents/doc-2.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, destA, pdfBuffer(), "application/pdf");
    put(DOCS_BUCKET, destB, pdfBuffer().subarray(0, 8), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [
      r2ImagesManifestEntry(),
      r2ImagesManifestEntry({
        id: "doc-2",
        destinationKey: destB,
        destinationValue: destB,
      }),
    ]);
    db.documentApproval.findUnique.mockImplementation(async (args) => {
      const id = (args as { where: { id: string } }).where.id;
      return id === "doc-2"
        ? { documentUrl: destB, userId: null, carId: "car", car: { ownerId: "owner" } }
        : { documentUrl: destA, userId: null, carId: "car", car: { ownerId: "owner" } };
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({
      DestinationIntegrityMismatch: 1,
      SourceGroupInvalid: 1,
    });
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(summary()).toMatchObject({ failed: 2, changed: 0 });
  });

  it.each([
    {
      label: "host casing",
      documentUrl: `https://${new URL(PUBLIC_BASE).hostname.toUpperCase()}/owner/car/documents/file.pdf`,
    },
    {
      label: "extra leading slashes",
      documentUrl: `${PUBLIC_BASE}//owner/car/documents/file.pdf`,
    },
  ])(
    "does not delete a public source when a live $label alias still resolves to it",
    async ({ documentUrl }) => {
      const sourceKey = "owner/car/documents/file.pdf";
      put(IMAGES_BUCKET, sourceKey, pdfBuffer());
      put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
      const path = manifestPath();
      await writeSecureManifest(path, [r2ImagesManifestEntry()]);
      db.documentApproval.findUnique.mockResolvedValue({
        documentUrl: "r2-migration/documents/doc-1.pdf",
        userId: null,
        carId: "car",
        car: { ownerId: "owner" },
      });
      db.documentApproval.findMany.mockResolvedValue([{ documentUrl }]);

      await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

      expect(failureCategories()).toEqual({ SourceStillReferenced: 1 });
      expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
      expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    },
  );

  it.each([
    {
      label: "wrong host",
      documentUrl: "https://pub-other.r2.dev/owner/car/documents/file.pdf",
    },
    {
      label: "nonmatching key",
      documentUrl: `${PUBLIC_BASE}/owner/car/documents/other.pdf`,
    },
  ])(
    "deletes a public source when a candidate $label does not resolve to it",
    async ({ documentUrl }) => {
      const sourceKey = "owner/car/documents/file.pdf";
      put(IMAGES_BUCKET, sourceKey, pdfBuffer());
      put(DOCS_BUCKET, "r2-migration/documents/doc-1.pdf", pdfBuffer(), "application/pdf");
      const path = manifestPath();
      await writeSecureManifest(path, [r2ImagesManifestEntry()]);
      db.documentApproval.findUnique.mockResolvedValue({
        documentUrl: "r2-migration/documents/doc-1.pdf",
        userId: null,
        carId: "car",
        car: { ownerId: "owner" },
      });
      db.documentApproval.findMany.mockResolvedValue([{ documentUrl }]);

      await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

      expect(s3.calls.filter((call) => call.command === "DeleteObjectCommand")).toEqual([
        expect.objectContaining({ bucket: IMAGES_BUCKET, key: sourceKey }),
      ]);
      expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(false);
      expect(summary()).toMatchObject({ changed: 1, failed: 0 });
    },
  );

  it("does not delete a public source when destination bytes were replaced but MIME matches", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destinationKey = "r2-migration/documents/doc-1.pdf";
    const original = pdfBuffer();
    const replaced = Buffer.alloc(original.byteLength, 0x41);
    replaced.write("%PDF-1.4", 0);
    put(IMAGES_BUCKET, sourceKey, original);
    put(DOCS_BUCKET, destinationKey, replaced, "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: destinationKey,
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({ DestinationIntegrityMismatch: 1 });
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
    expect(summary()).toMatchObject({ failed: 1, changed: 0 });
  });

  it("does not delete a public source when destination bytes are truncated but MIME matches", async () => {
    const sourceKey = "owner/car/documents/file.pdf";
    const destinationKey = "r2-migration/documents/doc-1.pdf";
    put(IMAGES_BUCKET, sourceKey, pdfBuffer());
    put(DOCS_BUCKET, destinationKey, pdfBuffer().subarray(0, 8), "application/pdf");
    const path = manifestPath();
    await writeSecureManifest(path, [r2ImagesManifestEntry()]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: destinationKey,
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--cleanup-public-sources", `--manifest=${path}`]);

    expect(failureCategories()).toEqual({ DestinationIntegrityMismatch: 1 });
    expect(s3.calls.some((call) => call.command === "DeleteObjectCommand")).toBe(false);
    expect(s3.objects.has(s3.id(IMAGES_BUCKET, sourceKey))).toBe(true);
  });

  it("rejects apply against a v2 manifest before any fetch or write", async () => {
    const key = "owner/car/images/photo.jpg";
    put(SOURCE_BUCKET, key, await raster("jpeg"));
    db.vehicleImage.findMany.mockResolvedValueOnce([imageRow("img-1", s3Url(key))]);
    const path = manifestPath();
    await writeSecureManifest(path, [vehicleManifestEntry({ version: 2 })]);

    await runCli(["--apply", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is invalid.");
    expect(s3.calls.some((call) => call.command === "GetObjectCommand")).toBe(false);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand")).toBe(false);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects rollback against a v2 manifest before any storage or DB mutation", async () => {
    const path = manifestPath();
    await writeSecureManifest(path, [vehicleManifestEntry({ version: 2 })]);
    db.vehicleImage.findUnique.mockResolvedValue({
      url: `${PUBLIC_BASE}/r2-migration/vehicle-images/img-1.webp`,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli(["--rollback", `--manifest=${path}`]);

    expect(configError()).toContain("Manifest is invalid.");
    expect(s3.calls.length).toBe(0);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    "--apply",
    "--relocate",
    "--rollback",
    "--cleanup-r2",
    "--cleanup-public-sources",
  ] as const)("rejects a symlink manifest for %s before storage or DB mutation", async (flag) => {
    const realPath = manifestPath("real.jsonl");
    await writeSecureManifest(realPath, [r2ImagesManifestEntry()]);
    const linkPath = manifestPath("link.jsonl");
    await symlink(realPath, linkPath);
    db.documentApproval.findMany.mockResolvedValueOnce([
      carDocRow("doc-1", publicUrl("owner/car/documents/file.pdf")),
    ]);
    db.documentApproval.findUnique.mockResolvedValue({
      documentUrl: "r2-migration/documents/doc-1.pdf",
      userId: null,
      carId: "car",
      car: { ownerId: "owner" },
    });

    await runCli([flag, `--manifest=${linkPath}`]);

    expect(configError()).toContain("Manifest path must not be a symlink.");
    expect(s3.calls.length).toBe(0);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    expect(db.documentApproval.findUnique).not.toHaveBeenCalled();
  });

  it.each(["--relocate", "--rollback", "--cleanup-r2", "--cleanup-public-sources"] as const)(
    "rejects a world-readable manifest for %s before storage or DB mutation",
    async (flag) => {
      const path = manifestPath();
      await writeFile(path, `${JSON.stringify(r2ImagesManifestEntry())}\n`);
      await chmod(path, 0o644);
      db.documentApproval.findUnique.mockResolvedValue({
        documentUrl: "r2-migration/documents/doc-1.pdf",
        userId: null,
        carId: "car",
        car: { ownerId: "owner" },
      });

      await runCli([flag, `--manifest=${path}`]);

      expect(configError()).toContain("Manifest permissions are unsafe.");
      expect(s3.calls.length).toBe(0);
      expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
      expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
      expect(db.documentApproval.findUnique).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-regular manifest path before storage or DB mutation", async () => {
    await runCli(["--rollback", `--manifest=${manifestDir}`]);

    expect(configError()).toContain("Manifest path is not a regular file.");
    expect(s3.calls.length).toBe(0);
    expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
    expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
  });

  it.each(["--relocate", "--rollback", "--cleanup-r2", "--cleanup-public-sources"] as const)(
    "fails %s when the manifest file is missing",
    async (flag) => {
      await runCli([flag, `--manifest=${manifestPath("missing.jsonl")}`]);

      expect(configError()).toContain("Manifest is missing.");
      expect(s3.calls.length).toBe(0);
      expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
      expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["--relocate", "--rollback", "--cleanup-r2", "--cleanup-public-sources"] as const)(
    "no-ops %s when the manifest file is empty",
    async (flag) => {
      const path = manifestPath();
      await writeFile(path, "");
      await chmod(path, 0o600);

      await runCli([flag, `--manifest=${path}`]);

      expect(summary()).toMatchObject({ discovered: 0, processed: 0, changed: 0, failed: 0 });
      expect(s3.calls.length).toBe(0);
      expect(db.vehicleImage.updateMany).not.toHaveBeenCalled();
      expect(db.documentApproval.updateMany).not.toHaveBeenCalled();
    },
  );
});
