import { createHmac } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { PremblyError, PremblyService } from "../src/modules/prembly/prembly.service";
import { StorageService } from "../src/modules/storage/storage.service";
import {
  type CreateAccountVerificationDto,
  createAccountVerificationSchema,
} from "../src/modules/verification/account-verification.dto";
import { TestDataFactory, uniqueEmail } from "./helpers";

const twilioMocks = vi.hoisted(() => ({
  createVerification: vi.fn(),
  createVerificationCheck: vi.fn(),
}));

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: { create: twilioMocks.createVerification },
          verificationChecks: { create: twilioMocks.createVerificationCheck },
        })),
      },
    },
  })),
}));

const PHONE = "+2348012345678";
const ACCOUNT_NUMBER = "0123456789";
const INDIVIDUAL_FIELDS = {
  accountType: "INDIVIDUAL",
  nin: "12345678901",
  isOwnerDriver: "false",
  bankName: "GTBank",
  bankCode: "058",
  accountNumber: ACCOUNT_NUMBER,
} as const;

function hashRequest(input: CreateAccountVerificationDto): string {
  return createHmac("sha256", process.env.HMAC_KEY ?? "")
    .update(
      JSON.stringify({
        ...input,
        driversLicense: null,
        lasdri: null,
      }),
    )
    .digest("hex");
}

function pdfDocument(contents = "licence"): Buffer {
  return Buffer.from(`%PDF-1.4 ${contents}`);
}

describe("Fleet-owner account verification E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let ownerCookie: string;
  let userCookie: string;
  let adminCookie: string;
  let premblyService: {
    verifyNin: ReturnType<typeof vi.fn>;
    verifyCac: ReturnType<typeof vi.fn>;
  };
  let flutterwaveService: { resolveBankAccount: ReturnType<typeof vi.fn> };
  let clientIp = "203.0.113.10";
  let ipSequence = 10;

  function http(method: "get" | "post", path: string) {
    return request(app.getHttpServer())[method](path).set("X-Forwarded-For", clientIp);
  }

  function withAuth(req: request.Test, cookie: string) {
    return req.set("Cookie", cookie).set("X-Forwarded-For", clientIp);
  }

  async function readyOwner(emailPrefix: string): Promise<{ cookie: string; id: string }> {
    const auth = await factory.authenticateAndGetUser(
      uniqueEmail(emailPrefix),
      "fleetOwner",
      "web",
    );
    await databaseService.user.update({
      where: { id: auth.user.id },
      data: {
        emailVerified: true,
        phoneNumber: PHONE,
        phoneVerifiedAt: new Date(),
      },
    });
    return { cookie: auth.cookie, id: auth.user.id };
  }

  function accountVerificationRequest(cookie: string, idempotencyKey: string) {
    return withAuth(
      http("post", "/api/fleet-owner/account-verifications")
        .set("Idempotency-Key", idempotencyKey)
        .field("accountType", INDIVIDUAL_FIELDS.accountType)
        .field("nin", INDIVIDUAL_FIELDS.nin)
        .field("isOwnerDriver", INDIVIDUAL_FIELDS.isOwnerDriver)
        .field("bankName", INDIVIDUAL_FIELDS.bankName)
        .field("bankCode", INDIVIDUAL_FIELDS.bankCode)
        .field("accountNumber", INDIVIDUAL_FIELDS.accountNumber),
      cookie,
    );
  }

  function ownerDriverVerificationRequest(
    cookie: string,
    idempotencyKey: string,
    extras: { lasdri?: Buffer } = {},
  ) {
    const req = withAuth(
      http("post", "/api/fleet-owner/account-verifications")
        .set("Idempotency-Key", idempotencyKey)
        .field("accountType", INDIVIDUAL_FIELDS.accountType)
        .field("nin", INDIVIDUAL_FIELDS.nin)
        .field("isOwnerDriver", "true")
        .field("bankName", INDIVIDUAL_FIELDS.bankName)
        .field("bankCode", INDIVIDUAL_FIELDS.bankCode)
        .field("accountNumber", INDIVIDUAL_FIELDS.accountNumber)
        .attach("driversLicense", pdfDocument(), {
          filename: "license.pdf",
          contentType: "application/pdf",
        }),
      cookie,
    );
    if (extras.lasdri) {
      req.attach("lasdri", extras.lasdri, {
        filename: "lasdri.pdf",
        contentType: "application/pdf",
      });
    }
    return req;
  }

  beforeAll(async () => {
    premblyService = {
      verifyNin: vi.fn(),
      verifyCac: vi.fn(),
    };
    flutterwaveService = {
      resolveBankAccount: vi.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(StorageService)
      .useValue({
        uploadBuffer: vi.fn().mockImplementation(async (_buffer: Buffer, key: string) => {
          return `https://cdn.tripdly.test/${key}`;
        }),
        deleteObjectByKey: vi.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(PremblyService)
      .useValue(premblyService)
      .overrideProvider(FlutterwaveService)
      .useValue(flutterwaveService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();
    // prisma db push does not apply this partial unique index from the migration.
    await databaseService.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "FleetOwnerAccountVerification_one_active_per_user_idx"
      ON "FleetOwnerAccountVerification"("userId")
      WHERE "status" IN ('PROCESSING', 'REVIEW_REQUIRED')
    `);

    const owner = await readyOwner("acct-owner");
    ownerCookie = owner.cookie;

    const userAuth = await factory.authenticateAndGetUser(uniqueEmail("acct-user"), "user");
    userCookie = userAuth.cookie;

    const adminAuth = await factory.createAuthenticatedAdmin(uniqueEmail("acct-admin"));
    adminCookie = adminAuth.cookie;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    ipSequence += 1;
    clientIp = `198.51.100.${(ipSequence % 200) + 1}`;
    await factory.clearRateLimits();
    twilioMocks.createVerification.mockReset();
    twilioMocks.createVerificationCheck.mockReset();
    premblyService.verifyNin.mockReset();
    premblyService.verifyCac.mockReset();
    flutterwaveService.resolveBankAccount.mockReset();

    twilioMocks.createVerification.mockResolvedValue({ status: "pending" });
    twilioMocks.createVerificationCheck.mockResolvedValue({ status: "approved" });
    premblyService.verifyNin.mockResolvedValue({
      firstName: "JOHN",
      middleName: "MIDDLE",
      lastName: "DOE",
      reference: "nin-ref",
    });
    flutterwaveService.resolveBankAccount.mockResolvedValue({
      accountNumber: ACCOUNT_NUMBER,
      accountName: "JOHN DOE",
      bankCode: "058",
    });
  });

  it("GET /api/fleet-owner/onboarding requires authentication", async () => {
    const response = await http("get", "/api/fleet-owner/onboarding");

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("GET /api/fleet-owner/onboarding rejects a non-fleet-owner", async () => {
    const response = await http("get", "/api/fleet-owner/onboarding").set("Cookie", userCookie);

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("GET /api/fleet-owner/onboarding returns masked action-required status", async () => {
    const owner = await factory.authenticateAndGetUser(
      uniqueEmail("acct-status"),
      "fleetOwner",
      "web",
    );
    await databaseService.user.update({
      where: { id: owner.user.id },
      data: { phoneNumber: PHONE, phoneVerifiedAt: null, emailVerified: true },
    });

    const response = await http("get", "/api/fleet-owner/onboarding").set("Cookie", owner.cookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toMatchObject({
      status: "ACTION_REQUIRED",
      phone: { number: "**********5678", verified: false },
      requiredActions: expect.arrayContaining(["VERIFY_PHONE", "VERIFY_ACCOUNT"]),
    });
  });

  it("POST /api/fleet-owner/phone-verifications requires a fleet-owner session", async () => {
    const unauthenticated = await http("post", "/api/fleet-owner/phone-verifications").send({
      phoneNumber: PHONE,
    });
    const forbidden = await http("post", "/api/fleet-owner/phone-verifications")
      .set("Cookie", userCookie)
      .send({ phoneNumber: PHONE });

    expect(unauthenticated.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("POST /api/fleet-owner/phone-verifications rejects an invalid phone number", async () => {
    const response = await http("post", "/api/fleet-owner/phone-verifications")
      .set("Cookie", ownerCookie)
      .send({ phoneNumber: "08012345678" });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body.errorCode ?? response.body.type).toBe("VALIDATION_ERROR");
  });

  it("POST /api/fleet-owner/phone-verifications sends a code and masks the number", async () => {
    const response = await http("post", "/api/fleet-owner/phone-verifications")
      .set("Cookie", ownerCookie)
      .send({ phoneNumber: "+2348091111111" });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toEqual({
      status: "PENDING",
      phoneNumber: "**********1111",
    });
    expect(twilioMocks.createVerification).toHaveBeenCalledWith({
      channel: "sms",
      to: "+2348091111111",
    });
  });

  it("POST /api/fleet-owner/phone-verifications is idempotent for an already-verified number", async () => {
    const response = await http("post", "/api/fleet-owner/phone-verifications")
      .set("Cookie", ownerCookie)
      .send({ phoneNumber: PHONE });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toEqual({ status: "VERIFIED", phoneNumber: "**********5678" });
    expect(twilioMocks.createVerification).not.toHaveBeenCalled();
  });

  it("POST /api/fleet-owner/phone-verifications maps a Twilio failure", async () => {
    twilioMocks.createVerification.mockRejectedValueOnce(new Error("twilio down"));

    const response = await http("post", "/api/fleet-owner/phone-verifications")
      .set("Cookie", ownerCookie)
      .send({ phoneNumber: "+2348092222222" });

    expect(response.status).toBe(HttpStatus.BAD_GATEWAY);
    expect(response.body.errorCode).toBe("PHONE_VERIFICATION_PROVIDER_UNAVAILABLE");
  });

  it("POST /api/fleet-owner/phone-verification-checks rejects an invalid code", async () => {
    twilioMocks.createVerificationCheck.mockResolvedValueOnce({ status: "pending" });

    const response = await http("post", "/api/fleet-owner/phone-verification-checks")
      .set("Cookie", ownerCookie)
      .send({ phoneNumber: "+2348093333333", code: "000000" });

    expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(response.body.errorCode).toBe("PHONE_VERIFICATION_CODE_INVALID");
  });

  it("POST /api/fleet-owner/phone-verification-checks verifies a new number", async () => {
    const owner = await factory.authenticateAndGetUser(
      uniqueEmail("acct-phone-check"),
      "fleetOwner",
      "web",
    );

    const response = await http("post", "/api/fleet-owner/phone-verification-checks")
      .set("Cookie", owner.cookie)
      .send({ phoneNumber: PHONE, code: "123456" });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toEqual({ status: "VERIFIED", phoneNumber: "**********5678" });
    const persisted = await databaseService.user.findUnique({
      where: { id: owner.user.id },
      select: { phoneNumber: true, phoneVerifiedAt: true },
    });
    expect(persisted).toMatchObject({ phoneNumber: PHONE });
    expect(persisted?.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("POST /api/fleet-owner/account-verifications requires auth, role, and an idempotency key", async () => {
    const unauthenticated = await http("post", "/api/fleet-owner/account-verifications").field(
      "accountType",
      "INDIVIDUAL",
    );
    const forbidden = await accountVerificationRequest(userCookie, "account-key-1");
    const missingKey = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", ownerCookie)
      .field("accountType", "INDIVIDUAL")
      .field("nin", INDIVIDUAL_FIELDS.nin)
      .field("isOwnerDriver", "false")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER);

    expect(unauthenticated.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);
    expect(missingKey.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("POST /api/fleet-owner/account-verifications rejects an invalid NIN", async () => {
    const response = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", ownerCookie)
      .set("Idempotency-Key", "account-invalid-nin")
      .field("accountType", "INDIVIDUAL")
      .field("nin", "123")
      .field("isOwnerDriver", "false")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER);

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("POST /api/fleet-owner/account-verifications rejects an owner-driver without a licence", async () => {
    const owner = await readyOwner("acct-no-license");

    const response = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", owner.cookie)
      .set("Idempotency-Key", "account-no-license")
      .field("accountType", "INDIVIDUAL")
      .field("nin", INDIVIDUAL_FIELDS.nin)
      .field("isOwnerDriver", "true")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER);

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body.errorCode).toBe("OWNER_DRIVER_LICENSE_REQUIRED");
    expect(premblyService.verifyNin).not.toHaveBeenCalled();
  });

  it("POST /api/fleet-owner/account-verifications verifies a business and matches CAC plus bank names", async () => {
    const owner = await readyOwner("acct-business");
    premblyService.verifyCac.mockResolvedValueOnce({
      businessName: "HYRE MOBILITY LTD",
      registrationNumber: "RC123456",
      registrationType: "RC",
      status: "ACTIVE",
      directors: [{ firstName: "JOHN", middleName: null, lastName: "DOE" }],
      reference: "cac-ref",
    });
    flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
      accountNumber: ACCOUNT_NUMBER,
      accountName: "HYRE MOBILITY LIMITED",
      bankCode: "058",
    });

    const response = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", owner.cookie)
      .set("Idempotency-Key", "account-business-1")
      .field("accountType", "BUSINESS")
      .field("nin", INDIVIDUAL_FIELDS.nin)
      .field("isOwnerDriver", "false")
      .field("businessName", "Hyre Mobility Limited")
      .field("registrationNumber", "RC123456")
      .field("registrationType", "RC")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER);

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({
      status: "SUCCEEDED",
      accountType: "BUSINESS",
      legalName: "JOHN MIDDLE DOE",
      businessName: "HYRE MOBILITY LTD",
      bank: {
        accountName: "HYRE MOBILITY LIMITED",
        accountNumber: "******6789",
        nameMatch: "MATCHED",
      },
    });
    expect(premblyService.verifyCac).toHaveBeenCalledWith(
      "RC123456",
      "RC",
      "Hyre Mobility Limited",
    );
  });

  it("POST /api/fleet-owner/account-verifications verifies an individual and masks the bank number", async () => {
    const owner = await readyOwner("acct-individual");

    const response = await accountVerificationRequest(owner.cookie, "account-individual-1");

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({
      status: "SUCCEEDED",
      accountType: "INDIVIDUAL",
      legalName: "JOHN MIDDLE DOE",
      bank: {
        bankName: "GTBank",
        accountName: "JOHN DOE",
        accountNumber: "******6789",
        nameMatch: "MATCHED",
      },
    });

    const status = await http("get", "/api/fleet-owner/onboarding").set("Cookie", owner.cookie);

    expect(status.status).toBe(HttpStatus.OK);
    expect(status.body).toMatchObject({
      status: "VERIFIED",
      phone: { number: "**********5678", verified: true },
      bank: { accountNumber: "******6789", verified: true },
    });
  });

  it("POST /api/fleet-owner/account-verifications sends a new owner-driver licence to review", async () => {
    const owner = await readyOwner("acct-owner-driver");

    const response = await ownerDriverVerificationRequest(owner.cookie, "account-owner-driver-1");

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({
      status: "REVIEW_REQUIRED",
      isOwnerDriver: true,
    });

    const [documents, user, bank] = await Promise.all([
      databaseService.documentApproval.findMany({
        where: { userId: owner.id },
        select: { documentType: true, status: true },
      }),
      databaseService.user.findUnique({
        where: { id: owner.id },
        select: { fleetOwnerStatus: true, hasOnboarded: true },
      }),
      databaseService.bankDetails.findUnique({
        where: { userId: owner.id },
        select: { isVerified: true },
      }),
    ]);
    expect(documents).toEqual(
      expect.arrayContaining([{ documentType: "DRIVERS_LICENSE", status: "PENDING" }]),
    );
    expect(documents.some(({ documentType }) => documentType === "LASDRI")).toBe(false);
    expect(user).toMatchObject({ fleetOwnerStatus: "PROCESSING", hasOnboarded: true });
    expect(bank?.isVerified).toBe(false);

    const status = await http("get", "/api/fleet-owner/onboarding").set("Cookie", owner.cookie);
    expect(status.body).toMatchObject({ status: "UNDER_REVIEW", bank: { verified: false } });
  });

  it("POST /api/fleet-owner/account-verifications succeeds when an owner-driver licence is already approved", async () => {
    const owner = await readyOwner("acct-owner-driver-approved");
    await databaseService.documentApproval.create({
      data: {
        userId: owner.id,
        documentType: "DRIVERS_LICENSE",
        documentUrl: "https://cdn.tripdly.test/approved-license.pdf",
        status: "APPROVED",
      },
    });

    const response = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", owner.cookie)
      .set("Idempotency-Key", "account-owner-driver-approved-1")
      .field("accountType", "INDIVIDUAL")
      .field("nin", INDIVIDUAL_FIELDS.nin)
      .field("isOwnerDriver", "true")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER);

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({ status: "SUCCEEDED", isOwnerDriver: true });

    const [user, bank] = await Promise.all([
      databaseService.user.findUnique({
        where: { id: owner.id },
        select: { fleetOwnerStatus: true },
      }),
      databaseService.bankDetails.findUnique({
        where: { userId: owner.id },
        select: { isVerified: true },
      }),
    ]);
    expect(user?.fleetOwnerStatus).toBe("APPROVED");
    expect(bank?.isVerified).toBe(true);
  });

  it("POST /api/fleet-owner/account-verifications accepts optional LASDRI without gating review", async () => {
    const owner = await readyOwner("acct-lasdri-optional");

    const response = await ownerDriverVerificationRequest(
      owner.cookie,
      "account-lasdri-optional-1",
      {
        lasdri: pdfDocument("lasdri"),
      },
    );

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({ status: "REVIEW_REQUIRED", isOwnerDriver: true });

    const documents = await databaseService.documentApproval.findMany({
      where: { userId: owner.id },
      select: { documentType: true, status: true },
    });
    expect(documents).toEqual(
      expect.arrayContaining([
        { documentType: "DRIVERS_LICENSE", status: "PENDING" },
        { documentType: "LASDRI", status: "PENDING" },
      ]),
    );
  });

  it("replays an identical idempotent account verification", async () => {
    const owner = await readyOwner("acct-replay");
    const first = await accountVerificationRequest(owner.cookie, "account-replay-1");
    const second = await accountVerificationRequest(owner.cookie, "account-replay-1");

    expect(first.status).toBe(HttpStatus.CREATED);
    expect(second.status).toBe(HttpStatus.CREATED);
    expect(second.body).toEqual(first.body);
    expect(premblyService.verifyNin).toHaveBeenCalledTimes(1);
  });

  it("rejects an idempotency key reused with a different payload", async () => {
    const owner = await readyOwner("acct-conflict");
    const first = await accountVerificationRequest(owner.cookie, "account-conflict-1");
    const second = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", owner.cookie)
      .set("Idempotency-Key", "account-conflict-1")
      .field("accountType", "INDIVIDUAL")
      .field("nin", "10987654321")
      .field("isOwnerDriver", "false")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER);

    expect(first.status).toBe(HttpStatus.CREATED);
    expect(second.status).toBe(HttpStatus.CONFLICT);
    expect(second.body.errorCode).toBe("VERIFICATION_IDEMPOTENCY_KEY_REUSED");
  });

  it("returns Retry-After when an identical request is still processing", async () => {
    const owner = await readyOwner("acct-in-progress");
    const input = createAccountVerificationSchema.parse({
      ...INDIVIDUAL_FIELDS,
      isOwnerDriver: "false",
    });
    await databaseService.fleetOwnerAccountVerification.create({
      data: {
        userId: owner.id,
        idempotencyKey: "account-in-progress-1",
        requestHash: hashRequest(input),
        accountType: "INDIVIDUAL",
        isOwnerDriver: false,
        status: "PROCESSING",
        processingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const response = await accountVerificationRequest(owner.cookie, "account-in-progress-1");

    expect(response.status).toBe(HttpStatus.CONFLICT);
    expect(response.body.errorCode).toBe("VERIFICATION_REQUEST_IN_PROGRESS");
    expect(response.headers["retry-after"]).toBe("5");
    expect(premblyService.verifyNin).not.toHaveBeenCalled();
  });

  it("replays a failed account verification as the original provider error", async () => {
    const owner = await readyOwner("acct-failed-replay");
    premblyService.verifyNin.mockRejectedValueOnce(new PremblyError("REJECTED"));

    const first = await accountVerificationRequest(owner.cookie, "account-failed-1");
    const second = await accountVerificationRequest(owner.cookie, "account-failed-1");

    expect(first.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(first.body.errorCode).toBe("PROVIDER_REJECTED");
    expect(second.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(second.body.errorCode).toBe("PROVIDER_REJECTED");
    expect(premblyService.verifyNin).toHaveBeenCalledTimes(1);
  });

  it("rejects a different idempotency key while a review is pending", async () => {
    const owner = await readyOwner("acct-review-lock");
    const first = await ownerDriverVerificationRequest(owner.cookie, "account-review-lock-1");
    const second = await accountVerificationRequest(owner.cookie, "account-review-lock-2");

    expect(first.status).toBe(HttpStatus.CREATED);
    expect(first.body.status).toBe("REVIEW_REQUIRED");
    expect(second.status).toBe(HttpStatus.CONFLICT);
    expect(second.body.errorCode).toBe("ACCOUNT_VERIFICATION_REVIEW_PENDING");
  });

  it("fails a stale PROCESSING attempt before claiming a new idempotency key", async () => {
    const owner = await readyOwner("acct-stale");
    const input = createAccountVerificationSchema.parse({
      ...INDIVIDUAL_FIELDS,
      isOwnerDriver: "false",
    });
    const stale = await databaseService.fleetOwnerAccountVerification.create({
      data: {
        userId: owner.id,
        idempotencyKey: "account-stale-1",
        requestHash: hashRequest(input),
        accountType: "INDIVIDUAL",
        isOwnerDriver: false,
        status: "PROCESSING",
        processingExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const response = await accountVerificationRequest(owner.cookie, "account-stale-2");

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body.status).toBe("SUCCEEDED");
    const expired = await databaseService.fleetOwnerAccountVerification.findUnique({
      where: { id: stale.id },
      select: { status: true, failureReason: true },
    });
    expect(expired).toMatchObject({
      status: "FAILED",
      failureReason: "ACCOUNT_VERIFICATION_FAILED",
    });
  });

  it("rejects an oversized account document before calling providers", async () => {
    const owner = await readyOwner("acct-oversized");
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0);
    oversized.write("%PDF-1.4");

    const response = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", owner.cookie)
      .set("Idempotency-Key", "account-oversized-1")
      .field("accountType", "INDIVIDUAL")
      .field("nin", INDIVIDUAL_FIELDS.nin)
      .field("isOwnerDriver", "true")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER)
      .attach("driversLicense", oversized, {
        filename: "license.pdf",
        contentType: "application/pdf",
      });

    expect([HttpStatus.BAD_REQUEST, HttpStatus.PAYLOAD_TOO_LARGE]).toContain(response.status);
    expect(premblyService.verifyNin).not.toHaveBeenCalled();
  });

  it("rejects spoofed document MIME types", async () => {
    const owner = await readyOwner("acct-spoofed-mime");

    const response = await http("post", "/api/fleet-owner/account-verifications")
      .set("Cookie", owner.cookie)
      .set("Idempotency-Key", "account-spoofed-1")
      .field("accountType", "INDIVIDUAL")
      .field("nin", INDIVIDUAL_FIELDS.nin)
      .field("isOwnerDriver", "true")
      .field("bankName", "GTBank")
      .field("bankCode", "058")
      .field("accountNumber", ACCOUNT_NUMBER)
      .attach("driversLicense", pdfDocument(), {
        filename: "license.jpg",
        contentType: "image/jpeg",
      });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body.errorCode).toBe("ACCOUNT_DOCUMENT_INVALID");
    expect(premblyService.verifyNin).not.toHaveBeenCalled();
  });

  it("keeps onboarding accessible while blocking operational fleet-owner routes", async () => {
    const owner = await factory.authenticateAndGetUser(
      uniqueEmail("acct-unverified-ops"),
      "fleetOwner",
      "web",
    );

    const onboarding = await http("get", "/api/fleet-owner/onboarding").set("Cookie", owner.cookie);
    const cars = await http("get", "/api/fleet-owner/cars").set("Cookie", owner.cookie);

    expect(onboarding.status).toBe(HttpStatus.OK);
    expect(cars.status).toBe(HttpStatus.FORBIDDEN);
    expect(cars.body.errorCode).toBe("AUTH_FLEET_OWNER_VERIFICATION_REQUIRED");
  });

  it("does not return VERIFIED after a verified owner loses phone verification", async () => {
    const owner = await readyOwner("acct-phone-precedence");
    const verified = await accountVerificationRequest(owner.cookie, "account-phone-precedence-1");
    expect(verified.status).toBe(HttpStatus.CREATED);

    await databaseService.user.update({
      where: { id: owner.id },
      data: { phoneVerifiedAt: null },
    });

    const status = await http("get", "/api/fleet-owner/onboarding").set("Cookie", owner.cookie);
    expect(status.status).toBe(HttpStatus.OK);
    expect(status.body).toMatchObject({
      status: "ACTION_REQUIRED",
      requiredActions: expect.arrayContaining(["VERIFY_PHONE"]),
    });
  });

  it("restricts admin account review endpoints to admins", async () => {
    const owner = await readyOwner("acct-admin-forbidden");
    const created = await ownerDriverVerificationRequest(owner.cookie, "account-admin-forbidden-1");
    const path = `/api/admin/fleet-owner-account-verifications/${created.body.id}/approve`;

    const unauthenticated = await http("post", path);
    const asUser = await http("post", path).set("Cookie", userCookie);
    const asOwner = await http("post", path).set("Cookie", owner.cookie);

    expect(unauthenticated.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(asUser.status).toBe(HttpStatus.FORBIDDEN);
    expect(asOwner.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("requires an approved owner-driver licence before admin approval, then applies it atomically", async () => {
    const owner = await readyOwner("acct-admin-approve");
    const created = await ownerDriverVerificationRequest(owner.cookie, "account-admin-approve-1");
    expect(created.body.status).toBe("REVIEW_REQUIRED");

    const blocked = await http(
      "post",
      `/api/admin/fleet-owner-account-verifications/${created.body.id}/approve`,
    ).set("Cookie", adminCookie);
    expect(blocked.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(blocked.body.errorCode).toBe("OWNER_DRIVER_LICENSE_NOT_APPROVED");

    const license = await databaseService.documentApproval.findUnique({
      where: {
        documentType_userId: { documentType: "DRIVERS_LICENSE", userId: owner.id },
      },
    });
    expect(license).toBeTruthy();
    const licenseApprove = await http("post", `/api/admin/documents/${license?.id}/approve`).set(
      "Cookie",
      adminCookie,
    );
    expect(licenseApprove.status).toBe(HttpStatus.CREATED);

    const approved = await http(
      "post",
      `/api/admin/fleet-owner-account-verifications/${created.body.id}/approve`,
    ).set("Cookie", adminCookie);
    expect(approved.status).toBe(HttpStatus.CREATED);
    expect(approved.body).toMatchObject({ status: "SUCCEEDED" });

    const [user, bank, verification] = await Promise.all([
      databaseService.user.findUnique({
        where: { id: owner.id },
        select: { fleetOwnerStatus: true, hasOnboarded: true },
      }),
      databaseService.bankDetails.findUnique({
        where: { userId: owner.id },
        select: { isVerified: true },
      }),
      databaseService.fleetOwnerAccountVerification.findUnique({
        where: { id: created.body.id },
        select: { reviewedById: true, reviewedAt: true, reviewNotes: true },
      }),
    ]);
    expect(user).toMatchObject({ fleetOwnerStatus: "APPROVED", hasOnboarded: true });
    expect(bank?.isVerified).toBe(true);
    expect(verification?.reviewedById).toBeTruthy();
    expect(verification?.reviewedAt).toBeInstanceOf(Date);
    expect(verification?.reviewNotes).toBeNull();
  });

  it("lets an admin reject a pending review and holds the fleet owner", async () => {
    const owner = await readyOwner("acct-admin-reject");
    const created = await ownerDriverVerificationRequest(owner.cookie, "account-admin-reject-1");

    const rejected = await http(
      "post",
      `/api/admin/fleet-owner-account-verifications/${created.body.id}/reject`,
    )
      .set("Cookie", adminCookie)
      .send({ notes: "Documents are unreadable" });

    expect(rejected.status).toBe(HttpStatus.CREATED);
    expect(rejected.body).toEqual({ success: true });

    const [user, bank, verification] = await Promise.all([
      databaseService.user.findUnique({
        where: { id: owner.id },
        select: { fleetOwnerStatus: true, hasOnboarded: true },
      }),
      databaseService.bankDetails.findUnique({
        where: { userId: owner.id },
        select: { isVerified: true },
      }),
      databaseService.fleetOwnerAccountVerification.findUnique({
        where: { id: created.body.id },
        select: { status: true, failureReason: true, reviewedById: true, reviewNotes: true },
      }),
    ]);
    expect(user).toMatchObject({ fleetOwnerStatus: "ON_HOLD", hasOnboarded: false });
    expect(bank?.isVerified).toBe(false);
    expect(verification).toMatchObject({
      status: "FAILED",
      failureReason: "ACCOUNT_MANUAL_REVIEW_REJECTED",
      reviewNotes: "Documents are unreadable",
    });
    expect(verification?.reviewedById).toBeTruthy();
  });

  it("POST /api/admin/documents/:id/approve ignores optional LASDRI when approving a chauffeur", async () => {
    const fleetOwner = await factory.createFleetOwner({
      email: uniqueEmail("acct-lasdri-owner"),
    });
    const chauffeur = await factory.createUser({
      email: uniqueEmail("acct-lasdri"),
      name: "Owner Driver",
    });
    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: { chauffeurApprovalStatus: "PENDING", fleetOwnerId: fleetOwner.id },
    });
    const [nin, license, lasdri] = await Promise.all([
      databaseService.documentApproval.create({
        data: {
          userId: chauffeur.id,
          documentType: "NIN",
          documentUrl: "https://cdn.tripdly.test/nin.pdf",
          status: "APPROVED",
        },
      }),
      databaseService.documentApproval.create({
        data: {
          userId: chauffeur.id,
          documentType: "DRIVERS_LICENSE",
          documentUrl: "https://cdn.tripdly.test/license.pdf",
          status: "PENDING",
        },
      }),
      databaseService.documentApproval.create({
        data: {
          userId: chauffeur.id,
          documentType: "LASDRI",
          documentUrl: "https://cdn.tripdly.test/lasdri.pdf",
          status: "PENDING",
        },
      }),
    ]);

    const response = await http("post", `/api/admin/documents/${license.id}/approve`).set(
      "Cookie",
      adminCookie,
    );

    expect(response.status).toBe(HttpStatus.CREATED);
    const user = await databaseService.user.findUnique({
      where: { id: chauffeur.id },
      select: { chauffeurApprovalStatus: true },
    });
    const pendingLasdri = await databaseService.documentApproval.findUnique({
      where: { id: lasdri.id },
      select: { status: true },
    });
    expect(user?.chauffeurApprovalStatus).toBe("APPROVED");
    expect(pendingLasdri?.status).toBe("PENDING");
    expect(nin.id).toBeTruthy();
  });
});
