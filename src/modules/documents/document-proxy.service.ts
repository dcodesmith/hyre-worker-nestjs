import { basename } from "node:path";
import type { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import { AxiosError } from "axios";
import { DatabaseService } from "../database/database.service";
import { HttpClientService } from "../http-client/http-client.service";
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
  ) {}

  async getPdfByDocumentId(documentId: string): Promise<ProxiedPdfResult> {
    const document = await this.databaseService.documentApproval.findUnique({
      where: { id: documentId },
      select: { documentUrl: true },
    });

    if (!document) {
      throw new DocumentNotFoundException();
    }

    const httpClient = this.httpClientService.createClient({
      serviceName: "DocumentProxy",
      headers: {
        Accept: "application/pdf",
      },
    });

    try {
      const response = await httpClient.get<Readable>(document.documentUrl, {
        responseType: "stream",
      });

      return {
        stream: response.data,
        fileName: this.resolveFileName(documentId, document.documentUrl),
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

  private resolveFileName(documentId: string, sourceUrl: string): string {
    try {
      const url = new URL(sourceUrl);
      const fileName = basename(url.pathname);
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
