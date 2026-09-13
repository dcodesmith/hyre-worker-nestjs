import "dotenv/config";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { MAX_IMAGE_PIXELS, prepareStorageObject } from "../modules/storage/storage.service";

const EXPECTED_IMAGES_BUCKET = "hyre-assets-images-development";
const EXPECTED_DOCS_BUCKET = "hyre-assets-docs-development";
const EXPECTED_PUBLIC_BASE_URL = "https://pub-7f459f6039f54e9b896f12bc832985f5.r2.dev";
const EXPECTED_DATABASE_HOSTNAME = "ep-red-water-a53rrmcm-pooler.us-east-2.aws.neon.tech";
const DEFAULT_MANIFEST = resolve("tmp/r2-development-assets.jsonl");
const PDF_HEADER = Buffer.from("%PDF-");

type Mode = "apply" | "cleanup-r2" | "dry-run" | "rollback";
type AssetTable = "DocumentApproval" | "VehicleImage";

type Config = {
  databaseUrl: string;
  sourceBucket: string;
  sourceRegion: string;
  publicBaseUrl: string;
  imagesBucket: string;
  docsBucket: string;
  manifestPath: string;
  sourceClient: S3Client;
  destinationClient: S3Client;
};

type AssetRecord = {
  table: AssetTable;
  id: string;
  sourceValue: string;
};

type ManifestEntry = AssetRecord & {
  version: 1;
  sourceStore: "r2" | "s3";
  sourceKey: string;
  destinationBucket: string;
  destinationKey: string;
  destinationValue: string;
};

type Summary = {
  discovered: number;
  processed: number;
  changed: number;
  skipped: number;
  failed: number;
};

class ConfigurationError extends Error {}
class MigrationItemError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`${name} is required.`);
  return value;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseArguments(): { mode: Mode; manifestPath: string } {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--help")) {
    console.log(
      [
        "Usage: pnpm assets:migrate:development [--apply|--rollback|--cleanup-r2]",
        "       [--manifest=/path/to/manifest.jsonl]",
        "",
        "No mode flag performs a read-only dry run.",
        "--apply uploads to R2 and conditionally rewrites legacy S3 rows.",
        "--rollback restores DB values after confirming each source object still exists.",
        "--cleanup-r2 deletes only destination objects no longer referenced by their row.",
      ].join("\n"),
    );
    process.exit(0);
  }

  const modeFlags = args.filter((arg) => ["--apply", "--cleanup-r2", "--rollback"].includes(arg));
  if (modeFlags.length > 1) {
    throw new ConfigurationError("Choose only one of --apply, --rollback, or --cleanup-r2.");
  }
  const unknown = args.filter(
    (arg) =>
      !["--apply", "--cleanup-r2", "--rollback"].includes(arg) && !arg.startsWith("--manifest="),
  );
  if (unknown.length > 0) throw new ConfigurationError(`Unknown argument: ${unknown[0]}`);

  const manifestArgument = args.find((arg) => arg.startsWith("--manifest="));
  const manifestPath = manifestArgument?.slice("--manifest=".length);
  if (manifestArgument && !manifestPath) {
    throw new ConfigurationError("--manifest requires a path.");
  }

  return {
    mode: (modeFlags[0]?.slice(2) as Mode | undefined) ?? "dry-run",
    manifestPath: manifestPath ? resolve(manifestPath) : DEFAULT_MANIFEST,
  };
}

function loadConfig(manifestPath: string): Config {
  if (requiredEnv("APP_ENV") !== "development") {
    throw new ConfigurationError("Asset migration is restricted to APP_ENV=development.");
  }
  if (requiredEnv("STORAGE_DRIVER") !== "r2") {
    throw new ConfigurationError("STORAGE_DRIVER must be r2.");
  }

  const imagesBucket = requiredEnv("R2_IMAGES_BUCKET_NAME");
  const docsBucket = requiredEnv("R2_DOCS_BUCKET_NAME");
  const publicBaseUrl = withoutTrailingSlash(requiredEnv("ASSET_PUBLIC_BASE_URL"));
  if (
    imagesBucket !== EXPECTED_IMAGES_BUCKET ||
    docsBucket !== EXPECTED_DOCS_BUCKET ||
    publicBaseUrl !== EXPECTED_PUBLIC_BASE_URL
  ) {
    throw new ConfigurationError("R2 development bucket or public-host configuration is invalid.");
  }

  const sourceRegion = requiredEnv("AWS_REGION");
  const sourceBucket = requiredEnv("AWS_BUCKET_NAME");
  const databaseUrl = requiredEnv("DATABASE_URL");
  try {
    if (new URL(databaseUrl).hostname !== EXPECTED_DATABASE_HOSTNAME) {
      throw new ConfigurationError(
        "DATABASE_URL must target the approved Neon development endpoint.",
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("DATABASE_URL must be a valid URL.");
  }

  return {
    databaseUrl,
    sourceBucket,
    sourceRegion,
    publicBaseUrl,
    imagesBucket,
    docsBucket,
    manifestPath,
    sourceClient: new S3Client({
      region: sourceRegion,
      credentials: {
        accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY"),
      },
    }),
    destinationClient: new S3Client({
      region: "auto",
      endpoint: `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
      },
    }),
  };
}

function createDatabase(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

function legacyS3UrlKey(sourceValue: string, config: Config): string {
  const sourceUrl = new URL(sourceValue);
  const hostPattern = new RegExp(
    `^${config.sourceBucket.replaceAll(".", "\\.")}\\.s3(?:\\.[a-z0-9-]+)?\\.amazonaws\\.com$`,
  );
  const key = sourceUrl.pathname.replace(/^\/+/, "");
  if (
    sourceUrl.protocol !== "https:" ||
    !hostPattern.test(sourceUrl.hostname) ||
    sourceUrl.username ||
    sourceUrl.password ||
    sourceUrl.port ||
    sourceUrl.search ||
    sourceUrl.hash ||
    (!isSafeStorageKey(key, "/documents/") && !isSafeStorageKey(key, "/images/"))
  ) {
    throw new MigrationItemError("InvalidLegacyS3Url");
  }
  return key;
}

function isSafeStorageKey(value: string, marker: "/documents/" | "/images/"): boolean {
  if (
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("://") ||
    !value.includes(marker)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(segment),
    );
}

function isSafeDocumentKey(value: string): boolean {
  return isSafeStorageKey(value, "/documents/");
}

function recordSourceKey(record: AssetRecord, config: Config): string {
  if (record.table === "DocumentApproval" && isSafeDocumentKey(record.sourceValue)) {
    return record.sourceValue;
  }
  const key = legacyS3UrlKey(record.sourceValue, config);
  const safeForRecord =
    record.table === "DocumentApproval"
      ? isSafeDocumentKey(key)
      : isSafeStorageKey(key, "/images/");
  if (!safeForRecord) throw new MigrationItemError("InvalidLegacyS3Url");
  return key;
}

function isEligibleDocumentValue(value: string, config: Config): boolean {
  if (isSafeDocumentKey(value)) return true;
  try {
    return isSafeDocumentKey(legacyS3UrlKey(value, config));
  } catch {
    return false;
  }
}

async function loadLegacyRecords(database: PrismaClient, config: Config): Promise<AssetRecord[]> {
  const [images, documents] = await Promise.all([
    database.vehicleImage.findMany({
      where: { url: { contains: ".amazonaws.com" } },
      select: { id: true, url: true },
      orderBy: { id: "asc" },
    }),
    database.documentApproval.findMany({
      where: {
        OR: [
          { documentUrl: { contains: ".amazonaws.com" } },
          { documentUrl: { contains: "/documents/" } },
        ],
      },
      select: { id: true, documentUrl: true },
      orderBy: { id: "asc" },
    }),
  ]);
  return [
    ...images.map(({ id, url }) => ({ table: "VehicleImage" as const, id, sourceValue: url })),
    ...documents
      .filter(({ documentUrl }) => isEligibleDocumentValue(documentUrl, config))
      .map(({ id, documentUrl }) => ({
        table: "DocumentApproval" as const,
        id,
        sourceValue: documentUrl,
      })),
  ];
}

function isMissingObject(error: unknown): boolean {
  if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
  );
}

async function fetchObject(client: S3Client, bucket: string, key: string) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new MigrationItemError("MissingSourceBody");
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw error;
  }
}

async function fetchSource(record: AssetRecord, config: Config) {
  const key = recordSourceKey(record, config);
  if (record.table === "DocumentApproval" && isSafeDocumentKey(record.sourceValue)) {
    const r2Buffer = await fetchObject(config.destinationClient, config.docsBucket, key);
    if (r2Buffer) return { key, buffer: r2Buffer, sourceStore: "r2" as const };
  }

  const s3Buffer = await fetchObject(config.sourceClient, config.sourceBucket, key);
  if (!s3Buffer) throw new MigrationItemError("SourceObjectNotFound");
  return { key, buffer: s3Buffer, sourceStore: "s3" as const };
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).indexOf(PDF_HEADER) >= 0;
}

async function isCanonicalPrivateWebp(key: string, buffer: Buffer): Promise<boolean> {
  if (
    !key.toLowerCase().endsWith(".webp") ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP" ||
    buffer.subarray(12, 16).toString("ascii") !== "VP8L"
  ) {
    return false;
  }
  const metadata = await sharp(buffer, {
    failOn: "error",
    limitInputPixels: MAX_IMAGE_PIXELS,
  }).metadata();
  return metadata.format === "webp";
}

async function prepareEntry(
  record: AssetRecord,
  config: Config,
): Promise<
  | {
      entry: ManifestEntry;
      body: Buffer;
      contentType: string;
      cacheControl?: string;
    }
  | undefined
> {
  const source = await fetchSource(record, config);
  const documentPdf = record.table === "DocumentApproval" && isPdf(source.buffer);
  if (
    record.table === "DocumentApproval" &&
    source.sourceStore === "r2" &&
    (documentPdf || (await isCanonicalPrivateWebp(source.key, source.buffer)))
  ) {
    return undefined;
  }

  const defaultDestinationKey =
    record.table === "VehicleImage"
      ? `r2-migration/vehicle-images/${record.id}.webp`
      : `r2-migration/documents/${record.id}.${documentPdf ? "pdf" : "webp"}`;
  const requestedKey =
    source.key === defaultDestinationKey
      ? defaultDestinationKey.replace(/\.[^./]+$/, `-copy.${documentPdf ? "pdf" : "source"}`)
      : defaultDestinationKey.replace(/\.webp$/, ".source");
  const prepared = await prepareStorageObject(
    source.buffer,
    requestedKey,
    documentPdf ? "application/pdf" : "image/jpeg",
  );
  const destinationBucket =
    record.table === "VehicleImage" ? config.imagesBucket : config.docsBucket;
  const destinationValue =
    record.table === "VehicleImage" ? `${config.publicBaseUrl}/${prepared.key}` : prepared.key;

  return {
    entry: {
      version: 1,
      ...record,
      sourceStore: source.sourceStore,
      sourceKey: source.key,
      destinationBucket,
      destinationKey: prepared.key,
      destinationValue,
    },
    body: prepared.buffer,
    contentType: prepared.contentType,
    cacheControl: prepared.cacheControl,
  };
}

async function appendManifest(path: string, entry: ManifestEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a", 0o600);
  try {
    await file.chmod(0o600);
    await file.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function currentValue(database: PrismaClient, entry: ManifestEntry) {
  if (entry.table === "VehicleImage") {
    return (
      await database.vehicleImage.findUnique({
        where: { id: entry.id },
        select: { url: true },
      })
    )?.url;
  }
  return (
    await database.documentApproval.findUnique({
      where: { id: entry.id },
      select: { documentUrl: true },
    })
  )?.documentUrl;
}

async function replaceValue(
  database: PrismaClient,
  entry: ManifestEntry,
  expected: string,
  replacement: string,
): Promise<number> {
  if (entry.table === "VehicleImage") {
    return (
      await database.vehicleImage.updateMany({
        where: { id: entry.id, url: expected },
        data: { url: replacement },
      })
    ).count;
  }
  return (
    await database.documentApproval.updateMany({
      where: { id: entry.id, documentUrl: expected },
      data: { documentUrl: replacement },
    })
  ).count;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

function emptySummary(discovered: number): Summary {
  return { discovered, processed: 0, changed: 0, skipped: 0, failed: 0 };
}

async function migrate(
  database: PrismaClient,
  config: Config,
  mode: "apply" | "dry-run",
): Promise<Summary> {
  const records = await loadLegacyRecords(database, config);
  const summary = emptySummary(records.length);

  for (const [index, record] of records.entries()) {
    try {
      const prepared = await prepareEntry(record, config);
      if (!prepared) {
        summary.processed += 1;
        summary.skipped += 1;
        continue;
      }
      if (mode === "apply") {
        await config.destinationClient.send(
          new PutObjectCommand({
            Bucket: prepared.entry.destinationBucket,
            Key: prepared.entry.destinationKey,
            Body: prepared.body,
            ContentType: prepared.contentType,
            ...(prepared.cacheControl ? { CacheControl: prepared.cacheControl } : {}),
          }),
        );
        await appendManifest(config.manifestPath, prepared.entry);
        const changed = await replaceValue(
          database,
          prepared.entry,
          prepared.entry.sourceValue,
          prepared.entry.destinationValue,
        );
        if (changed === 0) {
          const current = await currentValue(database, prepared.entry);
          if (current !== prepared.entry.destinationValue) {
            throw new MigrationItemError("ConcurrentRowChange");
          }
          summary.skipped += 1;
        } else {
          summary.changed += 1;
        }
      } else {
        summary.skipped += 1;
      }
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`${record.table} item ${index + 1} failed (${errorName(error)}).`);
    }
  }
  return summary;
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === 1 &&
    (entry.table === "VehicleImage" || entry.table === "DocumentApproval") &&
    [
      "id",
      "sourceValue",
      "sourceStore",
      "sourceKey",
      "destinationBucket",
      "destinationKey",
      "destinationValue",
    ].every((key) => typeof entry[key] === "string" && entry[key].length > 0) &&
    (entry.sourceStore === "r2" || entry.sourceStore === "s3")
  );
}

async function readManifest(path: string, config: Config): Promise<ManifestEntry[]> {
  const contents = await readFile(path, "utf8");
  const entries = contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  if (!entries.every(isManifestEntry)) throw new ConfigurationError("Manifest is invalid.");

  const unique = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    const expectedBucket = entry.table === "VehicleImage" ? config.imagesBucket : config.docsBucket;
    const expectedSourceKey = recordSourceKey(entry, config);
    const expectedDestinationKeys =
      entry.table === "VehicleImage"
        ? [
            `r2-migration/vehicle-images/${entry.id}.webp`,
            `r2-migration/vehicle-images/${entry.id}-copy.webp`,
          ]
        : [".pdf", ".webp"].flatMap((extension) => [
            `r2-migration/documents/${entry.id}${extension}`,
            `r2-migration/documents/${entry.id}-copy${extension}`,
          ]);
    const expectedDestinationValue =
      entry.table === "VehicleImage"
        ? `${config.publicBaseUrl}/${entry.destinationKey}`
        : entry.destinationKey;
    if (
      entry.destinationBucket !== expectedBucket ||
      entry.sourceKey !== expectedSourceKey ||
      (entry.sourceStore === "r2" &&
        (entry.table !== "DocumentApproval" || !isSafeDocumentKey(entry.sourceValue))) ||
      !expectedDestinationKeys.includes(entry.destinationKey) ||
      entry.destinationValue !== expectedDestinationValue
    ) {
      throw new ConfigurationError("Manifest entry does not match the development migration.");
    }
    unique.set(`${entry.table}:${entry.id}`, entry);
  }
  return [...unique.values()];
}

async function rollback(
  database: PrismaClient,
  config: Config,
  entries: ManifestEntry[],
): Promise<Summary> {
  const summary = emptySummary(entries.length);
  for (const [index, entry] of entries.entries()) {
    try {
      const current = await currentValue(database, entry);
      if (current === entry.sourceValue) {
        summary.skipped += 1;
      } else if (current === entry.destinationValue) {
        const sourceClient =
          entry.sourceStore === "r2" ? config.destinationClient : config.sourceClient;
        const sourceBucket = entry.sourceStore === "r2" ? config.docsBucket : config.sourceBucket;
        await sourceClient.send(
          new HeadObjectCommand({ Bucket: sourceBucket, Key: entry.sourceKey }),
        );
        const changed = await replaceValue(
          database,
          entry,
          entry.destinationValue,
          entry.sourceValue,
        );
        if (changed === 0 && (await currentValue(database, entry)) !== entry.sourceValue) {
          throw new MigrationItemError("ConcurrentRowChange");
        }
        summary.changed += changed;
        summary.skipped += changed === 0 ? 1 : 0;
      } else {
        throw new MigrationItemError("ConcurrentRowChange");
      }
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`${entry.table} item ${index + 1} failed (${errorName(error)}).`);
    }
  }
  return summary;
}

async function cleanupR2(
  database: PrismaClient,
  config: Config,
  entries: ManifestEntry[],
): Promise<Summary> {
  const summary = emptySummary(entries.length);
  for (const [index, entry] of entries.entries()) {
    try {
      if ((await currentValue(database, entry)) === entry.destinationValue) {
        summary.skipped += 1;
      } else {
        await config.destinationClient.send(
          new DeleteObjectCommand({
            Bucket: entry.destinationBucket,
            Key: entry.destinationKey,
          }),
        );
        summary.changed += 1;
      }
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`${entry.table} item ${index + 1} failed (${errorName(error)}).`);
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { mode, manifestPath } = parseArguments();
  const config = loadConfig(manifestPath);
  const database = createDatabase(config.databaseUrl);
  let summary: Summary;
  try {
    await database.$connect();
    if (mode === "apply" || mode === "dry-run") {
      summary = await migrate(database, config, mode);
    } else {
      const entries = await readManifest(config.manifestPath, config);
      summary =
        mode === "rollback"
          ? await rollback(database, config, entries)
          : await cleanupR2(database, config, entries);
    }
  } finally {
    await database.$disconnect();
    config.sourceClient.destroy();
    config.destinationClient.destroy();
  }

  console.log(
    JSON.stringify({
      mode,
      ...summary,
      durationMs: Date.now() - startedAt,
      manifest: mode === "dry-run" ? "not-written" : mode === "apply" ? "updated" : "read",
    }),
  );
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
  } else {
    console.error(`Asset migration failed (${errorName(error)}).`);
  }
  process.exitCode = 1;
});
