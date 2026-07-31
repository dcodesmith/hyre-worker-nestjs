import { HttpStatus, type INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Admin Financial Operations E2E Tests", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let adminUserId: string;
  let staffCookie: string;
  let customerCookie: string;
  let refundPaymentId: string;
  let payoutTransactionId: string;

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
    await app.init();

    databaseService = app.get(DatabaseService);
    flutterwaveService = app.get(FlutterwaveService);
    factory = new TestDataFactory(databaseService, app);

    const admin = await factory.createAuthenticatedAdmin(uniqueEmail("financial-admin"));
    adminCookie = admin.cookie;
    adminUserId = admin.user.id;

    const staff = await factory.authenticateAndGetUser(uniqueEmail("financial-staff"), "user");
    await factory.assignRole(staff.user.id, "staff");
    staffCookie = staff.cookie;

    const customer = await factory.authenticateAndGetUser(
      uniqueEmail("financial-customer"),
      "user",
    );
    customerCookie = customer.cookie;
    const fleetOwner = await factory.createFleetOwner();
    const car = await factory.createCar(fleetOwner.id);

    const refundBooking = await factory.createBooking(customer.user.id, car.id, {
      paymentStatus: "REFUND_PROCESSING",
    });
    const refundPayment = await factory.createPayment(refundBooking.id, {
      amountCharged: 50000,
      status: "REFUND_ERROR",
      flutterwaveTransactionId: "41001",
      refundProviderId: "41002",
      refundProviderStatus: "processing",
      refundRequestedAmount: 50000,
      refundRequestedAt: new Date(Date.now() - 30 * 60 * 1000),
      refundManualReviewNotifiedAt: new Date(),
    });
    refundPaymentId = refundPayment.id;

    const payoutBooking = await factory.createBooking(customer.user.id, car.id, {
      status: "COMPLETED",
      overallPayoutStatus: "PROCESSING",
    });
    const payout = await factory.createPayoutTransaction(fleetOwner.id, {
      bookingId: payoutBooking.id,
      status: "PROCESSING",
      payoutProviderReference: `payout-${payoutBooking.id}`,
      initiatedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    payoutTransactionId = payout.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("enforces read and reconcile roles", async () => {
    const unauthenticatedResponse = await request(app.getHttpServer())
      .get("/api/admin/financial-operations/refunds")
      .then((response) => response);
    expect(unauthenticatedResponse.status).toBe(HttpStatus.UNAUTHORIZED);

    const customerResponse = await request(app.getHttpServer())
      .get("/api/admin/financial-operations/refunds")
      .set("Cookie", customerCookie);
    expect(customerResponse.status).toBe(HttpStatus.FORBIDDEN);

    const staffResponse = await request(app.getHttpServer())
      .get("/api/admin/financial-operations/refunds")
      .set("Cookie", staffCookie);
    expect(staffResponse.status).toBe(HttpStatus.OK);

    const staffReconcileResponse = await request(app.getHttpServer())
      .post(`/api/admin/financial-operations/refunds/${refundPaymentId}/reconcile`)
      .set("Cookie", staffCookie)
      .send({});
    expect(staffReconcileResponse.status).toBe(HttpStatus.FORBIDDEN);
  });

  it("lists refund and payout attention queues", async () => {
    const refundResponse = await request(app.getHttpServer())
      .get("/api/admin/financial-operations/refunds")
      .set("Cookie", adminCookie)
      .expect(HttpStatus.OK);
    expect(refundResponse.body.refunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: refundPaymentId, status: "REFUND_ERROR" }),
      ]),
    );
    expect(refundResponse.body.meta).toMatchObject({ page: 1, limit: 20 });

    const payoutResponse = await request(app.getHttpServer())
      .get("/api/admin/financial-operations/payouts?status=PROCESSING")
      .set("Cookie", adminCookie)
      .expect(HttpStatus.OK);
    expect(payoutResponse.body.payouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: payoutTransactionId, status: "PROCESSING" }),
      ]),
    );
    expect(payoutResponse.body.meta).toMatchObject({ page: 1, limit: 20 });

    const refundDetail = await request(app.getHttpServer())
      .get(`/api/admin/financial-operations/refunds/${refundPaymentId}`)
      .set("Cookie", staffCookie)
      .expect(HttpStatus.OK);
    expect(refundDetail.body).toMatchObject({
      id: refundPaymentId,
      audits: [],
    });

    const payoutDetail = await request(app.getHttpServer())
      .get(`/api/admin/financial-operations/payouts/${payoutTransactionId}`)
      .set("Cookie", staffCookie)
      .expect(HttpStatus.OK);
    expect(payoutDetail.body).toMatchObject({
      id: payoutTransactionId,
      audits: [],
    });
  });

  it("verifies and finalizes a refund with a durable admin audit", async () => {
    vi.spyOn(flutterwaveService, "fetchRefund").mockResolvedValueOnce({
      id: 41002,
      amount_refunded: 50000,
      status: "completed-preauth",
      flw_ref: "FLW-REF-41001",
      comment: null,
      settlement_id: "NEW",
      meta: {},
      created_at: new Date().toISOString(),
      account_id: 123,
      transaction_id: 41001,
    });

    const response = await request(app.getHttpServer())
      .post(`/api/admin/financial-operations/refunds/${refundPaymentId}/reconcile`)
      .set("Cookie", adminCookie)
      .send({})
      .expect(HttpStatus.OK);

    expect(response.body).toMatchObject({
      reconciled: true,
      status: "REFUNDED",
      providerStatus: "completed-preauth",
    });
    const payment = await databaseService.payment.findUniqueOrThrow({
      where: { id: refundPaymentId },
    });
    expect(payment.status).toBe("REFUNDED");
    await expect(
      databaseService.financialReconciliationAudit.findFirst({
        where: {
          resourceId: refundPaymentId,
          actorUserId: adminUserId,
          outcome: "RECONCILED",
        },
      }),
    ).resolves.not.toBeNull();

    await request(app.getHttpServer())
      .post(`/api/admin/financial-operations/refunds/${refundPaymentId}/reconcile`)
      .set("Cookie", adminCookie)
      .send({})
      .expect(HttpStatus.CONFLICT);
    await expect(
      databaseService.financialReconciliationAudit.count({
        where: { resourceId: refundPaymentId },
      }),
    ).resolves.toBe(1);
  });

  it("verifies and finalizes a payout without re-initiating it", async () => {
    const persistedPayout = await databaseService.payoutTransaction.findUniqueOrThrow({
      where: { id: payoutTransactionId },
    });
    if (!persistedPayout.payoutProviderReference) {
      throw new Error("Test payout provider reference is missing");
    }
    vi.spyOn(flutterwaveService, "findTransferByReference").mockResolvedValueOnce({
      id: 42001,
      account_number: "1234567890",
      bank_code: "044",
      full_name: "Test Account",
      created_at: new Date().toISOString(),
      currency: "NGN",
      debit_currency: "NGN",
      amount: 45000,
      fee: 0,
      status: "SUCCESSFUL",
      reference: persistedPayout.payoutProviderReference,
      meta: {},
      narration: "Payout",
      complete_message: "Successful",
      requires_approval: 0,
      is_approved: 1,
      bank_name: "Access Bank",
    });

    const response = await request(app.getHttpServer())
      .post(`/api/admin/financial-operations/payouts/${payoutTransactionId}/reconcile`)
      .set("Cookie", adminCookie)
      .expect(HttpStatus.OK);

    expect(response.body).toMatchObject({
      reconciled: true,
      status: "PAID_OUT",
      providerStatus: "SUCCESSFUL",
      payout: {
        amountPaid: 45000,
      },
    });
    const payout = await databaseService.payoutTransaction.findUniqueOrThrow({
      where: { id: payoutTransactionId },
    });
    expect(payout.status).toBe("PAID_OUT");
    await expect(
      databaseService.financialReconciliationAudit.findFirst({
        where: {
          resourceId: payoutTransactionId,
          actorUserId: adminUserId,
          outcome: "RECONCILED",
        },
      }),
    ).resolves.not.toBeNull();

    await request(app.getHttpServer())
      .post(`/api/admin/financial-operations/payouts/${payoutTransactionId}/reconcile`)
      .set("Cookie", adminCookie)
      .expect(HttpStatus.CONFLICT);
    await expect(
      databaseService.financialReconciliationAudit.count({
        where: { resourceId: payoutTransactionId },
      }),
    ).resolves.toBe(1);
  });
});
