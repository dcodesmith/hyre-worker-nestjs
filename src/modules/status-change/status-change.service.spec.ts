import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus, Status } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBooking } from "../../shared/helper";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import { PaymentService } from "../payment/payment.service";
import { StatusChangeService } from "./status-change.service";

describe("StatusChangeService", () => {
  let service: StatusChangeService;
  let mockDatabaseService: DatabaseService;
  let mockNotificationService: NotificationService;
  let mockPaymentService: PaymentService;

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
          },
        },
        {
          provide: NotificationService,
          useValue: {
            queueBookingStatusNotifications: vi.fn(),
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
      where: {
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        chauffeurId: { not: null },
        startDate: {
          gte: expect.any(Date),
          lte: expect.any(Date),
        },
        car: {
          status: Status.BOOKED,
        },
      },
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
    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([
      createBooking({
        id: "1",
        bookingReference: "1",
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
      }),
    ]);

    const result = await service.updateBookingsFromConfirmedToActive();

    expect(mockDatabaseService.booking.update).toHaveBeenCalledTimes(1);
    expect(mockDatabaseService.booking.update).toHaveBeenCalledWith({
      where: { id: "1" },
      data: { status: BookingStatus.ACTIVE },
      include: {
        car: { include: { owner: true } },
        user: true,
        chauffeur: true,
        legs: { include: { extensions: true } },
      },
    });
    expect(mockNotificationService.queueBookingStatusNotifications).toHaveBeenCalledTimes(1);
    expect(result).toBe("Updated 1 bookings from confirmed to active");
  });

  it("should update bookings from active to completed when no bookings found", async () => {
    vi.mocked(mockDatabaseService.booking.findMany).mockResolvedValue([]);

    const result = await service.updateBookingsFromActiveToCompleted();

    expect(result).toBe("No bookings to update");
  });
});
