import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { DocumentStatus, DocumentType } from "@prisma/client";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { FLEET_OWNER } from "../auth/auth.const";
import { AuthService } from "../auth/auth.service";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RoleGuard } from "../auth/guards/role.guard";
import { SessionGuard } from "../auth/guards/session.guard";
import { VerifiedFleetOwnerGuard } from "../auth/guards/verified-fleet-owner.guard";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { AccountVerificationController } from "./account-verification.controller";
import type {
  AccountIdentityVerificationDto,
  CreateAccountVerificationDto,
  DrivingCredentialsDto,
  PayoutVerificationDto,
  UploadedAccountDocument,
} from "./account-verification.dto";
import { AccountVerificationService } from "./account-verification.service";
import { PhoneVerificationService } from "./phone-verification.service";
import { VerificationRequestInProgressException } from "./verification.error";
import {
  VERIFICATION_THROTTLE_CONFIG,
  VerificationThrottlerGuard,
} from "./verification-throttler.guard";

describe("AccountVerificationController", () => {
  let controller: AccountVerificationController;
  let accountVerificationService: {
    replaceRejectedDriversLicense: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    verifyIdentityStage: ReturnType<typeof vi.fn>;
    verifyPayoutStage: ReturnType<typeof vi.fn>;
    saveDrivingCredentialsStage: ReturnType<typeof vi.fn>;
    submitStage: ReturnType<typeof vi.fn>;
  };

  const mockUser = {
    id: "owner-1",
    name: "Fleet Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["fleetOwner" as const],
  };
  const idempotencyKey = "account-key-1";
  const identityBody: AccountIdentityVerificationDto = {
    accountType: "INDIVIDUAL",
    nin: "12345678901",
  };
  const payoutBody: PayoutVerificationDto = {
    bankName: "GTBank",
    bankCode: "058",
    accountNumber: "0123456789",
  };
  const drivingBody: DrivingCredentialsDto = { isOwnerDriver: false };
  const createBody: CreateAccountVerificationDto = {
    accountType: "INDIVIDUAL",
    nin: "12345678901",
    isOwnerDriver: false,
    bankName: "GTBank",
    bankCode: "058",
    accountNumber: "0123456789",
  };

  const licenseFile = (): UploadedAccountDocument => ({
    originalname: "license.pdf",
    mimetype: "application/pdf",
    size: 1024,
    buffer: Buffer.from("license-pdf"),
  });

  const createMockResponse = () => ({ setHeader: vi.fn() }) as unknown as Response;

  const handlerMeta = (name: keyof AccountVerificationController) => {
    const handler = AccountVerificationController.prototype[name] as object;
    return {
      path: Reflect.getMetadata(PATH_METADATA, handler) as string,
      method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
      guards: (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[],
    };
  };

  beforeEach(async () => {
    accountVerificationService = {
      replaceRejectedDriversLicense: vi.fn(),
      create: vi.fn(),
      verifyIdentityStage: vi.fn(),
      verifyPayoutStage: vi.fn(),
      saveDrivingCredentialsStage: vi.fn(),
      submitStage: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: VERIFICATION_THROTTLE_CONFIG.name,
            ttl: VERIFICATION_THROTTLE_CONFIG.ttlMs,
            limit: VERIFICATION_THROTTLE_CONFIG.limit,
          },
        ]),
      ],
      controllers: [AccountVerificationController],
      providers: [
        VerificationThrottlerGuard,
        { provide: AccountVerificationService, useValue: accountVerificationService },
        {
          provide: PhoneVerificationService,
          useValue: { send: vi.fn(), check: vi.fn() },
        },
        {
          provide: FlutterwaveService,
          useValue: { listNigerianBanks: vi.fn() },
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
            getUserRoles: vi.fn().mockResolvedValue(["fleetOwner"]),
          },
        },
        Reflector,
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get(AccountVerificationController);
  });

  const replaceRejectedDriversLicense = (user: typeof mockUser, file: UploadedAccountDocument) =>
    (
      controller as AccountVerificationController & {
        replaceRejectedDriversLicense: (
          user: typeof mockUser,
          file: UploadedAccountDocument,
        ) => Promise<unknown>;
      }
    ).replaceRejectedDriversLicense(user, file);

  it("does not require an approved fleet-owner account for onboarding recovery", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AccountVerificationController) ?? [];
    expect(guards).not.toContain(VerifiedFleetOwnerGuard);
    expect(guards).toEqual(expect.arrayContaining([SessionGuard, RoleGuard]));
    expect(Reflect.getMetadata(ROLES_KEY, AccountVerificationController)).toEqual([FLEET_OWNER]);
  });

  it("exposes PUT /api/fleet-owner/documents/drivers-license", () => {
    const handler = (
      AccountVerificationController.prototype as AccountVerificationController & {
        replaceRejectedDriversLicense?: (...args: unknown[]) => unknown;
      }
    ).replaceRejectedDriversLicense;
    expect(handler).toEqual(expect.any(Function));
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("documents/drivers-license");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PUT);
  });

  it.each([
    ["verifyIdentity", "onboarding/identity-verifications", RequestMethod.POST],
    ["verifyPayout", "onboarding/payout-verifications", RequestMethod.POST],
    ["saveDrivingCredentials", "onboarding/driving-credentials", RequestMethod.PUT],
    ["submit", "onboarding/submissions", RequestMethod.POST],
  ] as const)("exposes %s at %s", (handlerName, path, method) => {
    const meta = handlerMeta(handlerName);
    expect(meta.path).toBe(path);
    expect(meta.method).toBe(method);
    expect(meta.guards).toContain(VerificationThrottlerGuard);
  });

  it("replaces a rejected driver's licence (PUT /api/fleet-owner/documents/drivers-license)", async () => {
    const file = licenseFile();
    const updated = {
      id: "doc-1",
      documentType: DocumentType.DRIVERS_LICENSE,
      status: DocumentStatus.PENDING,
    };
    accountVerificationService.replaceRejectedDriversLicense.mockResolvedValueOnce(updated);

    await expect(replaceRejectedDriversLicense(mockUser, file)).resolves.toEqual(updated);
    expect(accountVerificationService.replaceRejectedDriversLicense).toHaveBeenCalledWith(
      "owner-1",
      file,
    );
    expect(accountVerificationService.create).not.toHaveBeenCalled();
  });

  it("delegates identity verification with the session user and idempotency key", async () => {
    const response = createMockResponse();
    const result = { status: "VERIFIED" };
    accountVerificationService.verifyIdentityStage.mockResolvedValueOnce(result);

    await expect(
      controller.verifyIdentity(mockUser, idempotencyKey, identityBody, response),
    ).resolves.toEqual(result);
    expect(accountVerificationService.verifyIdentityStage).toHaveBeenCalledWith(
      "owner-1",
      idempotencyKey,
      identityBody,
    );
  });

  it("delegates payout verification with the session user and idempotency key", async () => {
    const response = createMockResponse();
    const result = { status: "VERIFIED" };
    accountVerificationService.verifyPayoutStage.mockResolvedValueOnce(result);

    await expect(
      controller.verifyPayout(mockUser, idempotencyKey, payoutBody, response),
    ).resolves.toEqual(result);
    expect(accountVerificationService.verifyPayoutStage).toHaveBeenCalledWith(
      "owner-1",
      idempotencyKey,
      payoutBody,
    );
  });

  it("delegates driving credentials with uploaded documents", async () => {
    const response = createMockResponse();
    const documents = { driversLicense: licenseFile() };
    const result = { status: "COMPLETED", isOwnerDriver: true };
    accountVerificationService.saveDrivingCredentialsStage.mockResolvedValueOnce(result);

    await expect(
      controller.saveDrivingCredentials(
        mockUser,
        idempotencyKey,
        { isOwnerDriver: true },
        documents,
        response,
      ),
    ).resolves.toEqual(result);
    expect(accountVerificationService.saveDrivingCredentialsStage).toHaveBeenCalledWith(
      "owner-1",
      idempotencyKey,
      { isOwnerDriver: true },
      documents,
    );
  });

  it("delegates staged submission with the session user and idempotency key", async () => {
    const response = createMockResponse();
    const result = { status: "SUCCEEDED" };
    accountVerificationService.submitStage.mockResolvedValueOnce(result);

    await expect(controller.submit(mockUser, idempotencyKey, response)).resolves.toEqual(result);
    expect(accountVerificationService.submitStage).toHaveBeenCalledWith("owner-1", idempotencyKey);
  });

  it.each([
    [
      "identity",
      (response: Response) =>
        controller.verifyIdentity(mockUser, idempotencyKey, identityBody, response),
      "verifyIdentityStage",
    ],
    [
      "payout",
      (response: Response) =>
        controller.verifyPayout(mockUser, idempotencyKey, payoutBody, response),
      "verifyPayoutStage",
    ],
    [
      "driving",
      (response: Response) =>
        controller.saveDrivingCredentials(mockUser, idempotencyKey, drivingBody, {}, response),
      "saveDrivingCredentialsStage",
    ],
    [
      "submission",
      (response: Response) => controller.submit(mockUser, idempotencyKey, response),
      "submitStage",
    ],
    [
      "legacy create",
      (response: Response) =>
        controller.createAccountVerification(mockUser, idempotencyKey, createBody, {}, response),
      "create",
    ],
  ] as const)(
    "sets Retry-After when an identical %s request is processing",
    async (_label, invoke, serviceMethod) => {
      const response = createMockResponse();
      accountVerificationService[serviceMethod].mockRejectedValueOnce(
        new VerificationRequestInProgressException(),
      );

      await expect(invoke(response)).rejects.toBeInstanceOf(VerificationRequestInProgressException);
      expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "5");
    },
  );
});
