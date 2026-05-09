import { Injectable } from "@nestjs/common";
import { NotificationChannel } from "./notification.interface";
import { deriveNotificationChannels } from "./notification-channel.helper";
import { PushTokenService } from "./push-token.service";

type ResolveRecipientChannelsInput = {
  email?: string;
  phoneNumber?: string;
  userId?: string;
  pushTokens?: string[];
};

type ResolvedRecipientChannels = {
  channels: NotificationChannel[];
  pushTokens: string[];
};

@Injectable()
export class RecipientChannelResolverService {
  constructor(private readonly pushTokenService: PushTokenService) {}

  async resolve(input: ResolveRecipientChannelsInput): Promise<ResolvedRecipientChannels> {
    const channels = deriveNotificationChannels({
      email: input.email,
      phoneNumber: input.phoneNumber,
    });

    const pushTokens =
      input.pushTokens ??
      (input.userId ? await this.pushTokenService.getActiveTokensForUser(input.userId) : []);

    if (pushTokens.length > 0) {
      channels.push(NotificationChannel.PUSH);
    }

    return {
      channels: [...new Set(channels)],
      pushTokens,
    };
  }
}
