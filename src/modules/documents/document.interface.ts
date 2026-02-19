import type { Readable } from "node:stream";

export interface ProxiedPdfResult {
  stream: Readable;
  fileName: string;
  contentType: string;
  contentLength?: number;
}
