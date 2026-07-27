import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { NotificationAudience, NotificationChannel } from "./notification.interface";
import { RecipientChannelResolverService } from "./recipient-channel-resolver.service";

describe("RecipientChannelResolverService", () => {
  let service: RecipientChannelResolverService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RecipientChannelResolverService],
    }).compile();

    service = module.get(RecipientChannelResolverService);
  });

  it("schedules customer push from a user ID without resolving token snapshots", () => {
    expect(
      service.resolve({
        audience: NotificationAudience.CUSTOMER,
        userId: "customer-1",
        email: "customer@example.com",
        phoneNumber: "+2348012345678",
      }),
    ).toEqual([NotificationChannel.EMAIL, NotificationChannel.WHATSAPP, NotificationChannel.PUSH]);
  });

  it.each([NotificationAudience.FLEET_OWNER, NotificationAudience.CHAUFFEUR])(
    "does not schedule push for the unsupported %s audience",
    (audience) => {
      expect(service.resolve({ audience, userId: "user-1" })).toEqual([]);
    },
  );

  it("does not schedule push for a customer without a user ID", () => {
    expect(
      service.resolve({
        audience: NotificationAudience.CUSTOMER,
        email: "guest@example.com",
      }),
    ).toEqual([NotificationChannel.EMAIL]);
  });
});
