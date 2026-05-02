import { Test, type TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentAttemptStatus } from "@prisma/client";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { createBooking, createExtension, createPaymentRecord } from "../../shared/helper.fixtures";
import { BookingConfirmationService } from "../booking/booking-confirmation.service";
import { ExtensionConfirmationService } from "../booking/extension-confirmation.service";
import { DatabaseService } from "../database/database.service";
import type { FlutterwaveChargeData } from "../flutterwave/flutterwave.interface";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { ChargeCompletedHandler } from "./charge-completed.handler";

describe("ChargeCompletedHandler", () => {
  let handler: ChargeCompletedHandler;
  let databaseService: DatabaseService;
  let flutterwaveService: FlutterwaveService;
  let bookingConfirmationService: BookingConfirmationService;
  let extensionConfirmationService: ExtensionConfirmationService;

  const mockBookingConfirmationService = {
    confirmFromPayment: vi.fn(),
  };
  const mockExtensionConfirmationService = {
    confirmFromPayment: vi.fn(),
  };
  const mockChargeData: FlutterwaveChargeData = {
    id: 12345,
    tx_ref: "tx-ref-123",
    flw_ref: "FLW-REF-123",
    device_fingerprint: "fingerprint",
    amount: 10000,
    currency: "NGN",
    charged_amount: 10000,
    app_fee: 100,
    merchant_fee: 0,
    processor_response: "Approved",
    auth_model: "PIN",
    ip: "127.0.0.1",
    narration: "Payment",
    status: "successful",
    payment_type: "card",
    created_at: "2024-01-01T00:00:00.000Z",
    account_id: 1,
    customer: {
      id: 1,
      name: "Test User",
      phone_number: null,
      email: "test@example.com",
      created_at: "2024-01-01T00:00:00.000Z",
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChargeCompletedHandler,
        {
          provide: DatabaseService,
          useValue: {
            payment: {
              upsert: vi.fn(),
            },
            booking: {
              findFirst: vi.fn(),
            },
            extension: {
              findFirst: vi.fn(),
            },
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            verifyTransaction: vi.fn(),
          },
        },
        { provide: BookingConfirmationService, useValue: mockBookingConfirmationService },
        { provide: ExtensionConfirmationService, useValue: mockExtensionConfirmationService },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    handler = module.get<ChargeCompletedHandler>(ChargeCompletedHandler);
    databaseService = module.get<DatabaseService>(DatabaseService);
    flutterwaveService = module.get<FlutterwaveService>(FlutterwaveService);
    bookingConfirmationService = module.get<BookingConfirmationService>(BookingConfirmationService);
    extensionConfirmationService = module.get<ExtensionConfirmationService>(
      ExtensionConfirmationService,
    );
    vi.clearAllMocks();
  });

  it("creates payment and confirms booking when booking txRef matches", async () => {
    const createdPayment = {
      ...createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.SUCCESSFUL,
        bookingId: "booking-456",
        amountExpected: new Decimal(10000),
        amountCharged: new Decimal(10000),
        currency: "NGN",
      }),
      booking: { id: "booking-456", status: BookingStatus.PENDING },
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData },
    });
    vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(
      createBooking({ id: "booking-456", totalAmount: new Decimal(10000) }),
    );
    vi.mocked(databaseService.extension.findFirst).mockResolvedValueOnce(null);
    vi.mocked(databaseService.payment.upsert).mockResolvedValueOnce(createdPayment);
    vi.mocked(bookingConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await handler.handle(mockChargeData);

    expect(databaseService.payment.upsert).toHaveBeenCalled();
    expect(bookingConfirmationService.confirmFromPayment).toHaveBeenCalledWith(createdPayment);
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("creates payment but blocks confirmation when charged amount differs from expected", async () => {
    const createdPayment = {
      ...createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.SUCCESSFUL,
        bookingId: "booking-456",
        amountExpected: new Decimal(10000),
        amountCharged: new Decimal(9999.5),
        currency: "NGN",
      }),
      booking: { id: "booking-456", status: BookingStatus.PENDING },
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData, charged_amount: 9999.5 },
    });
    vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(
      createBooking({ id: "booking-456", totalAmount: new Decimal(10000) }),
    );
    vi.mocked(databaseService.extension.findFirst).mockResolvedValueOnce(null);
    vi.mocked(databaseService.payment.upsert).mockResolvedValueOnce(createdPayment);

    await handler.handle({ ...mockChargeData, charged_amount: 9999.5 });

    expect(databaseService.payment.upsert).toHaveBeenCalled();
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("allows confirmation when amount difference is exactly tolerance", async () => {
    const createdPayment = {
      ...createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.SUCCESSFUL,
        bookingId: "booking-456",
        amountExpected: new Decimal(10000),
        amountCharged: new Decimal(9999.99), // difference = 0.01
        currency: "NGN",
      }),
      booking: { id: "booking-456", status: BookingStatus.PENDING },
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData, charged_amount: 9999.99, currency: "NGN" },
    });
    vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(
      createBooking({ id: "booking-456", totalAmount: new Decimal(10000) }),
    );
    vi.mocked(databaseService.extension.findFirst).mockResolvedValueOnce(null);
    vi.mocked(databaseService.payment.upsert).mockResolvedValueOnce(createdPayment);
    vi.mocked(bookingConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await handler.handle({ ...mockChargeData, charged_amount: 9999.99 });

    expect(bookingConfirmationService.confirmFromPayment).toHaveBeenCalledWith(createdPayment);
  });

  it("creates payment but blocks confirmation when currency differs from expected", async () => {
    const createdPayment = {
      ...createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.SUCCESSFUL,
        bookingId: "booking-456",
        amountExpected: new Decimal(10000),
        amountCharged: new Decimal(10000),
        currency: "USD",
      }),
      booking: { id: "booking-456", status: BookingStatus.PENDING },
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData, currency: "NGN" },
    });
    vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(
      createBooking({ id: "booking-456", totalAmount: new Decimal(10000) }),
    );
    vi.mocked(databaseService.extension.findFirst).mockResolvedValueOnce(null);
    vi.mocked(databaseService.payment.upsert).mockResolvedValueOnce(createdPayment);

    await handler.handle(mockChargeData);

    expect(databaseService.payment.upsert).toHaveBeenCalled();
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("creates payment and confirms extension when extension txRef matches", async () => {
    const createdPayment = {
      ...createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.SUCCESSFUL,
        extensionId: "extension-789",
        amountExpected: new Decimal(5000),
        amountCharged: new Decimal(5000),
        currency: "NGN",
      }),
      booking: null,
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData, charged_amount: 5000 },
    });
    vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(null);
    vi.mocked(databaseService.extension.findFirst).mockResolvedValueOnce(
      createExtension({ id: "extension-789", totalAmount: new Decimal(5000) }),
    );
    vi.mocked(databaseService.payment.upsert).mockResolvedValueOnce(createdPayment);
    vi.mocked(extensionConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await handler.handle({ ...mockChargeData, charged_amount: 5000 });

    expect(extensionConfirmationService.confirmFromPayment).toHaveBeenCalledWith(createdPayment);
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("confirms booking on retry when persisted charged amount/currency are missing but verification is valid", async () => {
    const createdPayment = {
      ...createPaymentRecord({
        id: "payment-123",
        txRef: "tx-ref-123",
        status: PaymentAttemptStatus.SUCCESSFUL,
        bookingId: "booking-456",
        amountExpected: new Decimal(10000),
        amountCharged: null,
        currency: "",
      }),
      booking: { id: "booking-456", status: BookingStatus.PENDING },
    };

    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData, charged_amount: 10000, currency: "NGN" },
    });
    vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(
      createBooking({ id: "booking-456", totalAmount: new Decimal(10000) }),
    );
    vi.mocked(databaseService.extension.findFirst).mockResolvedValueOnce(null);
    vi.mocked(databaseService.payment.upsert).mockResolvedValueOnce(createdPayment);
    vi.mocked(bookingConfirmationService.confirmFromPayment).mockResolvedValueOnce(true);

    await handler.handle(mockChargeData);

    expect(databaseService.payment.upsert).toHaveBeenCalled();
    expect(bookingConfirmationService.confirmFromPayment).toHaveBeenCalledWith(createdPayment);
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("skips payment creation when verified tx_ref mismatch occurs", async () => {
    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData, tx_ref: "different-ref" },
    });

    await handler.handle(mockChargeData);

    expect(databaseService.booking.findFirst).not.toHaveBeenCalled();
    expect(databaseService.payment.upsert).not.toHaveBeenCalled();
  });

  it("skips processing when txRef matches both booking and extension", async () => {
    vi.mocked(flutterwaveService.verifyTransaction).mockResolvedValueOnce({
      status: "success",
      message: "ok",
      data: { ...mockChargeData },
    });
    vi.mocked(databaseService.booking.findFirst).mockResolvedValueOnce(
      createBooking({ id: "booking-456", totalAmount: new Decimal(10000) }),
    );
    vi.mocked(databaseService.extension.findFirst).mockResolvedValueOnce(
      createExtension({ id: "extension-789", totalAmount: new Decimal(5000) }),
    );

    await handler.handle(mockChargeData);

    expect(databaseService.payment.upsert).not.toHaveBeenCalled();
    expect(bookingConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
    expect(extensionConfirmationService.confirmFromPayment).not.toHaveBeenCalled();
  });

  it("skips processing when tx_ref is missing", async () => {
    await handler.handle({ ...mockChargeData, tx_ref: undefined as unknown as string });

    expect(flutterwaveService.verifyTransaction).not.toHaveBeenCalled();
    expect(databaseService.payment.upsert).not.toHaveBeenCalled();
  });
});
