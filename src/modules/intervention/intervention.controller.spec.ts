import { PassThrough, Readable } from "node:stream";
import { type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA, HEADERS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { ADMIN, type RoleName, STAFF, USER } from "../auth/auth.const";
import { AuthForbiddenException } from "../auth/auth.error";
import { AuthService } from "../auth/auth.service";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import { AUTH_SESSION_KEY, SessionGuard } from "../auth/guards/session.guard";
import { InterventionController } from "./intervention.controller";
import { InterventionService } from "./intervention.service";

const INTERVENTION_ID = "018f47a2-7b3c-7d4e-8f90-1234567894c1";

describe("InterventionController", () => {
  let controller: InterventionController;
  let interventionService: {
    getSelfie: ReturnType<typeof vi.fn>;
    getNinPortrait: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    interventionService = {
      getSelfie: vi.fn(),
      getNinPortrait: vi.fn().mockResolvedValue(Buffer.from("portrait")),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InterventionController],
      providers: [
        { provide: InterventionService, useValue: interventionService },
        {
          provide: AuthService,
          useValue: {
            isInitialized: true,
            auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
            getUserRoles: vi.fn().mockResolvedValue([ADMIN]),
          },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();
    controller = module.get(InterventionController);
  });

  it("allows only an authenticated admin or staff session", () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, InterventionController)).toEqual([
      SessionGuard,
      RoleGuard,
    ]);
    expect(reflector.get(ROLES_KEY, InterventionController)).toEqual([ADMIN, STAFF]);
  });

  it("lets admin or staff approve and reject every intervention", () => {
    const guard = new RoleGuard(new Reflector());
    const contextFor = (handler: (...args: never[]) => unknown, roles: RoleName[]) =>
      ({
        getHandler: () => handler,
        getClass: () => InterventionController,
        switchToHttp: () => ({
          getRequest: () => ({
            [AUTH_SESSION_KEY]: { user: { roles } },
          }),
        }),
      }) as unknown as ExecutionContext;
    const handlers = [
      InterventionController.prototype.approve,
      InterventionController.prototype.reject,
      InterventionController.prototype.approveOwnerLicenseDocument,
    ];

    for (const handler of handlers) {
      expect(guard.canActivate(contextFor(handler, [STAFF]))).toBe(true);
      expect(guard.canActivate(contextFor(handler, [ADMIN]))).toBe(true);
      expect(() => guard.canActivate(contextFor(handler, [USER]))).toThrow(AuthForbiddenException);
    }
  });

  it("marks list and licence reveal responses as private and not stored", () => {
    const reflector = new Reflector();
    expect(reflector.get(HEADERS_METADATA, controller.list)).toEqual([
      { name: "Cache-Control", value: "private, no-store" },
    ]);
    expect(reflector.get(HEADERS_METADATA, controller.get)).toEqual([
      { name: "Cache-Control", value: "private, no-store" },
    ]);
    expect(reflector.get(HEADERS_METADATA, controller.licenseNumber)).toEqual([
      { name: "Cache-Control", value: "private, no-store" },
    ]);
  });

  function selfieResponse() {
    const response = new PassThrough() as PassThrough & {
      setHeader: ReturnType<typeof vi.fn>;
      status: ReturnType<typeof vi.fn>;
      headersSent: boolean;
    };
    response.setHeader = vi.fn();
    response.headersSent = false;
    response.status = vi.fn(() => response);
    return response;
  }

  it("streams the selfie with no-store headers", async () => {
    const stream = Readable.from(Buffer.from("selfie"));
    interventionService.getSelfie.mockResolvedValueOnce({
      stream,
      contentType: "image/webp",
      contentLength: 8,
    });
    const response = selfieResponse();
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    await controller.selfie(INTERVENTION_ID, response as unknown as Response);

    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/webp");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Length", "8");
    expect(Buffer.concat(chunks)).toEqual(Buffer.from("selfie"));
  });

  it("destroys the selfie response when the evidence stream fails", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const stream = new Readable({
      read() {
        this.destroy(new Error("storage unavailable"));
      },
    });
    interventionService.getSelfie.mockResolvedValueOnce({
      stream,
      contentType: "image/webp",
      contentLength: 8,
    });
    const response = selfieResponse();

    try {
      await controller.selfie(INTERVENTION_ID, response as unknown as Response);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
    expect(response.destroyed).toBe(true);
    expect(response.writableEnded).toBe(false);
  });

  it("returns the NIN portrait as a jpeg that is not stored", async () => {
    const response = { setHeader: vi.fn(), end: vi.fn() } as unknown as Response;

    await controller.ninPortrait(INTERVENTION_ID, response);

    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/jpeg");
    expect(response.end).toHaveBeenCalledWith(Buffer.from("portrait"));
  });
});
