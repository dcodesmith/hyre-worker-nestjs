import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { PinoLogger } from "nestjs-pino";
import { EnvConfig } from "@/config/env.config";
import {
  PushDeliveryError,
  SendPushNotificationsInput,
  SendPushNotificationsResult,
} from "./push.interface";

@Injectable()
export class PushService {
  private readonly expo: Expo;

  constructor(
    private readonly configService: ConfigService<EnvConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PushService.name);
    this.expo = new Expo({
      accessToken: this.configService.get("EXPO_ACCESS_TOKEN", { infer: true }),
    });
  }

  isValidPushToken(token: string): boolean {
    return Expo.isExpoPushToken(token);
  }

  async sendPushNotifications(
    input: SendPushNotificationsInput,
  ): Promise<SendPushNotificationsResult> {
    const uniqueTokens = [...new Set(input.tokens)].filter((token) => this.isValidPushToken(token));
    if (uniqueTokens.length === 0) {
      return { sent: 0, failed: 0, invalidTokens: [], errors: [] };
    }

    const messages: ExpoPushMessage[] = uniqueTokens.map((token) => ({
      to: token,
      sound: "default",
      title: input.title,
      body: input.body,
      data: input.data,
    }));

    let sent = 0;
    let failed = 0;
    const invalidTokens = new Set<string>();
    const errors: PushDeliveryError[] = [];

    for (const chunk of this.expo.chunkPushNotifications(messages)) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          { tokenCount: chunk.length, error: message },
          "Failed to send push notification chunk to Expo",
        );
        failed += chunk.length;
        for (const pushMessage of chunk) {
          if (typeof pushMessage.to !== "string") {
            continue;
          }
          errors.push({
            code: "SEND_CHUNK_FAILED",
            retryable: true,
            token: pushMessage.to,
            message,
          });
        }
        continue;
      }
      this.processTickets(
        chunk,
        tickets,
        invalidTokens,
        {
          incrementSent: () => {
            sent += 1;
          },
          incrementFailed: () => {
            failed += 1;
          },
        },
        errors,
      );
    }

    return { sent, failed, invalidTokens: [...invalidTokens], errors };
  }

  private processTickets(
    chunk: ExpoPushMessage[],
    tickets: ExpoPushTicket[],
    invalidTokens: Set<string>,
    counters: { incrementSent: () => void; incrementFailed: () => void },
    errors: PushDeliveryError[],
  ): void {
    tickets.forEach((ticket, index) => {
      const token = chunk[index]?.to;
      if (ticket.status === "ok") {
        counters.incrementSent();
        return;
      }

      const code = ticket.details?.error ?? "UNKNOWN";
      const retryable = this.isRetryableTicketError(code);
      const tokenValue = typeof token === "string" ? token : undefined;

      if (code === "DeviceNotRegistered" && tokenValue) {
        invalidTokens.add(tokenValue);
      }

      errors.push({
        code,
        retryable,
        token: tokenValue,
        message: ticket.message,
      });

      if (retryable) {
        counters.incrementFailed();
      }
    });
  }

  private isRetryableTicketError(code: string): boolean {
    const nonRetryableErrors = new Set([
      "DeviceNotRegistered",
      "InvalidCredentials",
      "MessageTooBig",
    ]);
    return !nonRetryableErrors.has(code);
  }
}
