import { randomUUID } from "node:crypto";
import { HttpStatus, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthEmailService } from "../src/modules/auth/auth-email.service";
import { DatabaseService } from "../src/modules/database/database.service";
import { EmailService } from "../src/modules/email/email.service";
import { FlutterwaveService } from "../src/modules/flutterwave/flutterwave.service";
import { TestDataFactory, uniqueEmail } from "./helpers";

const ONE_DAY_MS = 86400000;

function futureWindow(dayOffset = 8) {
  const startDate = new Date(Date.now() + dayOffset * ONE_DAY_MS);
  startDate.setHours(9, 0, 0, 0);
  const endDate = new Date(startDate.getTime() + 12 * 60 * 60 * 1000);
  return { startDate, endDate };
}

describe("Add-ons E2E", () => {
  let app: INestApplication;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let factory: TestDataFactory;
  let adminCookie: string;
  let adminUserId: string;
  let staffCookie: string;
  let userCookie: string;
  let fleetOwnerId: string;
  let carId: string;

  beforeAll(async () => {
    const emailService = { sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }) };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthEmailService)
      .useValue({ sendOTPEmail: async () => undefined })
      .overrideProvider(EmailService)
      .useValue(emailService)
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    await app.init();

    databaseService = app.get(DatabaseService);
    flutterwaveService = app.get(FlutterwaveService);
    factory = new TestDataFactory(databaseService, app);

    const admin = await factory.createAuthenticatedAdmin(uniqueEmail("addons-admin"));
    adminCookie = admin.cookie;
    adminUserId = admin.user.id;
    staffCookie = (await factory.createAuthenticatedStaff(uniqueEmail("addons-staff"))).cookie;
    userCookie = (await factory.authenticateAndGetUser(uniqueEmail("addons-user"), "user")).cookie;
    fleetOwnerId = (await factory.createFleetOwner()).id;
    await factory.createPlatformRates();
  });

  beforeEach(async () => {
    await factory.clearRateLimits();
    carId = (await factory.createCar(fleetOwnerId)).id;
    vi.spyOn(flutterwaveService, "createPaymentIntent").mockResolvedValue({
      paymentIntentId: "flw_pi_addons",
      checkoutUrl: "https://checkout.flutterwave.com/pay/addons",
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe("GET /api/addons", () => {
    it("returns only currently priced, active add-ons for the requested booking type", async () => {
      const visible = await factory.createAddon(adminUserId, {
        code: `VISIBLE_DAY_${Date.now()}`,
        name: "Visible Day Add-on",
        bookingTypes: ["DAY"],
        amount: 8000,
      });
      const nightOnly = await factory.createAddon(adminUserId, {
        code: `NIGHT_ONLY_${Date.now()}`,
        bookingTypes: ["NIGHT"],
      });
      const inactive = await factory.createAddon(adminUserId, {
        code: `INACTIVE_${Date.now()}`,
        isActive: false,
      });
      const noPrice = await factory.createAddon(adminUserId, {
        code: `NO_PRICE_${Date.now()}`,
        skipPrice: true,
      });
      const ended = await factory.createAddon(adminUserId, {
        code: `ENDED_${Date.now()}`,
        effectiveSince: new Date("2020-01-01"),
        effectiveUntil: new Date("2021-01-01"),
      });

      const missingType = await request(app.getHttpServer())
        .get("/api/addons")
        .set("Accept", "application/json");
      expect(missingType.status).toBe(HttpStatus.BAD_REQUEST);

      const response = await request(app.getHttpServer()).get("/api/addons").query({
        bookingType: "DAY",
      });
      expect(response.status).toBe(HttpStatus.OK);
      const ids = response.body.addons.map((addon: { id: string }) => addon.id);
      expect(ids).toContain(visible.id);
      expect(ids).not.toContain(nightOnly.id);
      expect(ids).not.toContain(inactive.id);
      expect(ids).not.toContain(noPrice.id);
      expect(ids).not.toContain(ended.id);
      expect(response.body.addons.find((addon: { id: string }) => addon.id === visible.id)).toEqual(
        expect.objectContaining({
          id: visible.id,
          code: visible.code,
          unitPrice: 8000,
          currency: "NGN",
        }),
      );
    });
  });

  describe("Admin and staff catalog management", () => {
    it("rejects unauthenticated and non-privileged users", async () => {
      const unauthenticated = await request(app.getHttpServer())
        .get("/api/admin/addons")
        .set("Accept", "application/json");
      expect(unauthenticated.status).toBe(HttpStatus.UNAUTHORIZED);

      const forbidden = await request(app.getHttpServer())
        .get("/api/admin/addons")
        .set("Cookie", userCookie);
      expect(forbidden.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("lets an admin create, update, price, and end an add-on", async () => {
      const code = `ADMIN_WIFI_${Date.now()}`;
      const created = await request(app.getHttpServer())
        .post("/api/admin/addons")
        .set("Cookie", adminCookie)
        .send({
          code,
          name: "Admin Wi-Fi",
          bookingTypes: ["DAY", "NIGHT"],
          pricingUnit: "PER_BOOKING",
          financialTreatment: "PLATFORM",
        });
      expect(created.status).toBe(HttpStatus.CREATED);
      expect(created.body.code).toBe(code);

      const duplicate = await request(app.getHttpServer())
        .post("/api/admin/addons")
        .set("Cookie", adminCookie)
        .send({
          code,
          name: "Duplicate Wi-Fi",
          bookingTypes: ["DAY"],
          pricingUnit: "PER_BOOKING",
          financialTreatment: "PLATFORM",
        });
      expect(duplicate.status).toBe(HttpStatus.CONFLICT);
      expect(duplicate.body.errorCode).toBe("ADDON_CODE_CONFLICT");

      const updated = await request(app.getHttpServer())
        .patch(`/api/admin/addons/${created.body.id}`)
        .set("Cookie", adminCookie)
        .send({ name: "Admin Wi-Fi Plus" });
      expect(updated.status).toBe(HttpStatus.OK);
      expect(updated.body.name).toBe("Admin Wi-Fi Plus");

      const price = await request(app.getHttpServer())
        .post(`/api/admin/addons/${created.body.id}/prices`)
        .set("Cookie", adminCookie)
        .send({ amount: 12000, effectiveSince: "2026-01-01T00:00:00.000Z" });
      expect(price.status).toBe(HttpStatus.CREATED);
      expect(price.body.amount).toBe(12000);

      const overlapping = await request(app.getHttpServer())
        .post(`/api/admin/addons/${created.body.id}/prices`)
        .set("Cookie", adminCookie)
        .send({ amount: 13000, effectiveSince: "2026-02-01T00:00:00.000Z" });
      expect(overlapping.status).toBe(HttpStatus.CONFLICT);
      expect(overlapping.body.errorCode).toBe("ADDON_PRICE_OVERLAP");

      const ended = await request(app.getHttpServer())
        .patch(`/api/admin/addons/${created.body.id}/prices/${price.body.id}/end`)
        .set("Cookie", adminCookie);
      expect(ended.status).toBe(HttpStatus.OK);
      expect(ended.body.effectiveUntil).toEqual(expect.any(String));

      const alreadyEnded = await request(app.getHttpServer())
        .patch(`/api/admin/addons/${created.body.id}/prices/${price.body.id}/end`)
        .set("Cookie", adminCookie);
      expect(alreadyEnded.status).toBe(HttpStatus.CONFLICT);
      expect(alreadyEnded.body.errorCode).toBe("ADDON_PRICE_CANNOT_END");
    });

    it("lets staff list and mutate add-ons", async () => {
      const listed = await request(app.getHttpServer())
        .get("/api/admin/addons")
        .set("Cookie", staffCookie);
      expect(listed.status).toBe(HttpStatus.OK);
      expect(listed.body).toHaveProperty("addons");

      const created = await request(app.getHttpServer())
        .post("/api/admin/addons")
        .set("Cookie", staffCookie)
        .send({
          code: `STAFF_GPS_${Date.now()}`,
          name: "Staff GPS",
          bookingTypes: ["DAY"],
          pricingUnit: "PER_BOOKING",
          financialTreatment: "PLATFORM",
        });
      expect(created.status).toBe(HttpStatus.CREATED);
    });

    it("rejects ending a future price", async () => {
      const addon = await factory.createAddon(adminUserId, {
        code: `FUTURE_PRICE_${Date.now()}`,
        skipPrice: true,
      });
      const futureSince = new Date(Date.now() + 14 * ONE_DAY_MS);
      const price = await request(app.getHttpServer())
        .post(`/api/admin/addons/${addon.id}/prices`)
        .set("Cookie", adminCookie)
        .send({ amount: 9000, effectiveSince: futureSince.toISOString() });
      expect(price.status).toBe(HttpStatus.CREATED);

      const ended = await request(app.getHttpServer())
        .patch(`/api/admin/addons/${addon.id}/prices/${price.body.id}/end`)
        .set("Cookie", adminCookie);
      expect(ended.status).toBe(HttpStatus.CONFLICT);
      expect(ended.body.errorCode).toBe("ADDON_PRICE_CANNOT_END");
    });
  });

  describe("Booking preview and create", () => {
    it("keeps preview and create totals consistent for a platform add-on", async () => {
      const addon = await factory.createAddon(adminUserId, {
        code: `PLATFORM_WIFI_${Date.now()}`,
        name: "Wi-Fi Hotspot",
        pricingUnit: "PER_BOOKING",
        financialTreatment: "PLATFORM",
        amount: 10000,
      });
      const { startDate, endDate } = futureWindow(12);
      const previewPayload = {
        carId,
        bookingType: "DAY",
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        pickupTime: "9:00 AM",
        addonIds: [addon.id],
        requiresFullTank: false,
      };

      const preview = await request(app.getHttpServer())
        .post("/api/bookings/pricing-preview")
        .set("Cookie", userCookie)
        .send(previewPayload);
      expect(preview.status).toBe(HttpStatus.OK);
      expect(preview.body.addonTotal).toBe(10000);
      expect(preview.body.addons).toEqual([
        expect.objectContaining({
          id: addon.id,
          code: addon.code,
          pricingUnit: "PER_BOOKING",
          unitPrice: 10000,
          quantity: 1,
          totalPrice: 10000,
        }),
      ]);
      expect(preview.body.platformFeeAmount).toBe(5000);
      expect(preview.body.vatAmount).toBe(4875);
      expect(preview.body.totalAmount).toBe(69875);

      const created = await request(app.getHttpServer())
        .post("/api/bookings")
        .set("Cookie", userCookie)
        .set("Idempotency-Key", randomUUID())
        .send({
          ...previewPayload,
          pickupAddress: "Lagos Airport",
          sameLocation: true,
          expectedTotalAmount: String(preview.body.totalAmount),
        });
      expect(created.status).toBe(HttpStatus.CREATED);
      expect(created.body.totalAmount).toBe(preview.body.totalAmount);

      const details = await request(app.getHttpServer())
        .get(`/api/bookings/${created.body.bookingId}`)
        .set("Cookie", userCookie);
      expect(details.status).toBe(HttpStatus.OK);
      expect(details.body.addons).toEqual([
        expect.objectContaining({
          code: addon.code,
          name: "Wi-Fi Hotspot",
          pricingUnit: "PER_BOOKING",
          unitPrice: 10000,
          quantity: 1,
          totalPrice: 10000,
        }),
      ]);

      const stored = await databaseService.booking.findUnique({
        where: { id: created.body.bookingId },
        select: { fleetOwnerPayoutAmountNet: true },
      });
      expect(stored?.fleetOwnerPayoutAmountNet.toNumber()).toBe(42500);
    });

    it("includes fleet-owner add-ons in payout and still VAT-charges them", async () => {
      const addon = await factory.createAddon(adminUserId, {
        code: `FLEET_SECURITY_${Date.now()}`,
        name: "Security Detail",
        pricingUnit: "PER_LEG",
        financialTreatment: "FLEET_OWNER",
        amount: 5000,
      });
      const { startDate, endDate } = futureWindow(16);
      const preview = await request(app.getHttpServer())
        .post("/api/bookings/pricing-preview")
        .set("Cookie", userCookie)
        .send({
          carId,
          bookingType: "DAY",
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          pickupTime: "9:00 AM",
          addonIds: [addon.id],
        });
      expect(preview.status).toBe(HttpStatus.OK);
      expect(preview.body.addonTotal).toBe(5000);
      expect(preview.body.platformFeeAmount).toBe(5000);
      expect(preview.body.vatAmount).toBe(4500);
      expect(preview.body.totalAmount).toBe(64500);

      const created = await request(app.getHttpServer())
        .post("/api/bookings")
        .set("Cookie", userCookie)
        .set("Idempotency-Key", randomUUID())
        .send({
          carId,
          bookingType: "DAY",
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          pickupTime: "9:00 AM",
          pickupAddress: "Lagos Airport",
          sameLocation: true,
          addonIds: [addon.id],
          expectedTotalAmount: String(preview.body.totalAmount),
        });
      expect(created.status).toBe(HttpStatus.CREATED);

      const stored = await databaseService.booking.findUnique({
        where: { id: created.body.bookingId },
        select: { fleetOwnerPayoutAmountNet: true },
      });
      expect(stored?.fleetOwnerPayoutAmountNet.toNumber()).toBe(47500);
    });

    it("rejects stale, deactivated, and inapplicable add-ons", async () => {
      const deactivated = await factory.createAddon(adminUserId, {
        code: `DEACTIVATED_${Date.now()}`,
      });
      await request(app.getHttpServer())
        .patch(`/api/admin/addons/${deactivated.id}`)
        .set("Cookie", adminCookie)
        .send({ isActive: false });

      const nightOnly = await factory.createAddon(adminUserId, {
        code: `NIGHT_BOOKING_${Date.now()}`,
        bookingTypes: ["NIGHT"],
      });
      const ended = await factory.createAddon(adminUserId, {
        code: `STALE_PRICE_${Date.now()}`,
        effectiveSince: new Date("2020-01-01"),
        effectiveUntil: new Date("2021-01-01"),
      });
      const { startDate, endDate } = futureWindow(20);

      for (const addonId of [deactivated.id, nightOnly.id, ended.id]) {
        const preview = await request(app.getHttpServer())
          .post("/api/bookings/pricing-preview")
          .set("Cookie", userCookie)
          .send({
            carId,
            bookingType: "DAY",
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            pickupTime: "9:00 AM",
            addonIds: [addonId],
          });
        expect(preview.status).toBe(HttpStatus.BAD_REQUEST);
        expect(preview.body.errorCode).toBe("INVALID_BOOKING_ADDONS");
      }
    });

    it("snapshots guest-selected add-ons on guest booking details", async () => {
      const addon = await factory.createAddon(adminUserId, {
        code: `GUEST_WIFI_${Date.now()}`,
        name: "Guest Wi-Fi",
        amount: 10000,
      });
      const { startDate, endDate } = futureWindow(24);
      const preview = await request(app.getHttpServer())
        .post("/api/bookings/pricing-preview")
        .send({
          carId,
          bookingType: "DAY",
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          pickupTime: "9:00 AM",
          addonIds: [addon.id],
        });
      expect(preview.status).toBe(HttpStatus.OK);

      const created = await request(app.getHttpServer())
        .post("/api/bookings")
        .set("Idempotency-Key", randomUUID())
        .send({
          carId,
          bookingType: "DAY",
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          pickupTime: "9:00 AM",
          pickupAddress: "Lagos Airport",
          sameLocation: true,
          addonIds: [addon.id],
          expectedTotalAmount: String(preview.body.totalAmount),
          guestEmail: uniqueEmail("addons-guest"),
          guestName: "Guest User",
          guestPhone: "08012345678",
        });
      expect(created.status).toBe(HttpStatus.CREATED);

      const stored = await databaseService.bookingAddon.findMany({
        where: { bookingId: created.body.bookingId },
      });
      expect(stored).toEqual([
        expect.objectContaining({
          addonId: addon.id,
          code: addon.code,
          name: "Guest Wi-Fi",
          quantity: 1,
        }),
      ]);
      expect(stored[0].unitPrice.toNumber()).toBe(10000);
      expect(stored[0].totalPrice.toNumber()).toBe(10000);
    });
  });
});
