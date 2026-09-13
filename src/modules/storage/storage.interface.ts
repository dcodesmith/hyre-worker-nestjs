import type { Readable } from "node:stream";

export interface StoredObjectStream {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
}

export interface StoredObject {
  key: string;
  url: string;
}

export interface PreparedStorageObject {
  buffer: Buffer;
  key: string;
  contentType: string;
  cacheControl?: string;
}
