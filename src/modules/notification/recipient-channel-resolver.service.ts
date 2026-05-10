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
    const { email, phoneNumber, userId, pushTokens: tokensFromCaller } = input;
    const channels = deriveNotificationChannels({ email, phoneNumber });

    const tokensBeforeDedupe =
      tokensFromCaller ??
      (userId ? await this.pushTokenService.getActiveTokensForUser(userId) : []);

    const pushTokens = [...new Set(tokensBeforeDedupe)];

    if (pushTokens.length > 0) {
      channels.push(NotificationChannel.PUSH);
    }

    return {
      channels: [...new Set(channels)],
      pushTokens,
    };
  }
}
