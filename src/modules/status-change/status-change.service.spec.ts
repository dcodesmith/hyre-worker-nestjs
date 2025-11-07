import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking } from "../../shared/helper.fixtures";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import { PaymentService } from "../payment/payment.service";
import { ReferralService } from "../referral/referral.service";
import { StatusChangeService } from "./status-change.service";

describe("StatusChangeService", () => {
  let service: StatusChangeService;
  let mockDatabaseService: DatabaseService;
  let mockNotificationService: NotificationService;
  let mockPaymentService: PaymentService;
  let mockReferralService: ReferralService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusChangeService,
        {
          provide: DatabaseService,
          useValue: {
            booking: {
              findMany: vi.fn(),
              update: vi.fn(),
            },
            car: {
              update: vi.fn(),
            },
            $transaction: vi.fn(),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            queueBookingStatusNotifications: vi.fn(),
          },
        },
        {
          provide: ReferralService,
          useValue: {
            queueReferralProcessing: vi.fn(),
          },
        },
        {
          provide: PaymentService,
          useValue: {
            initiatePayout: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StatusChangeService>(StatusChangeService);
    mockDatabaseService = module.get<DatabaseService>(DatabaseService);
    mockNotificationService = module.get<NotificationService>(NotificationService);
    mockPaymentService = module.get<PaymentService>(PaymentService);
    mockReferralService = module.get<ReferralService>(ReferralService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have all required services injected", () => {
    expect(service).toBeDefined();
    expect(mockDatabaseService).toBeDefined();
    expect(mockNotificationService).toBeDefined();
    expect(mockPaymentService).toBeDefined();
  });

  it("should not update bookings from confirmed to active when no bookings found", async () => {
    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([]);
    const result = await service.updateBookingsFromConfirmedToActive();

    expect(mockDatabaseService.booking.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        chauffeurId: { not: null },
        startDate: {
          gte: expect.any(Date),
          lte: expect.any(Date),
        },
        car: { status: Status.BOOKED },
      }),
      include: {
        car: { include: { owner: true } },
        user: true,
        chauffeur: true,
        legs: { include: { extensions: true } },
      },
    });
    expect(result).toEqual("No bookings to update");
  });

  it("should update bookings from confirmed to active when bookings found", async () => {
    const mockBooking = createBooking({
      id: "1",
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
    });

    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([mockBooking]);

    vi.mocked(mockDatabaseService.$transaction).mockImplementation(async (callback) => {
      const mockTx = {
        booking: {
          update: vi.fn().mockResolvedValue({ ...mockBooking, status: BookingStatus.ACTIVE }),
        },
      } as unknown as DatabaseService;
      return callback(mockTx);
    });

    const result = await service.updateBookingsFromConfirmedToActive();

    expect(mockDatabaseService.$transaction).toHaveBeenCalledOnce();
    expect(mockNotificationService.queueBookingStatusNotifications).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "1", status: BookingStatus.ACTIVE }),
      BookingStatus.CONFIRMED,
      BookingStatus.ACTIVE,
    );
    expect(result).toBe("Updated 1 bookings from confirmed to active");
  });

  it("should update bookings from active to completed when no bookings found", async () => {
    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([]);

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(result).toBe("No bookings to update");
  });

  it("should update bookings from active to completed and queue referral processing", async () => {
    const mockBooking = createBooking({
      id: "2",
      status: BookingStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAID,
      carId: "car-1",
    });

    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([mockBooking]);

    vi.mocked(mockDatabaseService.$transaction).mockImplementation(async (callback) => {
      const mockTx = {
        booking: {
          update: vi.fn().mockResolvedValue({ ...mockBooking, status: BookingStatus.COMPLETED }),
        },
        car: {
          update: vi.fn().mockResolvedValue({ id: "car-1", status: Status.AVAILABLE }),
        },
      } as unknown as DatabaseService;
      return callback(mockTx);
    });

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(mockDatabaseService.$transaction).toHaveBeenCalledOnce();
    expect(mockNotificationService.queueBookingStatusNotifications).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "2", status: BookingStatus.COMPLETED }),
      BookingStatus.ACTIVE,
      BookingStatus.COMPLETED,
    );
    expect(mockReferralService.queueReferralProcessing).toHaveBeenCalledExactlyOnceWith("2");
    expect(result).toBe("Updated 1 bookings from active to completed");
  });
});
