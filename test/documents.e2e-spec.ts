import { createServer, type Server } from "node:http";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Documents E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let userCookie: string;
  let localPdfServer: Server;
  let localPdfUrl: string;
  const pdfBody = Buffer.from("%PDF-1.4 test");

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();

    const adminAuth = await factory.createAuthenticatedAdmin(uniqueEmail("doc-admin"));
    adminCookie = adminAuth.cookie;

    const userAuth = await factory.authenticateAndGetUser(uniqueEmail("doc-user"), "user");
    userCookie = userAuth.cookie;

    await new Promise<void>((resolve) => {
      localPdfServer = createServer((_, res) => {
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Length": pdfBody.length.toString(),
        });
        res.end(pdfBody);
      });
      localPdfServer.listen(0, "127.0.0.1", () => {
        const address = localPdfServer.address();
        if (address && typeof address !== "string") {
          localPdfUrl = `http://127.0.0.1:${address.port}/sample.pdf`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      localPdfServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("GET /api/proxy-pdf/:documentId blocks non-admin users", async () => {
    const document = await databaseService.documentApproval.create({
      data: {
        documentType: "NIN",
        documentUrl: localPdfUrl,
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/proxy-pdf/${document.id}`)
      .set("Cookie", userCookie);

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("GET /api/proxy-pdf/:documentId streams PDF for admins", async () => {
    const document = await databaseService.documentApproval.create({
      data: {
        documentType: "DRIVERS_LICENSE",
        documentUrl: localPdfUrl,
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/proxy-pdf/${document.id}`)
      .set("Cookie", adminCookie)
      .buffer(true);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain("inline; filename=");
    expect(Buffer.compare(Buffer.from(response.body), pdfBody)).toBe(0);
  });
});
