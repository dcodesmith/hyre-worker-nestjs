import { Readable } from "node:stream";
import { Test, type TestingModule } from "@nestjs/testing";
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { HttpClientService } from "../http-client/http-client.service";
import { StorageService } from "../storage/storage.service";
import { DocumentProxyService } from "./document-proxy.service";
import {
  DocumentFileFetchFailedException,
  DocumentFileNotFoundException,
  DocumentNotFoundException,
} from "./documents.error";

interface MockDocumentApprovalData {
  documentUrl: string;
}

function createMockDocumentApprovalData(
  overrides: Partial<MockDocumentApprovalData> = {},
): MockDocumentApprovalData {
  return {
    documentUrl: "https://example.com/files/sample.pdf",
    ...overrides,
  };
}

describe("DocumentProxyService", () => {
  let service: DocumentProxyService;
  let httpClientService: HttpClientService;

  const documentApprovalMock = {
    findUnique: vi.fn(),
  };

  const httpClientMock = {
    get: vi.fn(),
  };
  const storageServiceMock = {
    getObjectStream: vi.fn(),
  };

  beforeEach(async () => {
    documentApprovalMock.findUnique.mockReset();
    httpClientMock.get.mockReset();
    storageServiceMock.getObjectStream.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentProxyService,
        {
          provide: DatabaseService,
          useValue: {
            documentApproval: documentApprovalMock,
          },
        },
        {
          provide: HttpClientService,
          useValue: {
            createClient: vi.fn().mockReturnValue(httpClientMock),
          },
        },
        {
          provide: StorageService,
          useValue: storageServiceMock,
        },
      ],
    }).compile();

    service = module.get<DocumentProxyService>(DocumentProxyService);
    httpClientService = module.get<HttpClientService>(HttpClientService);
  });

  it("throws not found when document record does not exist", async () => {
    vi.mocked(documentApprovalMock.findUnique).mockResolvedValue(null);

    await expect(service.getPdfByDocumentId("missing-doc")).rejects.toThrow(
      DocumentNotFoundException,
    );
  });

  it("returns stream metadata when file exists", async () => {
    vi.mocked(documentApprovalMock.findUnique).mockResolvedValue(createMockDocumentApprovalData());

    const stream = Readable.from(Buffer.from("%PDF-1.4"));
    vi.mocked(httpClientMock.get).mockResolvedValue({
      data: stream,
      headers: {
        "content-type": "application/pdf",
        "content-length": "8",
      },
    });

    const result = await service.getPdfByDocumentId("doc-1");

    expect(httpClientService.createClient).toHaveBeenCalled();
    expect(result.fileName).toBe("sample.pdf");
    expect(result.contentType).toBe("application/pdf");
    expect(result.contentLength).toBe(8);
    expect(result.stream).toBe(stream);
  });

  it("throws not found when upstream file is missing", async () => {
    vi.mocked(documentApprovalMock.findUnique).mockResolvedValue(
      createMockDocumentApprovalData({
        documentUrl: "https://example.com/files/missing.pdf",
      }),
    );

    vi.mocked(httpClientMock.get).mockRejectedValue(
      new AxiosError("Not Found", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 404,
        statusText: "Not Found",
        headers: {},
        config: {} as never,
        data: {},
      }),
    );

    await expect(service.getPdfByDocumentId("doc-1")).rejects.toThrow(
      DocumentFileNotFoundException,
    );
  });

  it("throws bad gateway when upstream fetch fails unexpectedly", async () => {
    vi.mocked(documentApprovalMock.findUnique).mockResolvedValue(createMockDocumentApprovalData());

    vi.mocked(httpClientMock.get).mockRejectedValue(new Error("network failure"));

    await expect(service.getPdfByDocumentId("doc-1")).rejects.toThrow(
      DocumentFileFetchFailedException,
    );
  });

  it("streams a stored object key from storage", async () => {
    const stream = Readable.from(Buffer.from("%PDF-1.4"));
    vi.mocked(documentApprovalMock.findUnique).mockResolvedValue(
      createMockDocumentApprovalData({
        documentUrl: "owner/car/documents/178-mot.pdf",
      }),
    );
    storageServiceMock.getObjectStream.mockResolvedValue({
      stream,
      contentType: "application/pdf",
      contentLength: 8,
    });

    const result = await service.getPdfByDocumentId("doc-1");

    expect(httpClientService.createClient).not.toHaveBeenCalled();
    expect(storageServiceMock.getObjectStream).toHaveBeenCalledWith(
      "owner/car/documents/178-mot.pdf",
    );
    expect(result.fileName).toBe("178-mot.pdf");
    expect(result.contentType).toBe("application/pdf");
    expect(result.contentLength).toBe(8);
    expect(result.stream).toBe(stream);
  });

  it("throws not found when the stored object is missing", async () => {
    vi.mocked(documentApprovalMock.findUnique).mockResolvedValue(
      createMockDocumentApprovalData({
        documentUrl: "owner/car/documents/missing.pdf",
      }),
    );
    const missing = new Error("The specified key does not exist.");
    missing.name = "NoSuchKey";
    storageServiceMock.getObjectStream.mockRejectedValue(missing);

    await expect(service.getPdfByDocumentId("doc-1")).rejects.toThrow(
      DocumentFileNotFoundException,
    );
  });
});
