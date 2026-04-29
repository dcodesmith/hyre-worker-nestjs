import type { Readable } from "node:stream";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { AuthService } from "../auth/auth.service";
import { DocumentProxyService } from "./document-proxy.service";
import { DocumentsController } from "./documents.controller";

describe("DocumentsController", () => {
  let controller: DocumentsController;
  let documentProxyService: DocumentProxyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [
        {
          provide: DocumentProxyService,
          useValue: {
            getPdfByDocumentId: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: {
              api: {
                getSession: vi.fn().mockResolvedValue(null),
              },
            },
            getUserRoles: vi.fn().mockResolvedValue(["admin"]),
          },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<DocumentsController>(DocumentsController);
    documentProxyService = module.get<DocumentProxyService>(DocumentProxyService);
  });

  it("delegates to proxy service and pipes the stream", async () => {
    const stream = {
      on: vi.fn(),
      pipe: vi.fn(),
    };
    vi.mocked(documentProxyService.getPdfByDocumentId).mockResolvedValue({
      stream: stream as unknown as Readable,
      fileName: "sample.pdf",
      contentType: "application/pdf",
      contentLength: 8,
    });

    const response = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      end: vi.fn(),
      headersSent: false,
    };

    await controller.proxyPdf("doc-1", response as unknown as Response);

    expect(documentProxyService.getPdfByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(stream.pipe).toHaveBeenCalledWith(response);

    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      expect.stringContaining("sample.pdf"),
    );
  });

  it("escapes filename content before writing Content-Disposition header", async () => {
    const stream = {
      on: vi.fn(),
      pipe: vi.fn(),
    };
    vi.mocked(documentProxyService.getPdfByDocumentId).mockResolvedValue({
      stream: stream as unknown as Readable,
      fileName: 'report\\final"2026\r\n.pdf',
      contentType: "application/pdf",
      contentLength: undefined,
    });

    const response = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      end: vi.fn(),
      headersSent: false,
    };

    await controller.proxyPdf("doc-1", response as unknown as Response);

    const escapedFileName = String.raw`report\\final\"2026.pdf`;
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      `inline; filename="${escapedFileName}"`,
    );
  });
});
