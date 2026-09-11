import { createHmac } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  InjectThrottlerStorage,
  ThrottlerException,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import { PinoLogger } from "nestjs-pino";
import twilio, { type Twilio } from "twilio";
import { isThrottled } from "../../common/throttling/throttling.helper";
import type { EnvConfig } from "../../config/env.config";
import { DatabaseService } from "../database/database.service";
import type {
  CheckPhoneVerificationDto,
  SendPhoneVerificationDto,
} from "./account-verification.dto";
import {
  PhoneVerificationCodeInvalidException,
  PhoneVerificationProviderUnavailableException,
} from "./account-verification.error";

@Injectable()
export class PhoneVerificationService {
  private readonly client: Twilio;
  private readonly serviceSid: string;
  private readonly hashKey: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly databaseService: DatabaseService,
    private readonly logger: PinoLogger,
    @InjectThrottlerStorage() private readonly throttlerStorage: ThrottlerStorage,
  ) {
    this.logger.setContext(PhoneVerificationService.name);
    this.client = twilio(
      configService.get("TWILIO_ACCOUNT_SID", { infer: true }),
      configService.get("TWILIO_AUTH_TOKEN", { infer: true }),
    );
    this.serviceSid = configService.get("TWILIO_VERIFY_SERVICE_SID", { infer: true });
    this.hashKey = configService.get("HMAC_KEY", { infer: true });
  }

  async send(userId: string, input: SendPhoneVerificationDto) {
    if (await this.isAlreadyVerified(userId, input.phoneNumber)) {
      return this.response("VERIFIED", input.phoneNumber);
    }
    return this.sendCode(`user:${userId}`, input.phoneNumber);
  }

  async sendCode(subjectId: string, phoneNumber: string) {
    await this.enforceSendLimits(subjectId, phoneNumber);

    try {
      const verification = await this.client.verify.v2
        .services(this.serviceSid)
        .verifications.create({ channel: "sms", to: phoneNumber });
      if (verification.status !== "pending") {
        throw new PhoneVerificationProviderUnavailableException();
      }
      return this.response("PENDING", phoneNumber);
    } catch (error) {
      if (error instanceof PhoneVerificationProviderUnavailableException) throw error;
      this.logger.warn(
        { subjectId, phone: this.maskPhone(phoneNumber), ...this.twilioErrorContext(error) },
        "Twilio could not send a phone verification code",
      );
      throw new PhoneVerificationProviderUnavailableException();
    }
  }

  async check(userId: string, input: CheckPhoneVerificationDto) {
    if (await this.isAlreadyVerified(userId, input.phoneNumber)) {
      return this.response("VERIFIED", input.phoneNumber);
    }

    await this.checkCode(`user:${userId}`, input.phoneNumber, input.code);
    await this.databaseService.user.update({
      where: { id: userId },
      data: { phoneNumber: input.phoneNumber, phoneVerifiedAt: new Date() },
    });
    return this.response("VERIFIED", input.phoneNumber);
  }

  async checkCode(subjectId: string, phoneNumber: string, code: string) {
    try {
      const verification = await this.client.verify.v2
        .services(this.serviceSid)
        .verificationChecks.create({ code, to: phoneNumber });

      if (verification.status !== "approved") {
        throw new PhoneVerificationCodeInvalidException();
      }
    } catch (error) {
      if (error instanceof PhoneVerificationCodeInvalidException) {
        throw error;
      }

      if (this.isInvalidCodeError(error)) {
        throw new PhoneVerificationCodeInvalidException();
      }

      this.logger.warn(
        { subjectId, phone: this.maskPhone(phoneNumber), ...this.twilioErrorContext(error) },
        "Twilio could not check a phone verification code",
      );

      throw new PhoneVerificationProviderUnavailableException();
    }

    return this.response("VERIFIED", phoneNumber);
  }

  private async isAlreadyVerified(userId: string, phoneNumber: string): Promise<boolean> {
    const user = await this.databaseService.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, phoneVerifiedAt: true },
    });
    return user?.phoneNumber === phoneNumber && user.phoneVerifiedAt !== null;
  }

  private async enforceSendLimits(subjectId: string, phoneNumber: string): Promise<void> {
    const destination = createHmac("sha256", this.hashKey).update(phoneNumber).digest("hex");
    const limits = [
      { key: `phone-verification:subject:${subjectId}`, limit: 5, ttl: 10 * 60_000 },
      { key: `phone-verification:destination:${destination}`, limit: 5, ttl: 60 * 60_000 },
    ];
    for (const rule of limits) {
      const hit = await this.throttlerStorage.increment(
        rule.key,
        rule.ttl,
        rule.limit,
        rule.ttl,
        "phone-verification",
      );
      if (isThrottled(hit, rule.limit)) throw new ThrottlerException();
    }
  }

  private isInvalidCodeError(error: unknown): boolean {
    const { status, code } = this.twilioErrorContext(error);
    return status === 404 || code === 20404;
  }

  private twilioErrorContext(error: unknown): { status?: unknown; code?: unknown } {
    if (!error || typeof error !== "object") return {};
    return {
      ...("status" in error ? { status: error.status } : {}),
      ...("code" in error ? { code: error.code } : {}),
    };
  }

  private response(status: "PENDING" | "VERIFIED", phoneNumber: string) {
    return { status, phoneNumber: this.maskPhone(phoneNumber) };
  }

  private maskPhone(phoneNumber: string): string {
    return `${"*".repeat(Math.max(0, phoneNumber.length - 4))}${phoneNumber.slice(-4)}`;
  }
}
