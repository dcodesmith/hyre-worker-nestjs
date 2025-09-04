import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import { ReminderService } from "./reminder.service";

describe("ReminderService", () => {
  let service: ReminderService;
  let mockDatabaseService: DatabaseService;
  let mockNotificationService: NotificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReminderService,
        {
          provide: DatabaseService,
          useValue: {
            bookingLeg: {
              findMany: vi.fn().mockResolvedValue([]),
            },
          },
        },
        {
          provide: NotificationService,
          useValue: {
            queueBookingReminderNotifications: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<ReminderService>(ReminderService);
    mockDatabaseService = module.get<DatabaseService>(DatabaseService);
    mockNotificationService = module.get<NotificationService>(NotificationService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have all required services injected", () => {
    expect(mockDatabaseService).toBeDefined();
    expect(mockNotificationService).toBeDefined();
  });
});
