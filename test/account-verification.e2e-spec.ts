import { createHmac } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { FlutterwaveError } from "../src/modules/flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { PremblyError, PremblyService } from "../src/modules/prembly/prembly.service";
import { StorageService } from "../src/modules/storage/storage.service";
import {
  type AccountIdentityVerificationDto,
  type CreateAccountVerificationDto,
  createAccountVerificationSchema,
  type PayoutVerificationDto,
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
const INDIVIDUAL_IDENTITY = {
  accountType: "INDIVIDUAL",
  nin: "12345678901",
} as const;
const BUSINESS_IDENTITY = {
  accountType: "BUSINESS",
  nin: "12345678901",
  businessName: "Hyre Mobility Limited",
  registrationNumber: "RC123456",
  registrationType: "RC",
} as const;
const PAYOUT_FIELDS = {
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
  let flutterwaveService: {
    resolveBankAccount: ReturnType<typeof vi.fn>;
    listNigerianBanks: ReturnType<typeof vi.fn>;
  };
  let clientIp = "203.0.113.10";
  let ipSequence = 10;

  function http(method: "get" | "post" | "put", path: string) {
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

  function hashIdentity(input: AccountIdentityVerificationDto): string {
    return createHmac("sha256", process.env.HMAC_KEY ?? "")
      .update(JSON.stringify({ stage: "IDENTITY", input }))
      .digest("hex");
  }

  function hashPayout(input: PayoutVerificationDto): string {
    return createHmac("sha256", process.env.HMAC_KEY ?? "")
      .update(JSON.stringify({ stage: "PAYOUT", input }))
      .digest("hex");
  }

  function identityVerificationRequest(
    cookie: string,
    idempotencyKey: string,
    body: AccountIdentityVerificationDto = INDIVIDUAL_IDENTITY,
  ) {
    return withAuth(
      http("post", "/api/fleet-owner/onboarding/identity-verifications")
        .set("Idempotency-Key", idempotencyKey)
        .send(body),
      cookie,
    );
  }

  function payoutVerificationRequest(
    cookie: string,
    idempotencyKey: string,
    body: PayoutVerificationDto = PAYOUT_FIELDS,
  ) {
    return withAuth(
      http("post", "/api/fleet-owner/onboarding/payout-verifications")
        .set("Idempotency-Key", idempotencyKey)
        .send(body),
      cookie,
    );
  }

  function drivingCredentialsRequest(
    cookie: string,
    idempotencyKey: string,
    isOwnerDriver = "false",
  ) {
    return withAuth(
      http("put", "/api/fleet-owner/onboarding/driving-credentials")
        .set("Idempotency-Key", idempotencyKey)
        .field("isOwnerDriver", isOwnerDriver),
      cookie,
    );
  }

  function submitRequest(cookie: string, idempotencyKey: string) {
    return withAuth(
      http("post", "/api/fleet-owner/onboarding/submissions").set(
        "Idempotency-Key",
        idempotencyKey,
      ),
      cookie,
    );
  }

  beforeAll(async () => {
    premblyService = {
      verifyNin: vi.fn(),
      verifyCac: vi.fn(),
    };
    flutterwaveService = {
      resolveBankAccount: vi.fn(),
      listNigerianBanks: vi.fn(),
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
      DROP INDEX IF EXISTS "FleetOwnerAccountVerification_one_active_per_user_idx"
    `);
    await databaseService.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "FleetOwnerAccountVerification_one_active_per_user_idx"
      ON "FleetOwnerAccountVerification"("userId")
      WHERE "status" IN ('DRAFT', 'PROCESSING', 'REVIEW_REQUIRED')
    `);
    await databaseService.$executeRawUnsafe(`
      DROP INDEX IF EXISTS "FleetOwnerAccountVerificationStageRequest_one_processing_per_stage_idx"
    `);
    await databaseService.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "FleetOwnerAccountVerificationStageRequest_one_processing_per_stage_idx"
      ON "FleetOwnerAccountVerificationStageRequest"("verificationId", "stage")
      WHERE "status" = 'PROCESSING'
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
    flutterwaveService.listNigerianBanks.mockReset();

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
      steps: { contact: "PENDING" },
    });
  });

  it("GET /api/fleet-owner/banks requires authentication", async () => {
    const response = await http("get", "/api/fleet-owner/banks");

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("GET /api/fleet-owner/banks rejects a non-fleet-owner", async () => {
    const response = await http("get", "/api/fleet-owner/banks").set("Cookie", userCookie);

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("GET /api/fleet-owner/banks returns the normalized bank list for a fleet owner", async () => {
    const banks = [
      { code: "044", name: "Access Bank" },
      { code: "058", name: "GTBank" },
    ];
    flutterwaveService.listNigerianBanks.mockResolvedValueOnce(banks);

    const response = await http("get", "/api/fleet-owner/banks").set("Cookie", ownerCookie);

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toEqual(banks);
    expect(flutterwaveService.listNigerianBanks).toHaveBeenCalledOnce();
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

  it("PUT /api/fleet-owner/documents/drivers-license replaces a rejected licence during review", async () => {
    const owner = await readyOwner("acct-replace-license");
    await Promise.all([
      databaseService.fleetOwnerAccountVerification.create({
        data: {
          userId: owner.id,
          idempotencyKey: "replace-license-1",
          requestHash: "seeded-replace-license",
          accountType: "INDIVIDUAL",
          isOwnerDriver: true,
          status: "REVIEW_REQUIRED",
          processingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      }),
      databaseService.documentApproval.create({
        data: {
          userId: owner.id,
          documentType: "DRIVERS_LICENSE",
          documentUrl: "old-rejected-license.pdf",
          status: "REJECTED",
          notes: "Unreadable photo",
        },
      }),
    ]);

    const response = await withAuth(
      http("put", "/api/fleet-owner/documents/drivers-license").attach(
        "file",
        pdfDocument("replacement"),
        {
          filename: "license.pdf",
          contentType: "application/pdf",
        },
      ),
      owner.cookie,
    );

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toMatchObject({
      documentType: "DRIVERS_LICENSE",
      status: "PENDING",
    });

    const persisted = await databaseService.documentApproval.findUnique({
      where: {
        documentType_userId: { documentType: "DRIVERS_LICENSE", userId: owner.id },
      },
      select: { status: true, notes: true, documentUrl: true },
    });
    expect(persisted).toMatchObject({ status: "PENDING", notes: null });
    expect(persisted?.documentUrl).not.toBe("old-rejected-license.pdf");
  });

  it("PUT /api/fleet-owner/documents/drivers-license rejects a missing file", async () => {
    const response = await withAuth(
      http("put", "/api/fleet-owner/documents/drivers-license"),
      ownerCookie,
    );

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(response.body.errorCode).toBe("ACCOUNT_DOCUMENT_INVALID");
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
    expect(first.body.errorCode).toBe("ACCOUNT_NIN_NOT_VERIFIED");
    expect(first.body.errors).toEqual([
      {
        field: "nin",
        code: "NOT_VERIFIED",
        message: "We couldn't verify this NIN. Check the number and try again.",
      },
    ]);
    expect(second.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(second.body.errorCode).toBe("ACCOUNT_NIN_NOT_VERIFIED");
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

  it("POST /api/admin/documents/:id/approve ignores optional LASDRI when approving an owner-driver", async () => {
    const chauffeur = await factory.createUser({
      email: uniqueEmail("acct-lasdri"),
      name: "Owner Driver",
    });
    await databaseService.user.update({
      where: { id: chauffeur.id },
      data: { chauffeurApprovalStatus: "PENDING", isOwnerDriver: true },
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

  it("walks an individual non-driver through staged onboarding to approval", async () => {
    const owner = await readyOwner("acct-stage-individual");

    const before = await http("get", "/api/fleet-owner/onboarding").set("Cookie", owner.cookie);
    expect(before.body).toMatchObject({
      nextAction: "VERIFY_IDENTITY",
      steps: { identity: "PENDING", payout: "PENDING", driving: "PENDING", submission: "PENDING" },
    });

    const identity = await identityVerificationRequest(owner.cookie, "stage-individual-identity-1");
    expect(identity.status).toBe(HttpStatus.CREATED);
    expect(identity.body).toMatchObject({
      status: "VERIFIED",
      accountType: "INDIVIDUAL",
      legalName: "JOHN MIDDLE DOE",
    });
    expect(premblyService.verifyNin).toHaveBeenCalledWith("12345678901");
    expect(premblyService.verifyCac).not.toHaveBeenCalled();

    const afterIdentity = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterIdentity.body).toMatchObject({
      nextAction: "VERIFY_PAYOUT",
      identity: { status: "SUCCEEDED", legalName: "JOHN MIDDLE DOE" },
      steps: {
        contact: "VERIFIED",
        identity: "VERIFIED",
        payout: "PENDING",
        driving: "PENDING",
        submission: "PENDING",
      },
    });
    expect(afterIdentity.body.identity.status).not.toBe("DRAFT");

    const payout = await payoutVerificationRequest(owner.cookie, "stage-individual-payout-1");
    expect(payout.status).toBe(HttpStatus.CREATED);
    expect(payout.body).toMatchObject({
      status: "VERIFIED",
      bank: { accountName: "JOHN DOE", accountNumber: "******6789", nameMatch: "MATCHED" },
    });

    const afterPayout = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterPayout.body).toMatchObject({
      nextAction: "PROVIDE_DRIVING_CREDENTIALS",
      steps: { payout: "VERIFIED", driving: "PENDING", submission: "PENDING" },
    });

    const driving = await drivingCredentialsRequest(owner.cookie, "stage-individual-driving-1");
    expect(driving.status).toBe(HttpStatus.OK);
    expect(driving.body).toMatchObject({ status: "COMPLETED", isOwnerDriver: false });

    const afterDriving = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterDriving.body).toMatchObject({
      nextAction: "SUBMIT_ACCOUNT",
      steps: { driving: "COMPLETED", submission: "PENDING" },
    });

    const submitted = await submitRequest(owner.cookie, "stage-individual-submit-1");
    expect(submitted.status).toBe(HttpStatus.CREATED);
    expect(submitted.body).toMatchObject({ status: "SUCCEEDED", accountType: "INDIVIDUAL" });

    const [user, bank, verification] = await Promise.all([
      databaseService.user.findUnique({
        where: { id: owner.id },
        select: { fleetOwnerStatus: true, hasOnboarded: true, isOwnerDriver: true },
      }),
      databaseService.bankDetails.findUnique({
        where: { userId: owner.id },
        select: { isVerified: true },
      }),
      databaseService.fleetOwnerAccountVerification.findFirst({
        where: { userId: owner.id },
        orderBy: { createdAt: "desc" },
        select: {
          status: true,
          identityVerifiedAt: true,
          payoutVerifiedAt: true,
          drivingCompletedAt: true,
          submittedAt: true,
        },
      }),
    ]);
    expect(user).toMatchObject({
      fleetOwnerStatus: "APPROVED",
      hasOnboarded: true,
      isOwnerDriver: false,
    });
    expect(bank?.isVerified).toBe(true);
    expect(verification).toMatchObject({ status: "SUCCEEDED" });
    expect(verification?.identityVerifiedAt).toBeInstanceOf(Date);
    expect(verification?.payoutVerifiedAt).toBeInstanceOf(Date);
    expect(verification?.drivingCompletedAt).toBeInstanceOf(Date);
    expect(verification?.submittedAt).toBeInstanceOf(Date);

    const afterSubmit = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterSubmit.body).toMatchObject({
      status: "VERIFIED",
      nextAction: "COMPLETE",
      steps: { submission: "VERIFIED" },
    });
  });

  it("verifies a business identity, skips driving, then submits after payout", async () => {
    const owner = await readyOwner("acct-stage-business");
    premblyService.verifyCac.mockResolvedValue({
      businessName: "HYRE MOBILITY LTD",
      registrationNumber: "RC123456",
      registrationType: "RC",
      status: "ACTIVE",
      directors: [{ firstName: "JOHN", middleName: null, lastName: "DOE" }],
      reference: "cac-ref",
    });
    flutterwaveService.resolveBankAccount.mockResolvedValue({
      accountNumber: ACCOUNT_NUMBER,
      accountName: "HYRE MOBILITY LIMITED",
      bankCode: "058",
    });

    const identity = await identityVerificationRequest(
      owner.cookie,
      "stage-business-identity-1",
      BUSINESS_IDENTITY,
    );
    expect(identity.status).toBe(HttpStatus.CREATED);
    expect(identity.body).toMatchObject({
      status: "VERIFIED",
      accountType: "BUSINESS",
      businessName: "HYRE MOBILITY LTD",
    });
    expect(premblyService.verifyCac).toHaveBeenCalledWith(
      "RC123456",
      "RC",
      "Hyre Mobility Limited",
    );

    const afterIdentity = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterIdentity.body).toMatchObject({
      nextAction: "VERIFY_PAYOUT",
      identity: { status: "SUCCEEDED" },
      steps: { identity: "VERIFIED", driving: "SKIPPED", payout: "PENDING" },
    });

    const payout = await payoutVerificationRequest(owner.cookie, "stage-business-payout-1");
    expect(payout.status).toBe(HttpStatus.CREATED);
    expect(payout.body.bank.nameMatch).toBe("MATCHED");

    const afterPayout = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterPayout.body).toMatchObject({
      nextAction: "SUBMIT_ACCOUNT",
      steps: { driving: "SKIPPED", payout: "VERIFIED" },
    });

    const submitted = await submitRequest(owner.cookie, "stage-business-submit-1");
    expect(submitted.status).toBe(HttpStatus.CREATED);
    expect(submitted.body).toMatchObject({ status: "SUCCEEDED", accountType: "BUSINESS" });
  });

  it("keeps hard identity, payout, and driving failures on the current stage", async () => {
    const owner = await readyOwner("acct-stage-hard-fail");
    premblyService.verifyNin.mockRejectedValueOnce(new PremblyError("REJECTED"));

    const rejectedNin = await identityVerificationRequest(owner.cookie, "stage-fail-nin-1");
    expect(rejectedNin.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(rejectedNin.body.errorCode).toBe("ACCOUNT_NIN_NOT_VERIFIED");

    premblyService.verifyNin.mockResolvedValueOnce({
      firstName: "JOHN",
      middleName: "MIDDLE",
      lastName: "DOE",
      reference: "nin-ref",
    });
    const identity = await identityVerificationRequest(owner.cookie, "stage-fail-identity-2");
    expect(identity.status).toBe(HttpStatus.CREATED);

    flutterwaveService.resolveBankAccount.mockRejectedValueOnce(
      new FlutterwaveError("Account not found", "ACCOUNT_NOT_FOUND", 404),
    );
    const unresolved = await payoutVerificationRequest(owner.cookie, "stage-fail-payout-1");
    expect(unresolved.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(unresolved.body.errorCode).toBe("BANK_ACCOUNT_UNRESOLVED");

    flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
      accountNumber: ACCOUNT_NUMBER,
      accountName: "JANE SMITH",
      bankCode: "058",
    });
    const mismatch = await payoutVerificationRequest(owner.cookie, "stage-fail-payout-2");
    expect(mismatch.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(mismatch.body.errorCode).toBe("BANK_ACCOUNT_NAME_MISMATCH");

    const draft = await databaseService.fleetOwnerAccountVerification.findFirst({
      where: { userId: owner.id, status: "DRAFT" },
      select: { status: true, identityVerifiedAt: true, payoutVerifiedAt: true },
    });
    expect(draft).toMatchObject({ status: "DRAFT" });
    expect(draft?.identityVerifiedAt).toBeInstanceOf(Date);
    expect(draft?.payoutVerifiedAt).toBeNull();

    flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
      accountNumber: ACCOUNT_NUMBER,
      accountName: "JOHN DOE",
      bankCode: "058",
    });
    const payout = await payoutVerificationRequest(owner.cookie, "stage-fail-payout-3");
    expect(payout.status).toBe(HttpStatus.CREATED);

    const missingLicense = await drivingCredentialsRequest(
      owner.cookie,
      "stage-fail-driving-1",
      "true",
    );
    expect(missingLicense.status).toBe(HttpStatus.BAD_REQUEST);
    expect(missingLicense.body.errorCode).toBe("OWNER_DRIVER_LICENSE_REQUIRED");
    const stillDraft = await databaseService.fleetOwnerAccountVerification.findFirst({
      where: { userId: owner.id, status: "DRAFT" },
      select: { drivingCompletedAt: true },
    });
    expect(stillDraft?.drivingCompletedAt).toBeNull();
  });

  it("enforces staged prerequisites before payout, driving, and submit", async () => {
    const owner = await readyOwner("acct-stage-prereq");

    const payoutFirst = await payoutVerificationRequest(owner.cookie, "stage-prereq-payout-1");
    expect(payoutFirst.status).toBe(HttpStatus.NOT_FOUND);
    expect(payoutFirst.body.errorCode).toBe("ACCOUNT_VERIFICATION_NOT_FOUND");

    const drivingFirst = await drivingCredentialsRequest(owner.cookie, "stage-prereq-driving-1");
    expect(drivingFirst.status).toBe(HttpStatus.NOT_FOUND);

    const submitFirst = await submitRequest(owner.cookie, "stage-prereq-submit-1");
    expect(submitFirst.status).toBe(HttpStatus.NOT_FOUND);

    const identity = await identityVerificationRequest(owner.cookie, "stage-prereq-identity-1");
    expect(identity.status).toBe(HttpStatus.CREATED);

    const drivingBeforePayout = await drivingCredentialsRequest(
      owner.cookie,
      "stage-prereq-driving-2",
    );
    expect(drivingBeforePayout.status).toBe(HttpStatus.CONFLICT);
    expect(drivingBeforePayout.body.errorCode).toBe("ACCOUNT_VERIFICATION_STEP_INCOMPLETE");

    const submitBeforePayout = await submitRequest(owner.cookie, "stage-prereq-submit-2");
    expect(submitBeforePayout.status).toBe(HttpStatus.CONFLICT);
    expect(submitBeforePayout.body.errorCode).toBe("ACCOUNT_VERIFICATION_STEP_INCOMPLETE");

    const payout = await payoutVerificationRequest(owner.cookie, "stage-prereq-payout-2");
    expect(payout.status).toBe(HttpStatus.CREATED);

    const submitBeforeDriving = await submitRequest(owner.cookie, "stage-prereq-submit-3");
    expect(submitBeforeDriving.status).toBe(HttpStatus.CONFLICT);
    expect(submitBeforeDriving.body.errorCode).toBe("ACCOUNT_VERIFICATION_STEP_INCOMPLETE");
  });

  it("replays staged idempotency keys, rejects changed payloads, and returns Retry-After", async () => {
    const owner = await readyOwner("acct-stage-idem");

    const firstIdentity = await identityVerificationRequest(owner.cookie, "stage-idem-identity-1");
    const replayIdentity = await identityVerificationRequest(owner.cookie, "stage-idem-identity-1");
    expect(firstIdentity.status).toBe(HttpStatus.CREATED);
    expect(replayIdentity.status).toBe(HttpStatus.CREATED);
    expect(replayIdentity.body).toEqual(firstIdentity.body);
    expect(premblyService.verifyNin).toHaveBeenCalledTimes(1);

    const changedIdentity = await identityVerificationRequest(
      owner.cookie,
      "stage-idem-identity-1",
      {
        accountType: "INDIVIDUAL",
        nin: "10987654321",
      },
    );
    expect(changedIdentity.status).toBe(HttpStatus.CONFLICT);
    expect(changedIdentity.body.errorCode).toBe("VERIFICATION_IDEMPOTENCY_KEY_REUSED");

    const firstPayout = await payoutVerificationRequest(owner.cookie, "stage-idem-payout-1");
    const replayPayout = await payoutVerificationRequest(owner.cookie, "stage-idem-payout-1");
    expect(firstPayout.status).toBe(HttpStatus.CREATED);
    expect(replayPayout.body).toEqual(firstPayout.body);
    expect(flutterwaveService.resolveBankAccount).toHaveBeenCalledTimes(1);

    const changedPayout = await payoutVerificationRequest(owner.cookie, "stage-idem-payout-1", {
      ...PAYOUT_FIELDS,
      accountNumber: "9876543210",
    });
    expect(changedPayout.status).toBe(HttpStatus.CONFLICT);
    expect(changedPayout.body.errorCode).toBe("VERIFICATION_IDEMPOTENCY_KEY_REUSED");

    const verification = await databaseService.fleetOwnerAccountVerification.findFirst({
      where: { userId: owner.id, status: "DRAFT" },
      select: { id: true },
    });
    if (!verification) {
      throw new Error("Expected a DRAFT account verification after payout replay");
    }
    await databaseService.fleetOwnerAccountVerificationStageRequest.create({
      data: {
        verificationId: verification.id,
        stage: "PAYOUT",
        idempotencyKey: "stage-idem-payout-in-progress-1",
        requestHash: hashPayout(PAYOUT_FIELDS),
        status: "PROCESSING",
        processingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const payoutInProgress = await payoutVerificationRequest(
      owner.cookie,
      "stage-idem-payout-in-progress-1",
    );
    expect(payoutInProgress.status).toBe(HttpStatus.CONFLICT);
    expect(payoutInProgress.body.errorCode).toBe("VERIFICATION_REQUEST_IN_PROGRESS");
    expect(payoutInProgress.headers["retry-after"]).toBe("5");

    const inProgressOwner = await readyOwner("acct-stage-idem-progress");
    await databaseService.fleetOwnerAccountVerification.create({
      data: {
        userId: inProgressOwner.id,
        idempotencyKey: "stage-idem-identity-in-progress-1",
        requestHash: hashIdentity(INDIVIDUAL_IDENTITY),
        accountType: "INDIVIDUAL",
        status: "PROCESSING",
        processingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const identityInProgress = await identityVerificationRequest(
      inProgressOwner.cookie,
      "stage-idem-identity-in-progress-1",
    );
    expect(identityInProgress.status).toBe(HttpStatus.CONFLICT);
    expect(identityInProgress.body.errorCode).toBe("VERIFICATION_REQUEST_IN_PROGRESS");
    expect(identityInProgress.headers["retry-after"]).toBe("5");
  });

  it("requires a fleet-owner session, validation, and Idempotency-Key on staged endpoints", async () => {
    const unauthenticated = await http(
      "post",
      "/api/fleet-owner/onboarding/identity-verifications",
    ).send(INDIVIDUAL_IDENTITY);
    const forbidden = await identityVerificationRequest(userCookie, "stage-auth-identity-1");
    const missingKey = await http("post", "/api/fleet-owner/onboarding/identity-verifications")
      .set("Cookie", ownerCookie)
      .send(INDIVIDUAL_IDENTITY);
    const invalidBody = await identityVerificationRequest(ownerCookie, "stage-auth-invalid-1", {
      accountType: "INDIVIDUAL",
      nin: "123",
    });

    expect(unauthenticated.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);
    expect(missingKey.status).toBe(HttpStatus.BAD_REQUEST);
    expect(invalidBody.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("surfaces REVIEW_REQUIRED identity and payout on GET onboarding before submit", async () => {
    const owner = await readyOwner("acct-stage-review-steps");
    premblyService.verifyCac.mockResolvedValueOnce({
      businessName: "HYRE MOBILITY LTD",
      registrationNumber: "RC123456",
      registrationType: "RC",
      status: null,
      directors: [{ firstName: "JANE", middleName: null, lastName: "SMITH" }],
      reference: "cac-ref",
    });

    const identity = await identityVerificationRequest(
      owner.cookie,
      "stage-review-identity-1",
      BUSINESS_IDENTITY,
    );
    expect(identity.status).toBe(HttpStatus.CREATED);
    expect(identity.body.status).toBe("REVIEW_REQUIRED");

    const afterIdentity = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterIdentity.body).toMatchObject({
      nextAction: "VERIFY_PAYOUT",
      identity: { status: "REVIEW_REQUIRED" },
      steps: { identity: "REVIEW_REQUIRED", driving: "SKIPPED" },
    });

    flutterwaveService.resolveBankAccount.mockResolvedValueOnce({
      accountNumber: ACCOUNT_NUMBER,
      accountName: "HYRE MOBILITY SERVICES LIMITED",
      bankCode: "058",
    });
    const payout = await payoutVerificationRequest(owner.cookie, "stage-review-payout-1");
    expect(payout.status).toBe(HttpStatus.CREATED);
    expect(payout.body.status).toBe("REVIEW_REQUIRED");

    const afterPayout = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterPayout.body).toMatchObject({
      nextAction: "SUBMIT_ACCOUNT",
      steps: { payout: "REVIEW_REQUIRED", driving: "SKIPPED", submission: "PENDING" },
    });

    const submitted = await submitRequest(owner.cookie, "stage-review-submit-1");
    expect(submitted.status).toBe(HttpStatus.CREATED);
    expect(submitted.body.status).toBe("REVIEW_REQUIRED");

    const afterSubmit = await http("get", "/api/fleet-owner/onboarding").set(
      "Cookie",
      owner.cookie,
    );
    expect(afterSubmit.body).toMatchObject({
      status: "UNDER_REVIEW",
      nextAction: "WAIT_FOR_REVIEW",
      identity: { status: "REVIEW_REQUIRED" },
      steps: { identity: "REVIEW_REQUIRED", submission: "REVIEW_REQUIRED" },
    });
  });

  it("blocks payout after identity when phone verification is revoked", async () => {
    const owner = await readyOwner("acct-stage-phone-revoked");
    const identity = await identityVerificationRequest(
      owner.cookie,
      "stage-phone-revoked-identity-1",
    );
    expect(identity.status).toBe(HttpStatus.CREATED);

    await databaseService.user.update({
      where: { id: owner.id },
      data: { phoneVerifiedAt: null },
    });

    const payout = await payoutVerificationRequest(owner.cookie, "stage-phone-revoked-payout-1");
    expect(payout.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(payout.body.errorCode).toBe("ACCOUNT_PHONE_NOT_VERIFIED");
    expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
  });

  it("rejects a different payout key while another payout is processing", async () => {
    const owner = await readyOwner("acct-stage-payout-collision");
    const identity = await identityVerificationRequest(owner.cookie, "stage-collision-identity-1");
    expect(identity.status).toBe(HttpStatus.CREATED);

    const verification = await databaseService.fleetOwnerAccountVerification.findFirst({
      where: { userId: owner.id, status: "DRAFT" },
      select: { id: true },
    });
    if (!verification) {
      throw new Error("Expected a DRAFT account verification after identity");
    }
    await databaseService.fleetOwnerAccountVerificationStageRequest.create({
      data: {
        verificationId: verification.id,
        stage: "PAYOUT",
        idempotencyKey: "stage-collision-payout-a",
        requestHash: hashPayout(PAYOUT_FIELDS),
        status: "PROCESSING",
        processingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const payout = await payoutVerificationRequest(owner.cookie, "stage-collision-payout-b");
    expect(payout.status).toBe(HttpStatus.CONFLICT);
    expect(payout.body.errorCode).toBe("VERIFICATION_REQUEST_IN_PROGRESS");
    expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
  });

  it("fails an expired same-key PROCESSING payout as ACCOUNT_VERIFICATION_CHANGED", async () => {
    const owner = await readyOwner("acct-stage-payout-expired");
    const identity = await identityVerificationRequest(owner.cookie, "stage-expired-identity-1");
    expect(identity.status).toBe(HttpStatus.CREATED);

    const verification = await databaseService.fleetOwnerAccountVerification.findFirst({
      where: { userId: owner.id, status: "DRAFT" },
      select: { id: true },
    });
    if (!verification) {
      throw new Error("Expected a DRAFT account verification after identity");
    }
    await databaseService.fleetOwnerAccountVerificationStageRequest.create({
      data: {
        verificationId: verification.id,
        stage: "PAYOUT",
        idempotencyKey: "stage-expired-payout-1",
        requestHash: hashPayout(PAYOUT_FIELDS),
        status: "PROCESSING",
        processingExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const payout = await payoutVerificationRequest(owner.cookie, "stage-expired-payout-1");
    expect(payout.status).toBe(HttpStatus.CONFLICT);
    expect(payout.body.errorCode).toBe("ACCOUNT_VERIFICATION_CHANGED");
    expect(flutterwaveService.resolveBankAccount).not.toHaveBeenCalled();
  });
});
