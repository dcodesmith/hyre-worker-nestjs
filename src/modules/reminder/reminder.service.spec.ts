import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { NotificationService } from "../notification/notification.service";
import { ReminderService } from "./reminder.service";

describe("ReminderService", () => {
  let service: ReminderService;
  let databaseService: DatabaseService;
  let notificationService: NotificationService;

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
    databaseService = module.get<DatabaseService>(DatabaseService);
    notificationService = module.get<NotificationService>(NotificationService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have all required services injected", () => {
    expect(databaseService).toBeDefined();
    expect(notificationService).toBeDefined();
  });
});
