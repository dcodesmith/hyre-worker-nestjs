import { basename } from "node:path";
import type { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import { AxiosError } from "axios";
import { DatabaseService } from "../database/database.service";
import { HttpClientService } from "../http-client/http-client.service";
import { StorageService } from "../storage/storage.service";
import type { ProxiedPdfResult } from "./document.interface";
import {
  DocumentFileFetchFailedException,
  DocumentFileNotFoundException,
  DocumentNotFoundException,
} from "./documents.error";

@Injectable()
export class DocumentProxyService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly httpClientService: HttpClientService,
    private readonly storageService: StorageService,
  ) {}

  async getPdfByDocumentId(documentId: string): Promise<ProxiedPdfResult> {
    const document = await this.databaseService.documentApproval.findUnique({
      where: { id: documentId },
      select: { documentUrl: true },
    });

    if (!document) {
      throw new DocumentNotFoundException();
    }

    if (this.isHttpUrl(document.documentUrl)) {
      return this.fetchHttpPdf(documentId, document.documentUrl);
    }

    return this.fetchStoredPdf(documentId, document.documentUrl);
  }

  private async fetchStoredPdf(documentId: string, key: string): Promise<ProxiedPdfResult> {
    try {
      const stored = await this.storageService.getObjectStream(key);
      return {
        stream: stored.stream,
        fileName: this.resolveFileName(documentId, key),
        contentType: this.resolveContentType(stored.contentType),
        contentLength: stored.contentLength,
      };
    } catch (error) {
      if (this.isMissingStoredObject(error)) {
        throw new DocumentFileNotFoundException();
      }

      throw new DocumentFileFetchFailedException();
    }
  }

  private async fetchHttpPdf(documentId: string, documentUrl: string): Promise<ProxiedPdfResult> {
    const httpClient = this.httpClientService.createClient({
      serviceName: "DocumentProxy",
      headers: {
        Accept: "application/pdf",
      },
    });

    try {
      const response = await httpClient.get<Readable>(documentUrl, {
        responseType: "stream",
      });

      return {
        stream: response.data,
        fileName: this.resolveFileName(documentId, documentUrl),
        contentType: this.resolveContentType(response.headers["content-type"]),
        contentLength: this.resolveContentLength(response.headers["content-length"]),
      };
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        throw new DocumentFileNotFoundException();
      }

      throw new DocumentFileFetchFailedException();
    }
  }

  private isHttpUrl(value: string): boolean {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  private isMissingStoredObject(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === "NoSuchKey" || error.name === "NotFound";
  }

  private resolveFileName(documentId: string, sourceUrl: string): string {
    try {
      const pathName = this.isHttpUrl(sourceUrl) ? new URL(sourceUrl).pathname : sourceUrl;
      const fileName = basename(pathName);
      if (fileName?.toLowerCase().endsWith(".pdf")) {
        return fileName;
      }
    } catch {
      // Fall through to default name
    }

    return `document-${documentId}.pdf`;
  }

  private resolveContentType(contentTypeHeader: unknown): string {
    if (typeof contentTypeHeader === "string" && contentTypeHeader.length > 0) {
      return contentTypeHeader;
    }
    return "application/pdf";
  }

  private resolveContentLength(contentLengthHeader: unknown): number | undefined {
    if (typeof contentLengthHeader === "number") {
      return Number.isFinite(contentLengthHeader) ? contentLengthHeader : undefined;
    }
    if (typeof contentLengthHeader !== "string") {
      return undefined;
    }

    const parsedValue = Number.parseInt(contentLengthHeader, 10);
    return Number.isNaN(parsedValue) ? undefined : parsedValue;
  }
}
