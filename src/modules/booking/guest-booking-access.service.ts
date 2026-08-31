import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DocumentStatus } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { getEmailPublicEnv } from "../../email-public-env";
import { maskEmail } from "../../shared/helper";
import { renderGuestBookingAccessEmail } from "../../templates/emails";
import type { GuestUserDetails } from "../../types";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../email/email.service";
import { BookingNotFoundException } from "./booking.error";
import type {
  GuestBookingAccessRequestResponse,
  GuestBookingDetailsResponse,
} from "./booking.interface";
import type {
  GuestBookingAccessQueryDto,
  GuestBookingAccessRequestDto,
} from "./dto/guest-booking-access.dto";
import { guestBookingAccessTokenSchema } from "./dto/guest-booking-access.dto";

const GUEST_ACCESS_TTL_MINUTES = 15;
const GUEST_ACCESS_TTL_MS = GUEST_ACCESS_TTL_MINUTES * 60 * 1000;
const GUEST_ACCESS_RESPONSE: GuestBookingAccessRequestResponse = {
  message: "If those booking details match, we sent an access link to the booking email.",
};

@Injectable()
export class GuestBookingAccessService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly emailService: EmailService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GuestBookingAccessService.name);
  }

  async requestAccess(
    input: GuestBookingAccessRequestDto,
  ): Promise<GuestBookingAccessRequestResponse> {
    const booking = await this.databaseService.booking.findUnique({
      where: { bookingReference: input.bookingReference },
      select: { id: true, bookingReference: true, userId: true, guestUser: true },
    });
    const guest = this.getGuest(booking?.guestUser);
    const guestEmail = guest?.email?.trim();
    const canReceiveEmail =
      guest?.guestContactSource !== "WHATSAPP_AGENT" &&
      guest?.preferredNotificationChannel !== "WHATSAPP_ONLY";

    if (!booking?.userId && canReceiveEmail && guestEmail?.toLowerCase() === input.email) {
      void this.issueAccessLink(booking.id, booking.bookingReference, {
        ...guest,
        email: guestEmail,
      }).catch((error) => {
        this.logger.error(
          {
            bookingId: booking.id,
            email: maskEmail(input.email),
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to issue guest booking access link",
        );
      });
    }

    return GUEST_ACCESS_RESPONSE;
  }

  async getBooking(query: GuestBookingAccessQueryDto): Promise<GuestBookingDetailsResponse> {
    const tokenHash = this.hashToken(query.token);
    const booking = await this.databaseService.booking.findFirst({
      where: {
        guestAccessTokenHash: tokenHash,
        guestAccessTokenExpiresAt: { gt: new Date() },
        userId: null,
        deletedAt: null,
      },
      select: {
        id: true,
        bookingReference: true,
        status: true,
        paymentStatus: true,
        type: true,
        startDate: true,
        endDate: true,
        pickupLocation: true,
        returnLocation: true,
        specialRequests: true,
        cancellationReason: true,
        flightNumber: true,
        totalAmount: true,
        guestAccessTokenExpiresAt: true,
        car: {
          select: {
            make: true,
            model: true,
            year: true,
            images: {
              where: { status: DocumentStatus.APPROVED },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
              select: { url: true },
            },
          },
        },
        chauffeur: { select: { name: true, phoneNumber: true } },
        legs: {
          orderBy: { legDate: "asc" },
          select: {
            id: true,
            legDate: true,
            legStartTime: true,
            legEndTime: true,
            extensions: {
              orderBy: { extensionStartTime: "asc" },
              select: {
                id: true,
                extensionStartTime: true,
                extensionEndTime: true,
                extendedDurationHours: true,
                status: true,
                paymentStatus: true,
              },
            },
          },
        },
      },
    });

    if (!booking?.guestAccessTokenExpiresAt) {
      throw new BookingNotFoundException();
    }

    return {
      bookingId: booking.id,
      bookingReference: booking.bookingReference,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      bookingType: booking.type,
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      pickupLocation: booking.pickupLocation,
      returnLocation: booking.returnLocation,
      specialRequests: booking.specialRequests,
      cancellationReason: booking.cancellationReason,
      flightNumber: booking.flightNumber,
      totalAmount: booking.totalAmount.toNumber(),
      currency: "NGN",
      accessExpiresAt: booking.guestAccessTokenExpiresAt.toISOString(),
      car: {
        make: booking.car.make,
        model: booking.car.model,
        year: booking.car.year,
        images: booking.car.images.map(({ url }) => url),
      },
      chauffeur: booking.chauffeur,
      legs: booking.legs.map((leg) => ({
        id: leg.id,
        legDate: leg.legDate.toISOString(),
        legStartTime: leg.legStartTime.toISOString(),
        legEndTime: leg.legEndTime.toISOString(),
        extensions: leg.extensions.map((extension) => ({
          ...extension,
          extensionStartTime: extension.extensionStartTime.toISOString(),
          extensionEndTime: extension.extensionEndTime.toISOString(),
        })),
      })),
    };
  }

  async assertBookingAccess(bookingId: string, token: string): Promise<void> {
    if (!guestBookingAccessTokenSchema.safeParse(token).success) {
      throw new BookingNotFoundException();
    }

    const booking = await this.databaseService.booking.findFirst({
      where: {
        id: bookingId,
        guestAccessTokenHash: this.hashToken(token),
        guestAccessTokenExpiresAt: { gt: new Date() },
        userId: null,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!booking) throw new BookingNotFoundException();
  }

  private async issueAccessLink(
    bookingId: string,
    bookingReference: string,
    guest: GuestUserDetails & { email: string },
  ): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.hashToken(token);
    const now = new Date();
    const expiresAt = new Date(Date.now() + GUEST_ACCESS_TTL_MS);
    const claim = await this.databaseService.booking.updateMany({
      where: {
        id: bookingId,
        userId: null,
        deletedAt: null,
        OR: [
          { guestAccessTokenHash: null },
          { guestAccessTokenExpiresAt: null },
          { guestAccessTokenExpiresAt: { lte: now } },
        ],
      },
      data: {
        guestAccessTokenHash: tokenHash,
        guestAccessTokenExpiresAt: expiresAt,
      },
    });
    if (claim.count === 0) {
      return;
    }

    try {
      const accessUrl = new URL("/bookings/guest", getEmailPublicEnv().websiteUrl);
      accessUrl.searchParams.set("token", token);
      const html = await renderGuestBookingAccessEmail({
        recipientName: guest.name?.trim() || "there",
        bookingReference,
        accessUrl: accessUrl.toString(),
        expiresInMinutes: GUEST_ACCESS_TTL_MINUTES,
      });
      await this.emailService.sendEmail({
        to: guest.email,
        subject: `View booking ${bookingReference}`,
        html,
      });
    } catch (error) {
      await this.databaseService.booking.updateMany({
        where: { id: bookingId, guestAccessTokenHash: tokenHash },
        data: { guestAccessTokenHash: null, guestAccessTokenExpiresAt: null },
      });
      throw error;
    }
  }

  private getGuest(value: unknown): GuestUserDetails | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as GuestUserDetails)
      : null;
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
