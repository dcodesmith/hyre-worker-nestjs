import { createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { ThrottlerException, ThrottlerStorage } from "@nestjs/throttler";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { DatabaseService } from "../database/database.service";
import {
  PhoneVerificationCodeInvalidException,
  PhoneVerificationProviderUnavailableException,
} from "./account-verification.error";
import { PhoneVerificationService } from "./phone-verification.service";

const twilioMocks = vi.hoisted(() => ({
  createVerification: vi.fn(),
  createVerificationCheck: vi.fn(),
}));

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: { create: twilioMocks.createVerification },
          verificationChecks: { create: twilioMocks.createVerificationCheck },
        })),
      },
    },
  })),
}));

const USER_ID = "user-1";
const PHONE = "+2348012345678";
const MASKED_PHONE = "**********5678";
const HMAC_KEY = "test-hmac-key";
const DESTINATION_KEY = `phone-verification:destination:${createHmac("sha256", HMAC_KEY).update(PHONE).digest("hex")}`;

const allowedHit = { totalHits: 1, timeToExpire: 60_000, isBlocked: false, timeToBlockExpire: 0 };

describe("PhoneVerificationService", () => {
  let service: PhoneVerificationService;
  let databaseService: {
    user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  };
  let throttlerStorage: { increment: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    twilioMocks.createVerification.mockReset();
    twilioMocks.createVerificationCheck.mockReset();
    databaseService = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ phoneNumber: null, phoneVerifiedAt: null }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    throttlerStorage = {
      increment: vi.fn().mockResolvedValue(allowedHit),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PhoneVerificationService,
        { provide: DatabaseService, useValue: databaseService },
        { provide: ThrottlerStorage, useValue: throttlerStorage },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              if (key === "TWILIO_ACCOUNT_SID") return "AC123";
              if (key === "TWILIO_AUTH_TOKEN") return "token";
              if (key === "TWILIO_VERIFY_SERVICE_SID") return "VA123";
              if (key === "HMAC_KEY") return HMAC_KEY;
              return undefined;
            }),
          },
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(PhoneVerificationService);
    logger = module.get(PinoLogger);
  });

  describe("send", () => {
    it("sends an SMS code and returns a masked pending response", async () => {
      twilioMocks.createVerification.mockResolvedValueOnce({ status: "pending" });

      await expect(service.send(USER_ID, { phoneNumber: PHONE })).resolves.toEqual({
        status: "PENDING",
        phoneNumber: MASKED_PHONE,
      });
      expect(twilioMocks.createVerification).toHaveBeenCalledWith({
        channel: "sms",
        to: PHONE,
      });
      expect(throttlerStorage.increment).toHaveBeenCalledWith(
        `phone-verification:subject:user:${USER_ID}`,
        10 * 60_000,
        5,
        10 * 60_000,
        "phone-verification",
      );
      expect(throttlerStorage.increment).toHaveBeenCalledWith(
        DESTINATION_KEY,
        60 * 60_000,
        5,
        60 * 60_000,
        "phone-verification",
      );
    });

    it("is idempotent when the same number is already verified", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        phoneNumber: PHONE,
        phoneVerifiedAt: new Date(),
      });

      await expect(service.send(USER_ID, { phoneNumber: PHONE })).resolves.toEqual({
        status: "VERIFIED",
        phoneNumber: MASKED_PHONE,
      });
      expect(twilioMocks.createVerification).not.toHaveBeenCalled();
      expect(throttlerStorage.increment).not.toHaveBeenCalled();
    });

    it("throttles repeated sends for the same user", async () => {
      throttlerStorage.increment.mockResolvedValueOnce({
        ...allowedHit,
        totalHits: 6,
        isBlocked: true,
      });

      await expect(service.send(USER_ID, { phoneNumber: PHONE })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
      expect(twilioMocks.createVerification).not.toHaveBeenCalled();
      expect(throttlerStorage.increment).toHaveBeenCalledTimes(1);
      expect(throttlerStorage.increment).toHaveBeenCalledWith(
        `phone-verification:subject:user:${USER_ID}`,
        10 * 60_000,
        5,
        10 * 60_000,
        "phone-verification",
      );
    });

    it("throttles repeated sends to the same destination across users", async () => {
      throttlerStorage.increment
        .mockResolvedValueOnce(allowedHit)
        .mockResolvedValueOnce({ ...allowedHit, totalHits: 6, isBlocked: true });

      await expect(service.send(USER_ID, { phoneNumber: PHONE })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
      expect(twilioMocks.createVerification).not.toHaveBeenCalled();
      expect(throttlerStorage.increment).toHaveBeenNthCalledWith(
        2,
        DESTINATION_KEY,
        60 * 60_000,
        5,
        60 * 60_000,
        "phone-verification",
      );
    });

    it("sends again when a different number is already verified", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        phoneNumber: "+2348099999999",
        phoneVerifiedAt: new Date(),
      });
      twilioMocks.createVerification.mockResolvedValueOnce({ status: "pending" });

      await expect(service.send(USER_ID, { phoneNumber: PHONE })).resolves.toEqual({
        status: "PENDING",
        phoneNumber: MASKED_PHONE,
      });
    });

    it("maps a non-pending Twilio status to provider unavailable", async () => {
      twilioMocks.createVerification.mockResolvedValueOnce({ status: "canceled" });

      await expect(service.send(USER_ID, { phoneNumber: PHONE })).rejects.toBeInstanceOf(
        PhoneVerificationProviderUnavailableException,
      );
    });

    it("maps a Twilio send failure to provider unavailable", async () => {
      twilioMocks.createVerification.mockRejectedValueOnce({
        status: 401,
        code: 20003,
        message: "Authenticate",
      });

      await expect(service.send(USER_ID, { phoneNumber: PHONE })).rejects.toBeInstanceOf(
        PhoneVerificationProviderUnavailableException,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { subjectId: `user:${USER_ID}`, phone: MASKED_PHONE, status: 401, code: 20003 },
        "Twilio could not send a phone verification code",
      );
    });
  });

  describe("check", () => {
    it("approves a valid code, stores the number, and returns a masked verified response", async () => {
      twilioMocks.createVerificationCheck.mockResolvedValueOnce({ status: "approved" });

      await expect(service.check(USER_ID, { phoneNumber: PHONE, code: "123456" })).resolves.toEqual(
        {
          status: "VERIFIED",
          phoneNumber: MASKED_PHONE,
        },
      );
      expect(databaseService.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { phoneNumber: PHONE, phoneVerifiedAt: expect.any(Date) },
      });
    });

    it("is idempotent when the same number is already verified", async () => {
      databaseService.user.findUnique.mockResolvedValueOnce({
        phoneNumber: PHONE,
        phoneVerifiedAt: new Date(),
      });

      await expect(service.check(USER_ID, { phoneNumber: PHONE, code: "123456" })).resolves.toEqual(
        {
          status: "VERIFIED",
          phoneNumber: MASKED_PHONE,
        },
      );
      expect(twilioMocks.createVerificationCheck).not.toHaveBeenCalled();
      expect(databaseService.user.update).not.toHaveBeenCalled();
    });

    it("rejects a non-approved Twilio check as an invalid or expired code", async () => {
      twilioMocks.createVerificationCheck.mockResolvedValueOnce({ status: "pending" });

      await expect(
        service.check(USER_ID, { phoneNumber: PHONE, code: "000000" }),
      ).rejects.toBeInstanceOf(PhoneVerificationCodeInvalidException);
      expect(databaseService.user.update).not.toHaveBeenCalled();
    });

    it.each([{ status: 404, code: 20404 }, { status: 404 }, { code: 20404 }])(
      "maps Twilio invalid-code error %j to an invalid code exception",
      async (error) => {
        twilioMocks.createVerificationCheck.mockRejectedValueOnce(error);

        await expect(
          service.check(USER_ID, { phoneNumber: PHONE, code: "999999" }),
        ).rejects.toBeInstanceOf(PhoneVerificationCodeInvalidException);
      },
    );

    it("maps an unexpected Twilio check failure to provider unavailable", async () => {
      twilioMocks.createVerificationCheck.mockRejectedValueOnce({ status: 500, code: 20500 });

      await expect(
        service.check(USER_ID, { phoneNumber: PHONE, code: "123456" }),
      ).rejects.toBeInstanceOf(PhoneVerificationProviderUnavailableException);
      expect(logger.warn).toHaveBeenCalledWith(
        { subjectId: `user:${USER_ID}`, phone: MASKED_PHONE, status: 500, code: 20500 },
        "Twilio could not check a phone verification code",
      );
    });
  });

  describe("sendCode", () => {
    it("sends an SMS code for a generic subject without writing a user row", async () => {
      twilioMocks.createVerification.mockResolvedValueOnce({ status: "pending" });

      await expect(service.sendCode("chauffeur:ver-1", PHONE)).resolves.toEqual({
        status: "PENDING",
        phoneNumber: MASKED_PHONE,
      });
      expect(databaseService.user.findUnique).not.toHaveBeenCalled();
      expect(throttlerStorage.increment).toHaveBeenCalledWith(
        "phone-verification:subject:chauffeur:ver-1",
        10 * 60_000,
        5,
        10 * 60_000,
        "phone-verification",
      );
    });
  });

  describe("checkCode", () => {
    it("approves a valid code without persisting a user phone number", async () => {
      twilioMocks.createVerificationCheck.mockResolvedValueOnce({ status: "approved" });

      await expect(service.checkCode("chauffeur:ver-1", PHONE, "123456")).resolves.toEqual({
        status: "VERIFIED",
        phoneNumber: MASKED_PHONE,
      });
      expect(databaseService.user.update).not.toHaveBeenCalled();
    });

    it("rejects a non-approved Twilio check as an invalid or expired code", async () => {
      twilioMocks.createVerificationCheck.mockResolvedValueOnce({ status: "pending" });

      await expect(service.checkCode("chauffeur:ver-1", PHONE, "000000")).rejects.toBeInstanceOf(
        PhoneVerificationCodeInvalidException,
      );
    });
  });
});
