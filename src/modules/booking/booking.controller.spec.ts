import { RequestMethod, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { ThrottlerGuard } from "@nestjs/throttler";
import { BookingStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuthService } from "../auth/auth.service";
import { OptionalSessionGuard } from "../auth/guards/optional-session.guard";
import { PhoneVerificationService } from "../verification/phone-verification.service";
import { VerificationThrottlerGuard } from "../verification/verification-throttler.guard";
import { BookingController } from "./booking.controller";
import {
  BookingRequestInProgressException,
  BookingValidationException,
  ExtensionRequestInProgressException,
} from "./booking.error";
import { BookingCancellationService } from "./booking-cancellation.service";
import { BookingCreationService } from "./booking-creation.service";
import { BookingExtensionService } from "./booking-extension.service";
import { BookingPricingPreviewService } from "./booking-pricing-preview.service";
import { BookingReadService } from "./booking-read.service";
import { BookingReceiptService } from "./booking-receipt.service";
import { BookingReceiptAccessGuard } from "./booking-receipt-access.guard";
import { BookingReceiptThrottlerGuard } from "./booking-receipt-throttler.guard";
import { BookingUpdateService } from "./booking-update.service";
import {
  type CreateBookingDto,
  type CreateBookingInput,
  type CreateGuestBookingDto,
  createBookingSchema,
  createGuestBookingSchema,
} from "./dto/create-booking.dto";
import { GuestBookingAccessService } from "./guest-booking-access.service";
import { matchesGuestPhoneVerificationToken } from "./guest-phone-verification-token.helper";

/**
 * Helper function to validate booking input (simulates the decorator behavior)
 */
function validateBookingInput(rawBody: unknown, isAuthenticated: boolean): CreateBookingInput {
  const schema = isAuthenticated ? createBookingSchema : createGuestBookingSchema;
  const pipe = new ZodValidationPipe(schema, {
    exceptionFactory: (errors) => new BookingValidationException(errors),
  });
  return pipe.transform(rawBody);
}

const CAR_ID = "01994a1d-4263-7000-8000-000000000001";

const GUEST_PHONE_SECRET = "guest-phone-verification-test-secret";

describe("BookingController", () => {
  let controller: BookingController;
  let bookingCreationService: BookingCreationService;
  let phoneVerificationService: {
    sendCode: ReturnType<typeof vi.fn>;
    checkCode: ReturnType<typeof vi.fn>;
  };
  let bookingExtensionService: BookingExtensionService;
  let bookingReceiptService: BookingReceiptService;
  let bookingCancellationService: BookingCancellationService;

  const mockCreateBookingResponse = {
    bookingId: "booking-123",
    txRef: "booking-123",
    checkoutUrl: "https://checkout.flutterwave.com/pay/abc123",
    totalAmount: 56437.5,
    currency: "NGN" as const,
    bookingStatus: BookingStatus.PENDING,
    reservationExpiresAt: "2026-08-02T20:10:00.000Z",
  };

  const mockSessionUser = {
    id: "user-123",
    email: "user@example.com",
    name: "Test User",
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["user" as const],
  };

  const createValidBookingDto = (): CreateBookingDto => ({
    carId: CAR_ID,
    startDate: new Date("2025-02-01T09:00:00Z"),
    endDate: new Date("2025-02-01T21:00:00Z"),
    pickupAddress: "123 Main St, Lagos",
    bookingType: "DAY",
    pickupTime: "9:00 AM",
    sameLocation: true,
    addonIds: [],
    requiresFullTank: false,
    useCredits: 0,
    expectedTotalAmount: "56437.50",
  });
  const createMockResponse = () => ({ setHeader: vi.fn() }) as unknown as Response;

  const createValidGuestBookingDto = (): CreateGuestBookingDto => ({
    ...createValidBookingDto(),
    guestEmail: "guest@example.com",
    guestName: "Guest User",
    guestPhone: "+2348098765432",
  });

  beforeEach(async () => {
    const mockBookingCreationService = {
      createBooking: vi.fn().mockResolvedValue(mockCreateBookingResponse),
    };
    const mockBookingExtensionService = {
      createExtension: vi.fn(),
    };
    const mockBookingPricingPreviewService = {
      preview: vi.fn(),
    };
    const mockBookingReadService = {
      getBookingsByStatus: vi.fn(),
      getBookingById: vi.fn(),
    };
    const mockBookingReceiptService = {
      generateReceipt: vi.fn().mockResolvedValue({
        buffer: Buffer.from("%PDF-1.7"),
        fileName: "Tripdly-receipt-TRIP-123.pdf",
      }),
    };
    const mockBookingUpdateService = {
      updateBooking: vi.fn(),
    };
    const mockBookingCancellationService = {
      cancelBooking: vi.fn(),
    };
    const mockGuestBookingAccessService = {
      requestAccess: vi.fn(),
      getBooking: vi.fn(),
    };
    phoneVerificationService = {
      sendCode: vi.fn().mockResolvedValue({ status: "PENDING", phoneNumber: "**********5678" }),
      checkCode: vi.fn().mockResolvedValue({ status: "VERIFIED", phoneNumber: "**********5678" }),
    };

    const mockAuthService = {
      isInitialized: true,
      auth: {
        api: {
          getSession: vi.fn().mockResolvedValue(null),
        },
      },
      getUserRoles: vi.fn().mockResolvedValue(["user"]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BookingController],
      providers: [
        { provide: BookingCreationService, useValue: mockBookingCreationService },
        { provide: BookingExtensionService, useValue: mockBookingExtensionService },
        { provide: BookingPricingPreviewService, useValue: mockBookingPricingPreviewService },
        { provide: BookingReadService, useValue: mockBookingReadService },
        { provide: BookingReceiptService, useValue: mockBookingReceiptService },
        { provide: BookingUpdateService, useValue: mockBookingUpdateService },
        { provide: BookingCancellationService, useValue: mockBookingCancellationService },
        { provide: GuestBookingAccessService, useValue: mockGuestBookingAccessService },
        { provide: PhoneVerificationService, useValue: phoneVerificationService },
        {
          provide: ConfigService,
          useValue: { get: vi.fn().mockReturnValue(GUEST_PHONE_SECRET) },
        },
        { provide: AuthService, useValue: mockAuthService },
        OptionalSessionGuard,
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .overrideGuard(VerificationThrottlerGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .overrideGuard(BookingReceiptAccessGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .overrideGuard(BookingReceiptThrottlerGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .useMocker(mockPinoLoggerToken)
      .compile();

    controller = module.get<BookingController>(BookingController);
    bookingCreationService = module.get<BookingCreationService>(BookingCreationService);
    bookingExtensionService = module.get<BookingExtensionService>(BookingExtensionService);
    bookingReceiptService = module.get<BookingReceiptService>(BookingReceiptService);
    bookingCancellationService = module.get<BookingCancellationService>(BookingCancellationService);
  });
  describe("guest phone verification", () => {
    const guestRequest = {
      ip: "203.0.113.99",
      headers: {
        "x-forwarded-for": "203.0.113.99",
        "fly-client-ip": "198.51.100.20",
      },
    } as unknown as Request;

    it("reuses phone verification for guest send and check routes", async () => {
      const send = BookingController.prototype.sendGuestPhoneVerification;
      const check = BookingController.prototype.checkGuestPhoneVerification;

      expect(Reflect.getMetadata(PATH_METADATA, send)).toBe("guest-phone-verifications");
      expect(Reflect.getMetadata(METHOD_METADATA, send)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(GUARDS_METADATA, send)).toContain(VerificationThrottlerGuard);
      expect(Reflect.getMetadata(PATH_METADATA, check)).toBe("guest-phone-verification-checks");
      expect(Reflect.getMetadata(METHOD_METADATA, check)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(GUARDS_METADATA, check)).toContain(VerificationThrottlerGuard);

      await expect(
        controller.sendGuestPhoneVerification(guestRequest, { phoneNumber: "+2348012345678" }),
      ).resolves.toEqual({ status: "PENDING", phoneNumber: "**********5678" });
      expect(phoneVerificationService.sendCode).toHaveBeenCalledWith(
        "guest-booking:198.51.100.20",
        "+2348012345678",
      );

      const checked = await controller.checkGuestPhoneVerification(guestRequest, {
        phoneNumber: "+2348012345678",
        code: "123456",
      });
      expect(phoneVerificationService.checkCode).toHaveBeenCalledWith(
        "guest-booking:198.51.100.20",
        "+2348012345678",
        "123456",
      );
      expect(
        matchesGuestPhoneVerificationToken(
          checked.verificationToken,
          "+2348012345678",
          GUEST_PHONE_SECRET,
        ),
      ).toBe(true);
      expect(
        matchesGuestPhoneVerificationToken(
          checked.verificationToken,
          "+2348099999999",
          GUEST_PHONE_SECRET,
        ),
      ).toBe(false);
    });
  });

  describe("createBooking", () => {
    describe("authenticated user", () => {
      it("should throw BookingValidationException for invalid booking data", async () => {
        const invalidDto = {
          carId: "", // Invalid - empty
          startDate: new Date("2025-02-01"),
          endDate: new Date("2025-02-01"),
          pickupAddress: "123 Main St",
          bookingType: "DAY",
          // Missing pickupTime (required for DAY)
          sameLocation: true,
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(invalidDto, true)).toThrow(BookingValidationException);
      });
    });

    describe("guest user", () => {
      it("should throw BookingValidationException if guest fields are missing", async () => {
        const dto = createValidBookingDto(); // Missing guest fields

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });

      it("should validate guest email format", async () => {
        const dto = {
          ...createValidGuestBookingDto(),
          guestEmail: "invalid-email", // Invalid format
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });

      it("should validate guest name minimum length", async () => {
        const dto = {
          ...createValidGuestBookingDto(),
          guestName: "A", // Too short
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });

      it("requires guest phones in E.164 format", async () => {
        const dto = {
          ...createValidGuestBookingDto(),
          guestPhone: "08098765432",
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, false)).toThrow(BookingValidationException);
      });
    });

    describe("validation", () => {
      it("sets Retry-After when an identical request is processing", async () => {
        const response = createMockResponse();
        vi.mocked(bookingCreationService.createBooking).mockRejectedValueOnce(
          new BookingRequestInProgressException(5),
        );

        await expect(
          controller.createBooking(
            createValidBookingDto(),
            mockSessionUser,
            "booking-request-123",
            response,
          ),
        ).rejects.toThrow(BookingRequestInProgressException);
        expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "5");
      });

      it("should validate dropOffAddress is required when sameLocation is false", async () => {
        const dto = {
          ...createValidBookingDto(),
          sameLocation: false,
          // Missing dropOffAddress
        };

        // Validation should throw before reaching controller
        expect(() => validateBookingInput(dto, true)).toThrow(BookingValidationException);
      });

      it("should accept booking with different drop-off location", async () => {
        const dto = {
          ...createValidBookingDto(),
          sameLocation: false as const,
          dropOffAddress: "456 Other St, Lagos",
        };
        const validatedDto = validateBookingInput(dto, true);

        const result = await controller.createBooking(
          validatedDto,
          mockSessionUser,
          "booking-request-123",
          createMockResponse(),
        );

        expect(result).toEqual(mockCreateBookingResponse);
        expect(bookingCreationService.createBooking).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              sameLocation: false,
              dropOffAddress: "456 Other St, Lagos",
            }),
            sessionUser: expect.any(Object),
          }),
        );
      });
    });
  });

  describe("createExtension", () => {
    it("rejects createExtension when session user is missing", async () => {
      for (const sessionUser of [null, undefined]) {
        await expect(
          controller.createExtension(
            "booking-123",
            {
              hours: 2,
              callbackUrl: "https://example.com/extension-payment-status",
            },
            sessionUser,
            "extension-request-123",
            createMockResponse(),
          ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(bookingExtensionService.createExtension).not.toHaveBeenCalled();
    });

    it("sets Retry-After when an identical extension request is processing", async () => {
      const response = createMockResponse();
      vi.mocked(bookingExtensionService.createExtension).mockRejectedValueOnce(
        new ExtensionRequestInProgressException(5),
      );

      await expect(
        controller.createExtension(
          "booking-123",
          {
            hours: 2,
            callbackUrl: "https://example.com/extension-payment-status",
          },
          mockSessionUser,
          "extension-request-123",
          response,
        ),
      ).rejects.toBeInstanceOf(ExtensionRequestInProgressException);
      expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "5");
    });
  });

  describe("getBookingReceipt", () => {
    it("writes attachment headers only after receipt generation succeeds", async () => {
      const response = {
        setHeader: vi.fn(),
        send: vi.fn(),
      } as unknown as Response;

      await controller.getBookingReceipt("booking-123", mockSessionUser, "g".repeat(43), response);

      expect(bookingReceiptService.generateReceipt).toHaveBeenCalledWith(
        "booking-123",
        mockSessionUser,
        "g".repeat(43),
      );
      expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
      expect(response.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        'attachment; filename="Tripdly-receipt-TRIP-123.pdf"',
      );
      expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
      expect(response.setHeader).toHaveBeenCalledWith("Content-Length", "8");
      expect(response.send).toHaveBeenCalledWith(Buffer.from("%PDF-1.7"));
    });
  });

  describe("cancelBooking", () => {
    it("uses default reason when none provided", async () => {
      await controller.cancelBooking("booking-123", {}, mockSessionUser);

      expect(bookingCancellationService.cancelBooking).toHaveBeenCalledWith(
        "booking-123",
        "user-123",
        "User requested cancellation",
      );
    });
  });
});
