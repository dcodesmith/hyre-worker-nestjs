import "dotenv/config";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
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
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png", "webp"]);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

type Mode = "apply" | "cleanup-public-sources" | "cleanup-r2" | "dry-run" | "relocate" | "rollback";
const MODE_FLAGS = [
  "--apply",
  "--rollback",
  "--relocate",
  "--cleanup-r2",
  "--cleanup-public-sources",
] as const;
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

const MANIFEST_VERSION = 3;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type AssetRecord = {
  table: AssetTable;
  id: string;
  sourceValue: string;
  ownerId?: string | null;
  carId?: string | null;
  userId?: string | null;
};

type BindingFields = {
  ownerId: string | null;
  carId: string | null;
  userId: string | null;
};

type ManifestEntry = BindingFields & {
  version: typeof MANIFEST_VERSION;
  table: AssetTable;
  id: string;
  sourceValue: string;
  sourceStore: "r2" | "r2-images" | "s3";
  sourceKey: string;
  destinationBucket: string;
  destinationKey: string;
  destinationValue: string;
  destinationDigest: string;
  destinationSize: number;
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
        "Usage: pnpm assets:migrate:development [--apply|--relocate|--rollback|--cleanup-r2|--cleanup-public-sources]",
        "       [--manifest=/path/to/manifest.jsonl]",
        "",
        "No mode flag performs a read-only dry run.",
        "Order: --apply, verify private destinations, then --cleanup-public-sources.",
        "--apply uploads to R2 and conditionally rewrites legacy rows. Public image-bucket document sources are kept for rollback.",
        "--relocate copies existing destinations onto the live upload key layout and rewrites DB values.",
        "--rollback restores DB values after confirming each source object still exists.",
        "After --cleanup-public-sources, r2-images rollback fails closed and does not restore public URLs.",
        "--cleanup-r2 deletes only destination objects no longer referenced by their row.",
        "--cleanup-public-sources deletes only verified public r2-images sources. This is irreversible.",
      ].join("\n"),
    );
    process.exit(0);
  }

  const modeFlags = args.filter((arg) => (MODE_FLAGS as readonly string[]).includes(arg));
  if (modeFlags.length > 1) {
    throw new ConfigurationError(
      "Choose only one of --apply, --relocate, --rollback, --cleanup-r2, or --cleanup-public-sources.",
    );
  }
  const unknown = args.filter(
    (arg) => !(MODE_FLAGS as readonly string[]).includes(arg) && !arg.startsWith("--manifest="),
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

function sourceHostPattern(bucket: string): RegExp {
  return new RegExp(`^${bucket.replaceAll(".", "\\.")}\\.s3(?:\\.[a-z0-9-]+)?\\.amazonaws\\.com$`);
}

function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment);
}

function isDecodedSafePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("://") &&
    !value.includes("%") &&
    value.split("/").every(isSafeSegment)
  );
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function hasExactHttpsHost(sourceValue: string, hostname: string): boolean {
  try {
    const sourceUrl = new URL(sourceValue);
    return (
      sourceUrl.protocol === "https:" &&
      sourceUrl.hostname === hostname &&
      !sourceUrl.username &&
      !sourceUrl.password &&
      !sourceUrl.port &&
      !sourceUrl.search &&
      !sourceUrl.hash
    );
  } catch {
    return false;
  }
}

function isExactHostLegacyS3Url(sourceValue: string, config: Config): boolean {
  try {
    const sourceUrl = new URL(sourceValue);
    return (
      sourceUrl.protocol === "https:" &&
      sourceHostPattern(config.sourceBucket).test(sourceUrl.hostname) &&
      !sourceUrl.username &&
      !sourceUrl.password &&
      !sourceUrl.port &&
      !sourceUrl.search &&
      !sourceUrl.hash
    );
  } catch {
    return false;
  }
}

function isExactHostPublicAssetUrl(sourceValue: string, config: Config): boolean {
  try {
    return hasExactHttpsHost(sourceValue, new URL(config.publicBaseUrl).hostname);
  } catch {
    return false;
  }
}

function extractPublicAssetKey(sourceValue: string, config: Config): string {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceValue);
  } catch {
    throw new MigrationItemError("InvalidLegacyKey");
  }
  if (!isExactHostPublicAssetUrl(sourceValue, config)) {
    throw new MigrationItemError("InvalidLegacyKey");
  }
  const key = sourceUrl.pathname.replace(/^\/+/, "");
  if (!isDecodedSafePath(key)) throw new MigrationItemError("InvalidLegacyKey");
  return key;
}

function isExactHostPublicDocumentUrl(sourceValue: string, config: Config): boolean {
  if (!isExactHostPublicAssetUrl(sourceValue, config)) return false;
  try {
    const key = new URL(sourceValue).pathname.replace(/^\/+/, "");
    return (
      isSafeDocumentKey(key) && DOCUMENT_EXTENSIONS.has(fileExtension(key.split("/").at(-1) ?? ""))
    );
  } catch {
    return false;
  }
}

function resolvedPublicDocumentSourceKey(sourceValue: string, config: Config): string | undefined {
  if (!isExactHostPublicDocumentUrl(sourceValue, config)) return undefined;
  try {
    return extractPublicAssetKey(sourceValue, config);
  } catch {
    return undefined;
  }
}

function extractLegacyS3Key(sourceValue: string, config: Config): string {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceValue);
  } catch {
    throw new MigrationItemError("InvalidLegacyS3Url");
  }
  if (
    sourceUrl.protocol !== "https:" ||
    !sourceHostPattern(config.sourceBucket).test(sourceUrl.hostname) ||
    sourceUrl.username ||
    sourceUrl.password ||
    sourceUrl.port ||
    sourceUrl.search ||
    sourceUrl.hash
  ) {
    throw new MigrationItemError("InvalidLegacyS3Url");
  }
  const key = sourceUrl.pathname.replace(/^\/+/, "");
  if (!isDecodedSafePath(key)) throw new MigrationItemError("InvalidLegacyKey");
  return key;
}

function isSafeStorageKey(value: string, marker: "/documents/" | "/images/"): boolean {
  return value.includes(marker) && isDecodedSafePath(value);
}

function isSafeDocumentKey(value: string): boolean {
  return isSafeStorageKey(value, "/documents/");
}

function isStructurallyValidVehicleImageKey(key: string): boolean {
  const parts = key.split("/");
  if (!IMAGE_EXTENSIONS.has(fileExtension(parts.at(-1) ?? ""))) return false;
  return (
    parts.length === 2 || (parts.length === 4 && parts[2] === "images" && isDecodedSafePath(key))
  );
}

function isStructurallyValidDocumentS3Key(key: string): boolean {
  const parts = key.split("/");
  if (!DOCUMENT_EXTENSIONS.has(fileExtension(parts.at(-1) ?? ""))) return false;
  return parts.length === 2 || isSafeStorageKey(key, "/documents/");
}

function unsupportedOrInvalidKey(
  key: string,
  allowed: Set<string>,
): "InvalidLegacyKey" | "UnsupportedLegacyExtension" {
  return allowed.has(fileExtension(key.split("/").at(-1) ?? ""))
    ? "InvalidLegacyKey"
    : "UnsupportedLegacyExtension";
}

function legacyCliDestinationKeys(table: AssetTable, id: string): string[] {
  if (table === "VehicleImage") {
    return [
      `r2-migration/vehicle-images/${id}.webp`,
      `r2-migration/vehicle-images/${id}-copy.webp`,
    ];
  }
  return [".pdf", ".webp"].flatMap((extension) => [
    `r2-migration/documents/${id}${extension}`,
    `r2-migration/documents/${id}-copy${extension}`,
  ]);
}

function isLegacyCliDestinationKey(record: Pick<AssetRecord, "table" | "id">, key: string) {
  return legacyCliDestinationKeys(record.table, record.id).includes(key);
}

function replaceExtension(name: string, ext: "pdf" | "webp"): string {
  return `${name.replace(/\.[^./]+$/, "")}.${ext}`;
}

function withCopySuffix(key: string): string {
  return key.replace(/(\.[^./]+)$/, "-copy$1");
}

function liveDestinationKey(
  record: Pick<AssetRecord, "table" | "ownerId" | "carId" | "userId">,
  sourceKey: string,
  ext: "pdf" | "webp",
): string {
  const parts = sourceKey.split("/");
  const file = parts.at(-1);
  if (!file) throw new MigrationItemError("InvalidLegacyKey");
  const renamed = replaceExtension(file, ext);

  if (parts.includes("documents") || parts.includes("images")) {
    return [...parts.slice(0, -1), renamed].join("/");
  }

  if (
    record.table === "VehicleImage" &&
    record.ownerId &&
    record.carId &&
    parts.length === 2 &&
    parts[0] === record.ownerId &&
    (parts[1]?.startsWith(`${record.carId}-`) ?? false)
  ) {
    return `${record.ownerId}/${record.carId}/images/${replaceExtension(
      parts[1].slice(record.carId.length + 1),
      ext,
    )}`;
  }

  if (
    record.table === "DocumentApproval" &&
    record.ownerId &&
    record.carId &&
    !record.userId &&
    parts.length === 2 &&
    parts[0] === record.ownerId &&
    (parts[1]?.startsWith(`${record.carId}-`) ?? false)
  ) {
    return `${record.ownerId}/${record.carId}/documents/${replaceExtension(
      parts[1].slice(record.carId.length + 1),
      ext,
    )}`;
  }

  if (
    record.table === "DocumentApproval" &&
    record.userId &&
    !record.carId &&
    parts.length === 2 &&
    parts[0] === record.userId
  ) {
    return `${record.userId}/documents/${renamed}`;
  }

  throw new MigrationItemError("InvalidLegacyKey");
}

function destinationExtension(key: string): "pdf" | "webp" {
  return fileExtension(key) === "pdf" ? "pdf" : "webp";
}

function isAllowedDestinationKey(entry: ManifestEntry): boolean {
  if (legacyCliDestinationKeys(entry.table, entry.id).includes(entry.destinationKey)) {
    return true;
  }
  try {
    const live = liveDestinationKey(
      entry,
      entry.sourceKey,
      destinationExtension(entry.destinationKey),
    );
    return entry.destinationKey === live || entry.destinationKey === withCopySuffix(live);
  } catch {
    return false;
  }
}

function recordSourceKey(record: AssetRecord, config: Config): string {
  if (record.table === "DocumentApproval" && isSafeDocumentKey(record.sourceValue)) {
    return record.sourceValue;
  }
  if (
    record.table === "DocumentApproval" &&
    isExactHostPublicDocumentUrl(record.sourceValue, config)
  ) {
    const key = extractPublicAssetKey(record.sourceValue, config);
    if (!isStructurallyValidDocumentS3Key(key)) {
      throw new MigrationItemError(unsupportedOrInvalidKey(key, DOCUMENT_EXTENSIONS));
    }
    return key;
  }
  const key = extractLegacyS3Key(record.sourceValue, config);
  if (record.table === "VehicleImage") {
    if (!isStructurallyValidVehicleImageKey(key)) {
      throw new MigrationItemError(unsupportedOrInvalidKey(key, IMAGE_EXTENSIONS));
    }
    return key;
  }
  if (!isStructurallyValidDocumentS3Key(key)) {
    throw new MigrationItemError(unsupportedOrInvalidKey(key, DOCUMENT_EXTENSIONS));
  }
  return key;
}

function bindingOf(record: Pick<AssetRecord, "ownerId" | "carId" | "userId">): BindingFields {
  return {
    ownerId: record.ownerId ?? null,
    carId: record.carId ?? null,
    userId: record.userId ?? null,
  };
}

function sameBinding(left: BindingFields, right: BindingFields): boolean {
  return (
    left.ownerId === right.ownerId && left.carId === right.carId && left.userId === right.userId
  );
}

function assertBoundLegacyKey(record: AssetRecord, key: string): void {
  if (!isDecodedSafePath(key)) throw new MigrationItemError("InvalidLegacyKey");
  if (isLegacyCliDestinationKey(record, key)) return;
  const parts = key.split("/");
  if (record.table === "VehicleImage") {
    if (!record.ownerId || !record.carId) throw new MigrationItemError("LegacyKeyOwnerMismatch");
    const boundDepth2 =
      parts.length === 2 &&
      parts[0] === record.ownerId &&
      (parts[1]?.startsWith(`${record.carId}-`) ?? false);
    const boundCanonical =
      parts.length === 4 &&
      parts[0] === record.ownerId &&
      parts[1] === record.carId &&
      parts[2] === "images";
    if (!boundDepth2 && !boundCanonical) throw new MigrationItemError("LegacyKeyOwnerMismatch");
    return;
  }
  if (record.userId && !record.carId) {
    if (parts[0] !== record.userId) throw new MigrationItemError("LegacyKeyOwnerMismatch");
    return;
  }
  if (record.carId && record.ownerId && !record.userId) {
    const boundDepth2 =
      parts.length === 2 &&
      parts[0] === record.ownerId &&
      (parts[1]?.startsWith(`${record.carId}-`) ?? false);
    const boundCanonical =
      parts.length === 4 &&
      parts[0] === record.ownerId &&
      parts[1] === record.carId &&
      parts[2] === "documents";
    if (!boundDepth2 && !boundCanonical) throw new MigrationItemError("LegacyKeyOwnerMismatch");
    return;
  }
  throw new MigrationItemError("LegacyKeyOwnerMismatch");
}

function isEligibleDocumentValue(value: string, config: Config): boolean {
  return (
    isSafeDocumentKey(value) ||
    isExactHostLegacyS3Url(value, config) ||
    isExactHostPublicDocumentUrl(value, config)
  );
}

async function loadLegacyRecords(database: PrismaClient, config: Config): Promise<AssetRecord[]> {
  const [images, documents] = await Promise.all([
    database.vehicleImage.findMany({
      where: { url: { contains: ".amazonaws.com" } },
      select: { id: true, url: true, carId: true, car: { select: { ownerId: true } } },
      orderBy: { id: "asc" },
    }),
    database.documentApproval.findMany({
      where: {
        OR: [
          { documentUrl: { contains: ".amazonaws.com" } },
          { documentUrl: { contains: "/documents/" } },
        ],
      },
      select: {
        id: true,
        documentUrl: true,
        userId: true,
        carId: true,
        car: { select: { ownerId: true } },
      },
      orderBy: { id: "asc" },
    }),
  ]);
  return [
    ...images.map(({ id, url, carId, car }) => ({
      table: "VehicleImage" as const,
      id,
      sourceValue: url,
      ownerId: car.ownerId,
      carId,
      userId: null,
    })),
    ...documents
      .filter(({ documentUrl }) => isEligibleDocumentValue(documentUrl, config))
      .map(({ id, documentUrl, userId, carId, car }) => ({
        table: "DocumentApproval" as const,
        id,
        sourceValue: documentUrl,
        ownerId: car?.ownerId ?? null,
        carId,
        userId,
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

async function headObject(client: S3Client, bucket: string, key: string) {
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { contentType: response.ContentType };
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw error;
  }
}

function expectedDestinationContentType(destinationKey: string): string {
  return fileExtension(destinationKey) === "pdf" ? "application/pdf" : "image/webp";
}

function destinationProof(body: Buffer): { destinationDigest: string; destinationSize: number } {
  return {
    destinationDigest: createHash("sha256").update(body).digest("hex"),
    destinationSize: body.byteLength,
  };
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function inspectManifestFile(
  path: string,
  allowMissing: boolean,
): Promise<"empty" | "missing" | "ready"> {
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(path);
  } catch (error) {
    if (isEnoent(error)) {
      if (allowMissing) return "missing";
      throw new ConfigurationError("Manifest is missing.");
    }
    throw new ConfigurationError("Manifest path is not readable.");
  }
  if (fileStat.isSymbolicLink()) {
    throw new ConfigurationError("Manifest path must not be a symlink.");
  }
  if (!fileStat.isFile()) {
    throw new ConfigurationError("Manifest path is not a regular file.");
  }
  if ((fileStat.mode & 0o777) !== 0o600) {
    throw new ConfigurationError("Manifest permissions are unsafe.");
  }
  return fileStat.size === 0 ? "empty" : "ready";
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

function classifyItemError(error: unknown): string {
  if (error instanceof MigrationItemError) return error.name;
  const message = error instanceof Error ? error.message : "";
  if (/pixel limit|limitInputPixels|exceeded pixel/i.test(message)) {
    return "SourceImagePixelLimit";
  }
  if (
    /corrupt|unrecognised|unrecognized|unsupported image|input buffer|vipsjpeg|vipswebp|vipspng|pngcrc|invalid/i.test(
      message,
    )
  ) {
    return "SourceImageDecodeError";
  }
  return errorName(error);
}

async function fetchSource(record: AssetRecord, config: Config) {
  const key = recordSourceKey(record, config);
  assertBoundLegacyKey(record, key);
  if (
    record.table === "DocumentApproval" &&
    isExactHostPublicDocumentUrl(record.sourceValue, config)
  ) {
    const imagesBuffer = await fetchObject(config.destinationClient, config.imagesBucket, key);
    if (!imagesBuffer) throw new MigrationItemError("SourceObjectNotFound");
    return { key, buffer: imagesBuffer, sourceStore: "r2-images" as const };
  }
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

  const destinationKey = liveDestinationKey(record, source.key, documentPdf ? "pdf" : "webp");
  let prepared: Awaited<ReturnType<typeof prepareStorageObject>>;
  try {
    prepared = await prepareStorageObject(
      source.buffer,
      destinationKey,
      documentPdf ? "application/pdf" : "image/jpeg",
    );
  } catch (error) {
    throw new MigrationItemError(classifyItemError(error));
  }
  const destinationBucket =
    record.table === "VehicleImage" ? config.imagesBucket : config.docsBucket;
  const destinationValue =
    record.table === "VehicleImage" ? `${config.publicBaseUrl}/${prepared.key}` : prepared.key;

  return {
    entry: {
      version: MANIFEST_VERSION,
      table: record.table,
      id: record.id,
      sourceValue: record.sourceValue,
      ...bindingOf(record),
      sourceStore: source.sourceStore,
      sourceKey: source.key,
      destinationBucket,
      destinationKey: prepared.key,
      destinationValue,
      ...destinationProof(prepared.buffer),
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

function emptySummary(discovered: number): Summary {
  return { discovered, processed: 0, changed: 0, skipped: 0, failed: 0 };
}

async function preflightApplyManifest(
  path: string,
  config: Config,
  database: PrismaClient,
): Promise<void> {
  const status = await inspectManifestFile(path, true);
  if (status === "ready") await readManifest(path, config, database);
}

async function migrate(
  database: PrismaClient,
  config: Config,
  mode: "apply" | "dry-run",
): Promise<Summary> {
  if (mode === "apply") {
    await preflightApplyManifest(config.manifestPath, config, database);
  }
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
      console.error(`${record.table} item ${index + 1} failed (${classifyItemError(error)}).`);
    }
  }
  return summary;
}

function isBindingId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === MANIFEST_VERSION &&
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
    isBindingId(entry.ownerId) &&
    isBindingId(entry.carId) &&
    isBindingId(entry.userId) &&
    typeof entry.destinationDigest === "string" &&
    SHA256_HEX.test(entry.destinationDigest) &&
    typeof entry.destinationSize === "number" &&
    Number.isInteger(entry.destinationSize) &&
    entry.destinationSize > 0 &&
    (entry.sourceStore === "r2" || entry.sourceStore === "r2-images" || entry.sourceStore === "s3")
  );
}

function isAllowedManifestSourceStore(entry: ManifestEntry, config: Config): boolean {
  if (entry.sourceStore === "r2") {
    return entry.table === "DocumentApproval" && isSafeDocumentKey(entry.sourceValue);
  }
  if (entry.sourceStore === "r2-images") {
    return (
      entry.table === "DocumentApproval" && isExactHostPublicDocumentUrl(entry.sourceValue, config)
    );
  }
  return (
    isExactHostLegacyS3Url(entry.sourceValue, config) ||
    (entry.table === "DocumentApproval" && isSafeDocumentKey(entry.sourceValue))
  );
}

async function loadCurrentBinding(
  database: PrismaClient,
  table: AssetTable,
  id: string,
): Promise<BindingFields> {
  if (table === "VehicleImage") {
    const row = await database.vehicleImage.findUnique({
      where: { id },
      select: { carId: true, car: { select: { ownerId: true } } },
    });
    if (!row?.carId || !row.car?.ownerId) {
      throw new ConfigurationError("Manifest row is missing current ownership relationships.");
    }
    return { ownerId: row.car.ownerId, carId: row.carId, userId: null };
  }
  const row = await database.documentApproval.findUnique({
    where: { id },
    select: { userId: true, carId: true, car: { select: { ownerId: true } } },
  });
  if (!row) {
    throw new ConfigurationError("Manifest row is missing current ownership relationships.");
  }
  return {
    ownerId: row.car?.ownerId ?? null,
    carId: row.carId,
    userId: row.userId,
  };
}

async function readManifest(
  path: string,
  config: Config,
  database: PrismaClient,
  includeDestinationHistory = false,
): Promise<ManifestEntry[]> {
  const contents = await readFile(path, "utf8");
  if (contents.length > 0 && !contents.endsWith("\n")) {
    throw new ConfigurationError("Manifest is missing a trailing newline.");
  }
  const entries = contents
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new ConfigurationError("Manifest is invalid.");
      }
    });
  if (!entries.every(isManifestEntry)) throw new ConfigurationError("Manifest is invalid.");

  const unique = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    const expectedBucket = entry.table === "VehicleImage" ? config.imagesBucket : config.docsBucket;
    const expectedSourceKey = recordSourceKey(entry, config);
    const expectedDestinationValue =
      entry.table === "VehicleImage"
        ? `${config.publicBaseUrl}/${entry.destinationKey}`
        : entry.destinationKey;
    if (
      entry.destinationBucket !== expectedBucket ||
      entry.sourceKey !== expectedSourceKey ||
      !isAllowedManifestSourceStore(entry, config) ||
      !isAllowedDestinationKey(entry) ||
      entry.destinationValue !== expectedDestinationValue
    ) {
      throw new ConfigurationError("Manifest entry does not match the development migration.");
    }
    const currentBinding = await loadCurrentBinding(database, entry.table, entry.id);
    if (!sameBinding(bindingOf(entry), currentBinding)) {
      throw new ConfigurationError("Manifest binding does not match current row relationships.");
    }
    try {
      assertBoundLegacyKey(
        {
          table: entry.table,
          id: entry.id,
          sourceValue: entry.sourceValue,
          ...currentBinding,
        },
        entry.sourceKey,
      );
    } catch (error) {
      if (error instanceof MigrationItemError) {
        throw new ConfigurationError(
          "Manifest source key is not bound to current row relationships.",
        );
      }
      throw error;
    }
    const rowKey = `${entry.table}:${entry.id}`;
    const key = includeDestinationHistory
      ? `${rowKey}:${entry.destinationBucket}:${entry.destinationKey}`
      : rowKey;
    unique.set(key, entry);
  }
  return [...unique.values()];
}

async function relocate(
  database: PrismaClient,
  config: Config,
  entries: ManifestEntry[],
): Promise<Summary> {
  const summary = emptySummary(entries.length);
  for (const [index, entry] of entries.entries()) {
    try {
      const nextKey = liveDestinationKey(
        entry,
        entry.sourceKey,
        destinationExtension(entry.destinationKey),
      );
      const nextValue =
        entry.table === "VehicleImage" ? `${config.publicBaseUrl}/${nextKey}` : nextKey;
      if (nextKey === entry.destinationKey) {
        summary.skipped += 1;
        summary.processed += 1;
        continue;
      }
      const relocatedEntry = {
        ...entry,
        destinationKey: nextKey,
        destinationValue: nextValue,
      };

      const body = await fetchObject(
        config.destinationClient,
        entry.destinationBucket,
        entry.destinationKey,
      );
      if (!body) throw new MigrationItemError("SourceObjectNotFound");
      if (
        body.byteLength !== entry.destinationSize ||
        createHash("sha256").update(body).digest("hex") !== entry.destinationDigest
      ) {
        throw new MigrationItemError("DestinationIntegrityMismatch");
      }

      const existing = await fetchObject(
        config.destinationClient,
        entry.destinationBucket,
        nextKey,
      );
      if (existing) {
        if (createHash("sha256").update(existing).digest("hex") !== entry.destinationDigest) {
          throw new MigrationItemError("DestinationIntegrityMismatch");
        }
      } else {
        await config.destinationClient.send(
          new PutObjectCommand({
            Bucket: entry.destinationBucket,
            Key: nextKey,
            Body: body,
            ContentType: expectedDestinationContentType(nextKey),
            ...(entry.table === "VehicleImage"
              ? { CacheControl: "public, max-age=31536000, immutable" }
              : {}),
          }),
        );
      }

      const changed = await replaceValue(database, entry, entry.destinationValue, nextValue);
      if (changed === 0) {
        const current = await currentValue(database, entry);
        if (current !== nextValue) throw new MigrationItemError("ConcurrentRowChange");
        await appendManifest(config.manifestPath, relocatedEntry);
        summary.skipped += 1;
      } else {
        await appendManifest(config.manifestPath, relocatedEntry);
        summary.changed += 1;
      }
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`${entry.table} item ${index + 1} failed (${classifyItemError(error)}).`);
    }
  }
  return summary;
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
          entry.sourceStore === "s3" ? config.sourceClient : config.destinationClient;
        const sourceBucket =
          entry.sourceStore === "r2-images"
            ? config.imagesBucket
            : entry.sourceStore === "r2"
              ? config.docsBucket
              : config.sourceBucket;
        if (!(await headObject(sourceClient, sourceBucket, entry.sourceKey))) {
          throw new MigrationItemError("SourceObjectNotFound");
        }
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
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const key = `${entry.destinationBucket}:${entry.destinationKey}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    try {
      const referenced = (
        await Promise.all(group.map((entry) => currentValue(database, entry)))
      ).some((value, index) => value === group[index]?.destinationValue);
      if (referenced) {
        summary.skipped += group.length;
      } else {
        const destination = group[0];
        if (!destination) continue;
        await config.destinationClient.send(
          new DeleteObjectCommand({
            Bucket: destination.destinationBucket,
            Key: destination.destinationKey,
          }),
        );
        summary.changed += 1;
        summary.skipped += group.length - 1;
      }
      summary.processed += group.length;
    } catch (error) {
      recordGroupOutcome(group, summary, error);
    }
  }
  return summary;
}

async function assertPrivateDestination(config: Config, entry: ManifestEntry): Promise<void> {
  const destination = await headObject(
    config.destinationClient,
    config.docsBucket,
    entry.destinationKey,
  );
  if (!destination) throw new MigrationItemError("DestinationObjectNotFound");
  if (destination.contentType !== expectedDestinationContentType(entry.destinationKey)) {
    throw new MigrationItemError("DestinationContentTypeMismatch");
  }
  const destinationBody = await fetchObject(
    config.destinationClient,
    config.docsBucket,
    entry.destinationKey,
  );
  if (!destinationBody) throw new MigrationItemError("DestinationObjectNotFound");
  const proof = destinationProof(destinationBody);
  if (
    proof.destinationSize !== entry.destinationSize ||
    proof.destinationDigest !== entry.destinationDigest
  ) {
    throw new MigrationItemError("DestinationIntegrityMismatch");
  }
}

async function assertCleanupEntryReady(
  database: PrismaClient,
  config: Config,
  entry: ManifestEntry,
): Promise<void> {
  const currentBinding = await loadCurrentBinding(database, entry.table, entry.id);
  if (!sameBinding(bindingOf(entry), currentBinding)) {
    throw new MigrationItemError("BindingMismatch");
  }
  assertBoundLegacyKey(
    {
      table: entry.table,
      id: entry.id,
      sourceValue: entry.sourceValue,
      ...currentBinding,
    },
    entry.sourceKey,
  );
  if ((await currentValue(database, entry)) !== entry.destinationValue) {
    throw new MigrationItemError("DestinationNotInUse");
  }
  await assertPrivateDestination(config, entry);
}

async function hasLivePublicSourceReference(
  database: PrismaClient,
  config: Config,
  sourceKey: string,
): Promise<boolean> {
  const candidates = await database.documentApproval.findMany({
    where: { documentUrl: { contains: sourceKey } },
    select: { documentUrl: true },
  });
  return candidates.some(
    (row) => resolvedPublicDocumentSourceKey(row.documentUrl, config) === sourceKey,
  );
}

function recordGroupOutcome(group: ManifestEntry[], summary: Summary, error: unknown): void {
  for (const entry of group) {
    summary.failed += 1;
    summary.processed += 1;
    console.error(`${entry.table} item failed (${classifyItemError(error)}).`);
  }
}

async function cleanupPublicSourceGroup(
  database: PrismaClient,
  config: Config,
  group: ManifestEntry[],
  summary: Summary,
): Promise<void> {
  const failures = new Map<string, unknown>();
  for (const entry of group) {
    try {
      await assertCleanupEntryReady(database, config, entry);
    } catch (error) {
      failures.set(entry.id, error);
    }
  }
  if (failures.size > 0) {
    for (const entry of group) {
      summary.failed += 1;
      summary.processed += 1;
      const error = failures.get(entry.id) ?? new MigrationItemError("SourceGroupInvalid");
      console.error(`${entry.table} item failed (${classifyItemError(error)}).`);
    }
    return;
  }
  const representative = group[0];
  if (!representative) return;
  try {
    if (await hasLivePublicSourceReference(database, config, representative.sourceKey)) {
      throw new MigrationItemError("SourceStillReferenced");
    }
    const source = await headObject(
      config.destinationClient,
      config.imagesBucket,
      representative.sourceKey,
    );
    if (!source) {
      summary.skipped += group.length;
      summary.processed += group.length;
      return;
    }
    await config.destinationClient.send(
      new DeleteObjectCommand({
        Bucket: config.imagesBucket,
        Key: representative.sourceKey,
      }),
    );
    summary.changed += 1;
    summary.skipped += group.length - 1;
    summary.processed += group.length;
  } catch (error) {
    recordGroupOutcome(group, summary, error);
  }
}

async function cleanupPublicSources(
  database: PrismaClient,
  config: Config,
  entries: ManifestEntry[],
): Promise<Summary> {
  const summary = emptySummary(entries.length);
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    if (entry.sourceStore !== "r2-images" || entry.table !== "DocumentApproval") {
      summary.skipped += 1;
      summary.processed += 1;
      continue;
    }
    const groupKey = `${config.imagesBucket}:${entry.sourceKey}`;
    const group = groups.get(groupKey) ?? [];
    group.push(entry);
    groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    await cleanupPublicSourceGroup(database, config, group, summary);
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
      const status = await inspectManifestFile(config.manifestPath, false);
      const entries =
        status === "empty"
          ? []
          : await readManifest(config.manifestPath, config, database, mode === "cleanup-r2");
      summary =
        mode === "rollback"
          ? await rollback(database, config, entries)
          : mode === "relocate"
            ? await relocate(database, config, entries)
            : mode === "cleanup-r2"
              ? await cleanupR2(database, config, entries)
              : await cleanupPublicSources(database, config, entries);
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
      manifest:
        mode === "dry-run"
          ? "not-written"
          : mode === "apply" || mode === "relocate"
            ? "updated"
            : "read",
    }),
  );
  if (mode === "cleanup-public-sources") {
    console.error("Public image-bucket sources removed by this mode cannot be rolled back.");
  }
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
