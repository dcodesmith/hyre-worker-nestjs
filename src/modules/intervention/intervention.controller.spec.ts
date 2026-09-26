import type { Readable } from "node:stream";
import { GUARDS_METADATA, HEADERS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { VerificationInterventionStatus } from "@prisma/client";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { ADMIN, STAFF } from "../auth/auth.const";
import { AuthService } from "../auth/auth.service";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { InterventionController } from "./intervention.controller";
import { InterventionService } from "./intervention.service";

const INTERVENTION_ID = "018f47a2-7b3c-7d4e-8f90-1234567894c1";

describe("InterventionController", () => {
  let controller: InterventionController;
  let interventionService: {
    list: ReturnType<typeof vi.fn>;
    getLicenseNumber: ReturnType<typeof vi.fn>;
    getSelfie: ReturnType<typeof vi.fn>;
    getNinPortrait: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
    approveOwnerLicenseDocument: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    interventionService = {
      list: vi.fn().mockResolvedValue({ items: [], meta: {} }),
      getLicenseNumber: vi.fn().mockResolvedValue("ABC12345DE67"),
      getSelfie: vi.fn(),
      getNinPortrait: vi.fn().mockResolvedValue(Buffer.from("portrait")),
      approve: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      approveOwnerLicenseDocument: vi.fn().mockResolvedValue(undefined),
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

  it("marks list and licence reveal responses as private and not stored", () => {
    const reflector = new Reflector();
    expect(reflector.get(HEADERS_METADATA, controller.list)).toEqual([
      { name: "Cache-Control", value: "private, no-store" },
    ]);
    expect(reflector.get(HEADERS_METADATA, controller.licenseNumber)).toEqual([
      { name: "Cache-Control", value: "private, no-store" },
    ]);
  });

  it("lists interventions with the parsed query", async () => {
    const query = { status: VerificationInterventionStatus.OPEN, page: 1, limit: 20 };

    await expect(controller.list(query)).resolves.toEqual({ items: [], meta: {} });
    expect(interventionService.list).toHaveBeenCalledWith(query);
  });

  it("returns only the revealed licence number", async () => {
    await expect(controller.licenseNumber(INTERVENTION_ID)).resolves.toEqual({
      licenseNumber: "ABC12345DE67",
    });
  });

  it("streams the selfie with no-store headers", async () => {
    const stream = { pipe: vi.fn() } as unknown as Readable;
    interventionService.getSelfie.mockResolvedValueOnce({
      stream,
      contentType: "image/webp",
      contentLength: 8,
    });
    const response = { setHeader: vi.fn(), end: vi.fn() } as unknown as Response;

    await controller.selfie(INTERVENTION_ID, response);

    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/webp");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Length", "8");
    expect(stream.pipe).toHaveBeenCalledWith(response);
  });

  it("returns the NIN portrait as a jpeg that is not stored", async () => {
    const response = { setHeader: vi.fn(), end: vi.fn() } as unknown as Response;

    await controller.ninPortrait(INTERVENTION_ID, response);

    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/jpeg");
    expect(response.end).toHaveBeenCalledWith(Buffer.from("portrait"));
  });

  it("approves and rejects with the signed-in reviewer", async () => {
    const user = { id: "admin-1" } as never;
    const approval = {
      notes: "Checked FRSC",
      source: "FRSC",
      authoritativeSourceAttested: true,
    };

    await expect(controller.approve(INTERVENTION_ID, approval, user)).resolves.toEqual({
      success: true,
    });
    await expect(
      controller.reject(INTERVENTION_ID, { notes: "Not a match" }, user),
    ).resolves.toEqual({ success: true });
    expect(interventionService.approve).toHaveBeenCalledWith(INTERVENTION_ID, "admin-1", approval);
    expect(interventionService.reject).toHaveBeenCalledWith(
      INTERVENTION_ID,
      "admin-1",
      "Not a match",
    );
  });

  it("approves the linked owner document for the signed-in reviewer", async () => {
    const user = { id: "admin-1" } as never;

    await expect(controller.approveOwnerLicenseDocument(INTERVENTION_ID, user)).resolves.toEqual({
      success: true,
    });
    expect(interventionService.approveOwnerLicenseDocument).toHaveBeenCalledWith(
      INTERVENTION_ID,
      "admin-1",
    );
  });
});
