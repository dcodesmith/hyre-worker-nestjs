import { randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { EmailService } from "../src/modules/email/email.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

describe("Chauffeur capacity hold", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let factory: TestDataFactory;
  let cookie: string;
  let ownerId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: vi.fn().mockResolvedValue(undefined) })
      .overrideProvider(EmailService)
      .useValue({ sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    databaseService = app.get(DatabaseService);
    factory = new TestDataFactory(databaseService, app);
    await app.init();
    await factory.createPlatformRates();

    const owner = await factory.createFleetOwner({
      isOwnerDriver: true,
      chauffeurApprovalStatus: "APPROVED",
    });
    ownerId = owner.id;
    const user = await factory.authenticateAndGetUser(uniqueEmail("capacity-hold"), "user");
    cookie = user.cookie;

    vi.spyOn(app.get(FlutterwaveService), "createPaymentIntent").mockResolvedValue({
      paymentIntentId: "flw_pi_capacity",
      checkoutUrl: "https://checkout.flutterwave.com/pay/capacity",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("lets only one of two overlapping bookings succeed when two cars share one chauffeur", async () => {
    const [carA, carB] = await Promise.all([
      factory.createCar(ownerId, { registrationNumber: `CAP-A-${randomUUID()}` }),
      factory.createCar(ownerId, { registrationNumber: `CAP-B-${randomUUID()}` }),
    ]);
    const window = {
      startDate: "2027-06-01T00:00:00.000Z",
      endDate: "2027-06-01T12:00:00.000Z",
      pickupAddress: "123 Main St, Lagos",
      bookingType: "DAY" as const,
      pickupTime: "9:00 AM",
      sameLocation: true,
      requiresFullTank: false,
      useCredits: 0,
    };
    const preview = await request(app.getHttpServer())
      .post("/api/bookings/pricing-preview")
      .set("Cookie", cookie)
      .send({ ...window, carId: carA.id });
    expect(preview.status).toBe(HttpStatus.OK);

    const send = (carId: string) =>
      request(app.getHttpServer())
        .post("/api/bookings")
        .set("Cookie", cookie)
        .set("Idempotency-Key", randomUUID())
        .send({
          ...window,
          carId,
          expectedTotalAmount: String(preview.body.totalAmount),
        });

    const responses = await Promise.all([send(carA.id), send(carB.id)]);
    const created = responses.filter((response) => response.status === HttpStatus.CREATED);
    const rejected = responses.filter((response) => response.status === HttpStatus.CONFLICT);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.body.errorCode).toBe("CAR_NOT_AVAILABLE");

    const held = await databaseService.booking.findMany({
      where: { chauffeurId: ownerId, carId: { in: [carA.id, carB.id] } },
      select: { id: true, status: true, chauffeurId: true },
    });
    expect(held).toEqual([
      {
        id: created[0]?.body.bookingId,
        status: "PENDING",
        chauffeurId: ownerId,
      },
    ]);
  });
});
