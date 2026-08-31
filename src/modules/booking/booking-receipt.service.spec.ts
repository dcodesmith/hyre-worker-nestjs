import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentAttemptStatus, PaymentStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { PinoLogger } from "nestjs-pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPinoLogger } from "@/testing/nest-pino-logger.mock";
import { AuthUnauthorizedException } from "../auth/auth.error";
import type { AuthSession } from "../auth/guards/session.guard";
import { DatabaseService } from "../database/database.service";
import {
  BookingNotFoundException,
  BookingReceiptGenerationFailedException,
  BookingReceiptNotAvailableException,
} from "./booking.error";
import type { BookingReceiptModel } from "./booking-receipt.model";
import { BookingReceiptService } from "./booking-receipt.service";
import { BookingReceiptPdfService } from "./booking-receipt-pdf.service";
import { GuestBookingAccessService } from "./guest-booking-access.service";

const customer = {
  id: "customer-1",
  email: "customer@example.com",
  emailVerified: true,
  name: "Ada Customer",
  image: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  roles: ["user" as const],
} satisfies AuthSession["user"];

function payment(
  overrides: Partial<{
    id: string;
    amountExpected: Decimal;
    amountCharged: Decimal | null;
    currency: string;
    status: PaymentAttemptStatus;
    webhookPayload: { refundAmount: number } | null;
  }> = {},
) {
  return {
    id: "payment-1",
    txRef: "booking_booking-1",
    amountExpected: new Decimal("113412.50"),
    amountCharged: new Decimal("113412.50"),
    currency: "NGN",
    status: PaymentAttemptStatus.SUCCESSFUL,
    webhookPayload: null,
    ...overrides,
  };
}

function booking(
  overrides: Partial<ReturnType<typeof bookingFixture>> = {},
): ReturnType<typeof bookingFixture> {
  return { ...bookingFixture(), ...overrides };
}

function bookingFixture() {
  return {
    id: "booking-1",
    bookingReference: "TRIP-123",
    status: BookingStatus.COMPLETED as BookingStatus,
    paymentStatus: PaymentStatus.PAID as PaymentStatus,
    paymentId: "payment-1",
    userId: customer.id,
    guestUser: null,
    startDate: new Date("2026-08-20T08:00:00.000Z"),
    endDate: new Date("2026-08-20T20:00:00.000Z"),
    pickupLocation: "Lagos Airport",
    returnLocation: "Victoria Island",
    totalAmount: new Decimal("113412.50"),
    netTotal: new Decimal("100000"),
    securityDetailCost: new Decimal("5000"),
    fuelUpgradeCost: new Decimal("10000"),
    platformCustomerServiceFeeAmount: new Decimal("5500"),
    subtotalBeforeVat: new Decimal("105500"),
    vatAmount: new Decimal("7912.50"),
    vatRatePercent: new Decimal("7.5"),
    referralDiscountAmount: new Decimal("10000"),
    referralCreditsUsed: new Decimal("5000"),
    user: { name: "Ada Customer" },
    car: { make: "Toyota", model: "Camry", year: 2025, color: "Black" as string | null },
    chauffeur: { name: "Tunde Driver" },
    customerPayments: [payment()],
    legs: [
      {
        extensions: [
          {
            id: "extension-1",
            status: "ACTIVE" as string,
            paymentStatus: PaymentStatus.PAID as PaymentStatus,
            paymentId: "extension-payment-1",
            totalAmount: new Decimal("11287.50"),
            netTotal: new Decimal("10000"),
            platformCustomerServiceFeeAmount: new Decimal("500"),
            subtotalBeforeVat: new Decimal("10500"),
            vatAmount: new Decimal("787.50"),
            vatRatePercent: new Decimal("7.5"),
            customerPayments: [
              payment({
                id: "extension-payment-1",
                amountExpected: new Decimal("11287.50"),
                amountCharged: new Decimal("11287.50"),
              }),
            ],
          },
        ],
      },
    ],
  };
}

describe("BookingReceiptService", () => {
  let service: BookingReceiptService;
  const databaseService = { booking: { findFirst: vi.fn() } };
  const guestAccessService = { assertBookingAccess: vi.fn() };
  const pdfService = { render: vi.fn() };
  const logger = createMockPinoLogger();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    databaseService.booking.findFirst.mockResolvedValue(booking());
    guestAccessService.assertBookingAccess.mockResolvedValue(undefined);
    pdfService.render.mockResolvedValue(Buffer.from("%PDF-1.7"));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingReceiptService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: GuestBookingAccessService, useValue: guestAccessService },
        { provide: BookingReceiptPdfService, useValue: pdfService },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();
    service = module.get(BookingReceiptService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a completed paid customer receipt from persisted financials", async () => {
    const result = await service.generateReceipt("booking-1", customer);

    expect(result).toEqual({
      buffer: Buffer.from("%PDF-1.7"),
      fileName: "Tripdly-receipt-TRIP-123.pdf",
    });
    expect(databaseService.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1", deletedAt: null, userId: customer.id },
      }),
    );
    expect(pdfService.render).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingReference: "TRIP-123",
        customerName: "Ada Customer",
        vehicle: "Toyota Camry (2025, Black)",
        chauffeurName: "Tunde Driver",
        paymentStatus: "PAID",
        paymentReference: "booking_booking-1",
        currency: "NGN",
        totalPaid: 124700,
      }),
    );
  });

  it("includes fees, discounts, credits, VAT and only active settled extensions", async () => {
    const data = booking();
    data.legs[0].extensions.push({
      ...data.legs[0].extensions[0],
      id: "pending-extension",
      status: "PENDING",
      paymentStatus: PaymentStatus.UNPAID,
      paymentId: null,
      customerPayments: [],
    });
    databaseService.booking.findFirst.mockResolvedValue(data);

    await service.generateReceipt("booking-1", customer);

    const receipt = pdfService.render.mock.calls[0][0] as BookingReceiptModel;
    expect(receipt.lineItems).toEqual([
      { label: "Base booking charge", amount: 100000 },
      { label: "Paid extensions (1)", amount: 10000 },
      { label: "Security detail", amount: 5000 },
      { label: "Fuel upgrade", amount: 10000 },
      { label: "Platform service fee", amount: 6000 },
      { label: "Referral discount", amount: -10000 },
      { label: "Referral credits used", amount: -5000 },
      { label: "VAT (7.5%)", amount: 8700 },
    ]);
    expect(receipt.lineItems.reduce((sum, item) => sum + item.amount, 0)).toBe(receipt.totalPaid);
  });

  it.each([
    { charged: "113412.49", adjustment: -0.01, totalPaid: 124699.99 },
    { charged: "113412.51", adjustment: 0.01, totalPaid: 124700.01 },
  ])(
    "reconciles an accepted one-kobo payment difference: %o",
    async ({ charged, adjustment, totalPaid }) => {
      databaseService.booking.findFirst.mockResolvedValue(
        booking({
          customerPayments: [payment({ amountCharged: new Decimal(charged) })],
        }),
      );

      await service.generateReceipt("booking-1", customer);

      const receipt = pdfService.render.mock.calls[0][0] as BookingReceiptModel;
      expect(receipt.lineItems).toContainEqual({
        label: "Payment rounding adjustment",
        amount: adjustment,
      });
      expect(receipt.totalPaid).toBe(totalPaid);
      expect(receipt.lineItems.reduce((sum, item) => sum + item.amount, 0)).toBe(totalPaid);
    },
  );

  it("shows a verified partial refund as a negative line item", async () => {
    const data = booking({
      paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
      customerPayments: [
        payment({
          status: PaymentAttemptStatus.PARTIALLY_REFUNDED,
          webhookPayload: { refundAmount: 30000 },
        }),
      ],
    });
    databaseService.booking.findFirst.mockResolvedValue(data);

    await service.generateReceipt("booking-1", customer);

    const receipt = pdfService.render.mock.calls[0][0] as BookingReceiptModel;
    expect(receipt.paymentStatus).toBe("PARTIALLY_REFUNDED");
    expect(receipt.lineItems).toContainEqual({ label: "Refunds", amount: -30000 });
    expect(receipt.totalPaid).toBe(94700);
  });

  it("shows a verified full refund with zero currently paid", async () => {
    const data = booking({
      paymentStatus: PaymentStatus.REFUNDED,
      customerPayments: [
        payment({
          status: PaymentAttemptStatus.REFUNDED,
          webhookPayload: { refundAmount: 113412.5 },
        }),
      ],
      legs: [],
    });
    databaseService.booking.findFirst.mockResolvedValue(data);

    await service.generateReceipt("booking-1", customer);

    const receipt = pdfService.render.mock.calls[0][0] as BookingReceiptModel;
    expect(receipt.paymentStatus).toBe("REFUNDED");
    expect(receipt.totalPaid).toBe(0);
    expect(receipt.lineItems.reduce((sum, item) => sum + item.amount, 0)).toBe(0);
  });

  it.each([
    { status: BookingStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID },
    { status: BookingStatus.COMPLETED, paymentStatus: PaymentStatus.UNPAID },
  ])("rejects an ineligible booking: %o", async ({ status, paymentStatus }) => {
    databaseService.booking.findFirst.mockResolvedValue(booking({ status, paymentStatus }));

    await expect(service.generateReceipt("booking-1", customer)).rejects.toBeInstanceOf(
      BookingReceiptNotAvailableException,
    );
    expect(pdfService.render).not.toHaveBeenCalled();
  });

  it("rejects another customer and unsupported fleet-owner access as not found", async () => {
    databaseService.booking.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.generateReceipt("booking-1", { ...customer, id: "other-customer" }),
    ).rejects.toBeInstanceOf(BookingNotFoundException);

    await expect(
      service.generateReceipt("booking-1", { ...customer, roles: ["fleetOwner"] }),
    ).rejects.toBeInstanceOf(BookingNotFoundException);
  });

  it("accepts a valid guest token scoped by the guest-access service", async () => {
    databaseService.booking.findFirst.mockResolvedValue(
      booking({
        userId: null,
        user: null,
        guestUser: { name: "Guest Customer", email: "guest@example.com" },
      }),
    );

    await service.generateReceipt("booking-1", null, "g".repeat(43));

    expect(guestAccessService.assertBookingAccess).toHaveBeenCalledWith(
      "booking-1",
      "g".repeat(43),
    );
    expect(databaseService.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1", deletedAt: null, userId: null },
      }),
    );
    expect(pdfService.render).toHaveBeenCalledWith(
      expect.objectContaining({ customerName: "Guest Customer" }),
    );
  });

  it.each(["expired-token", "token-for-another-booking"])(
    "rejects a guest token that is %s",
    async () => {
      guestAccessService.assertBookingAccess.mockRejectedValueOnce(new BookingNotFoundException());

      await expect(
        service.generateReceipt("booking-1", null, "g".repeat(43)),
      ).rejects.toBeInstanceOf(BookingNotFoundException);
      expect(databaseService.booking.findFirst).not.toHaveBeenCalled();
    },
  );

  it("returns the normal unauthenticated error without a session or guest token", async () => {
    await expect(service.generateReceipt("booking-1", null)).rejects.toBeInstanceOf(
      AuthUnauthorizedException,
    );
    expect(databaseService.booking.findFirst).not.toHaveBeenCalled();
  });

  it("treats a blank guest token as absent and uses the signed-in customer", async () => {
    await service.generateReceipt("booking-1", customer, "   ");

    expect(guestAccessService.assertBookingAccess).not.toHaveBeenCalled();
    expect(databaseService.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1", deletedAt: null, userId: customer.id },
      }),
    );
  });

  it("rejects incomplete financial data instead of inventing a receipt amount", async () => {
    databaseService.booking.findFirst.mockResolvedValue(
      booking({ netTotal: null, customerPayments: [payment()] }),
    );

    await expect(service.generateReceipt("booking-1", customer)).rejects.toBeInstanceOf(
      BookingReceiptNotAvailableException,
    );
  });

  it("ignores a stored guest name that is not a string", async () => {
    databaseService.booking.findFirst.mockResolvedValue(
      booking({
        user: { name: null },
        guestUser: { name: 42, email: "guest@example.com" },
      }),
    );

    await service.generateReceipt("booking-1", customer);

    expect(pdfService.render).toHaveBeenCalledWith(expect.objectContaining({ customerName: null }));
  });

  it("handles missing optional customer, chauffeur and car colour fields", async () => {
    databaseService.booking.findFirst.mockResolvedValue(
      booking({
        user: { name: null },
        guestUser: null,
        chauffeur: null,
        car: { make: "Toyota", model: "Camry", year: 2025, color: null },
      }),
    );

    await service.generateReceipt("booking-1", customer);

    expect(pdfService.render).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: null,
        chauffeurName: null,
        vehicle: "Toyota Camry (2025)",
      }),
    );
  });

  it("maps PDF rendering failures to a safe typed error", async () => {
    pdfService.render.mockRejectedValueOnce(new Error("raw PDF failure"));

    await expect(service.generateReceipt("booking-1", customer)).rejects.toBeInstanceOf(
      BookingReceiptGenerationFailedException,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1" }),
      "Failed to generate booking receipt PDF",
    );
  });
});
