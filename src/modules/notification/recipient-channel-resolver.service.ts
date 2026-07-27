import { Injectable } from "@nestjs/common";
import { NotificationAudience, NotificationChannel } from "./notification.interface";
import { deriveNotificationChannels } from "./notification-channel.helper";

export type ResolveRecipientChannelsInput = {
  audience: NotificationAudience;
  email?: string;
  phoneNumber?: string;
  userId?: string;
};

@Injectable()
export class RecipientChannelResolverService {
  resolve(input: ResolveRecipientChannelsInput): NotificationChannel[] {
    const { audience, email, phoneNumber, userId } = input;
    const channels = deriveNotificationChannels({ email, phoneNumber });

    // The current mobile app supports customer sessions only. A user ID is
    // enough to schedule PUSH because active tokens are resolved by the worker
    // immediately before delivery, not snapshotted into the job/outbox.
    if (audience === NotificationAudience.CUSTOMER && userId) {
      channels.push(NotificationChannel.PUSH);
    }

    return [...new Set(channels)];
  }
}
