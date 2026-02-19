import type { INestApplication } from "@nestjs/common";
import type { PayoutTransactionStatus, Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";

// ============================================================================
// Test Data Factory Types (using Prisma UncheckedCreateInput for direct FK usage)
// ============================================================================

export type CreateUserOptions = Partial<Prisma.UserUncheckedCreateInput> & {
  roles?: string[];
};

export type CreateCarOptions = Partial<Prisma.CarUncheckedCreateInput>;

export type CreateBookingOptions = Partial<Prisma.BookingUncheckedCreateInput>;

export type CreateBookingLegOptions = Partial<Prisma.BookingLegUncheckedCreateInput>;

export type CreateExtensionOptions = Partial<Prisma.ExtensionUncheckedCreateInput>;

export type CreatePaymentOptions = Partial<Prisma.PaymentUncheckedCreateInput>;

export type CreatePayoutTransactionOptions = Partial<Prisma.PayoutTransactionUncheckedCreateInput>;

export type CreateReviewOptions = Partial<Prisma.ReviewUncheckedCreateInput>;

export type AuthRole = "user" | "fleetOwner" | "admin";

export type ClientTypeOption = "mobile" | "web";

/**
 * Maps auth roles to their corresponding web client referer paths.
 */
const WEB_ROLE_PATHS: Record<AuthRole, string> = {
  user: "/auth",
  fleetOwner: "/fleet-owner/signup",
  admin: "/admin/dashboard",
};

// ============================================================================
// Test Data Factory
// ============================================================================

/**
 * Factory class for creating test data in E2E tests.
 * Instantiate once with the database service and use throughout the test suite.
 *
 * @example Basic usage (data creation only)
 * ```typescript
 * let factory: TestDataFactory;
 *
 * beforeAll(async () => {
 *   databaseService = app.get(DatabaseService);
 *   factory = new TestDataFactory(databaseService);
 *
 *   const fleetOwner = await factory.createFleetOwner();
 *   const car = await factory.createCar(fleetOwner.id);
 *   const booking = await factory.createBooking(userId, car.id);
 * });
 * ```
 *
 * @example With authentication support
 * ```typescript
 * let factory: TestDataFactory;
 *
 * beforeAll(async () => {
 *   databaseService = app.get(DatabaseService);
 *   factory = new TestDataFactory(databaseService, app);
 *
 *   const { cookie, user } = await factory.authenticateAndGetUser(email, "user");
 *   const adminResult = await factory.createAuthenticatedAdmin(adminEmail);
 * });
 * ```
 */
export class TestDataFactory {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly app?: INestApplication,
  ) {}

  /**
   * Assign a role to an existing user.
   * Use this when you need to add roles to users created through the auth flow.
   */
  async assignRole(userId: string, roleName: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { roles: { connect: { name: roleName } } },
    });
  }

  /**
   * Returns the appropriate auth headers for the given client type and role.
   * Mobile clients use `X-Client-Type: mobile`.
   * Web clients use `Origin` + role-aware `Referer` headers.
   */
  private getAuthHeaders(clientType: ClientTypeOption, role: AuthRole): Record<string, string> {
    if (clientType === "mobile") {
      return { "X-Client-Type": "mobile" };
    }
    const path = WEB_ROLE_PATHS[role] ?? "/auth";
    return {
      Origin: "http://localhost:3000",
      Referer: `http://localhost:3000${path}`,
    };
  }

  /**
   * Authenticate a user via OTP flow and return the session cookie.
   * Automatically clears rate limits before authentication.
   * Requires the factory to be initialized with an app instance.
   *
   * @param email - The email address to authenticate
   * @param role - The role to request during authentication
   * @param clientType - "mobile" uses X-Client-Type header, "web" uses Origin/Referer headers
   * @throws Error if app instance was not provided to the factory
   */
  async authenticateAndGetCookie(
    email: string,
    role: AuthRole = "user",
    clientType: ClientTypeOption = "mobile",
  ): Promise<string> {
    if (!this.app) {
      throw new Error("TestDataFactory requires app instance for authentication methods");
    }

    // Clear rate limits before auth to avoid test interference
    await this.clearRateLimits();

    const authHeaders = this.getAuthHeaders(clientType, role);

    // Send OTP
    await request(this.app.getHttpServer())
      .post("/auth/api/email-otp/send-verification-otp")
      .set(authHeaders)
      .send({ email, type: "sign-in", role });

    // Get OTP from database
    const verification = await this.prisma.verification.findFirst({
      where: { identifier: `sign-in-otp-${email}` },
      orderBy: { createdAt: "desc" },
    });

    if (!verification) {
      throw new Error(`OTP verification record not found for ${email}. OTP send may have failed.`);
    }

    const otp = verification.value.split(":")[0];

    // Verify OTP
    const verifyResponse = await request(this.app.getHttpServer())
      .post("/auth/api/sign-in/email-otp")
      .set(authHeaders)
      .send({ email, otp, role });

    const cookies = verifyResponse.headers["set-cookie"];

    if (!cookies) {
      throw new Error(`No session cookie set for ${email}. Status: ${verifyResponse.status}`);
    }

    return Array.isArray(cookies) ? cookies.join("; ") : cookies;
  }

  /**
   * Get user by email.
   */
  async getUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; name: string | null } | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true },
    });
  }

  /**
   * Convenience method to authenticate a user and get both cookie and user info.
   * Useful when you need the user ID after authentication.
   */
  async authenticateAndGetUser(
    email: string,
    role: AuthRole = "user",
    clientType: ClientTypeOption = "mobile",
  ): Promise<{ cookie: string; user: { id: string; email: string; name: string | null } }> {
    const cookie = await this.authenticateAndGetCookie(email, role, clientType);
    const user = await this.getUserByEmail(email);
    if (!user) {
      throw new Error(`User not found after authentication: ${email}`);
    }
    return { cookie, user };
  }

  /**
   * Convenience method to create an authenticated admin user.
   * Authenticates the user first, then assigns the admin role.
   * Returns both the cookie and user info.
   */
  async createAuthenticatedAdmin(email: string): Promise<{
    cookie: string;
    user: { id: string; email: string; name: string | null };
  }> {
    const { cookie, user } = await this.authenticateAndGetUser(email, "user");
    await this.assignRole(user.id, "admin");
    return { cookie, user };
  }

  /**
   * Clear all rate limits from the database.
   * Call this in beforeEach of E2E tests that involve rate-limited endpoints.
   */
  async clearRateLimits(): Promise<void> {
    await this.prisma.rateLimit.deleteMany();
  }

  /**
   * Create a test user directly in the database (bypasses auth flow).
   * Use this when you need a user without going through OTP authentication.
   */
  async createUser(
    options: CreateUserOptions = {},
  ): Promise<{ id: string; email: string; name: string | null }> {
    const email = options.email ?? uniqueEmail("test-user");
    const user = await this.prisma.user.create({
      data: {
        email,
        name: options.name ?? "Test User",
        emailVerified: options.emailVerified ?? true,
        roles: options.roles?.length
          ? { connect: options.roles.map((name) => ({ name })) }
          : undefined,
      },
      select: { id: true, email: true, name: true },
    });
    return user;
  }

  /**
   * Create a fleet owner user directly in the database.
   * Automatically assigns the fleetOwner role.
   */
  async createFleetOwner(options: Omit<CreateUserOptions, "roles"> = {}): Promise<{
    id: string;
    email: string;
    name: string | null;
  }> {
    return this.createUser({
      ...options,
      email: options.email ?? uniqueEmail("fleet-owner"),
      name: options.name ?? "Test Fleet Owner",
      roles: ["fleetOwner"],
    });
  }

  /**
   * Create a chauffeur user directly in the database.
   * Chauffeur is represented by the User model in booking relations.
   */
  async createChauffeur(options: Omit<CreateUserOptions, "roles"> = {}): Promise<{
    id: string;
    email: string;
    name: string | null;
  }> {
    return this.createUser({
      ...options,
      email: options.email ?? uniqueEmail("chauffeur"),
      name: options.name ?? "Test Chauffeur",
    });
  }

  /**
   * Create a test car in the database.
   */
  async createCar(ownerId: string, options: CreateCarOptions = {}): Promise<{ id: string }> {
    const car = await this.prisma.car.create({
      data: {
        make: options.make ?? "Toyota",
        model: options.model ?? "Camry",
        year: options.year ?? 2022,
        color: options.color ?? "Black",
        ownerId,
        registrationNumber:
          options.registrationNumber ??
          `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: options.status ?? "AVAILABLE",
        approvalStatus: options.approvalStatus ?? "APPROVED", // Required for booking
        hourlyRate: options.hourlyRate ?? 5000,
        dayRate: options.dayRate ?? 50000,
        nightRate: options.nightRate ?? 60000,
        fullDayRate: options.fullDayRate ?? 100000,
        airportPickupRate: options.airportPickupRate ?? 30000,
      },
      select: { id: true },
    });
    return car;
  }

  /**
   * Create a test booking in the database.
   */
  async createBooking(
    userId: string,
    carId: string,
    options: CreateBookingOptions = {},
  ): Promise<{ id: string; bookingReference: string }> {
    const booking = await this.prisma.booking.create({
      data: {
        userId,
        carId,
        startDate: options.startDate ?? new Date(),
        endDate: options.endDate ?? new Date(Date.now() + 86400000), // +1 day
        totalAmount: options.totalAmount ?? 50000,
        pickupLocation: options.pickupLocation ?? "Lagos Airport",
        returnLocation: options.returnLocation ?? "Victoria Island",
        status: options.status ?? "PENDING",
        paymentStatus: options.paymentStatus ?? "UNPAID",
        bookingReference:
          options.bookingReference ??
          `BOOK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(options.chauffeurId && { chauffeurId: options.chauffeurId }),
        ...(options.paymentIntent && { paymentIntent: options.paymentIntent }),
      },
      select: { id: true, bookingReference: true },
    });
    return booking;
  }

  /**
   * Create a test booking leg in the database.
   */
  async createBookingLeg(
    bookingId: string,
    options: CreateBookingLegOptions = {},
  ): Promise<{ id: string }> {
    const legStartTime = options.legStartTime ?? new Date();
    const legEndTime = options.legEndTime ?? new Date(Date.now() + 2 * 60 * 60 * 1000);

    const bookingLeg = await this.prisma.bookingLeg.create({
      data: {
        bookingId,
        legDate: options.legDate ?? legStartTime,
        totalDailyPrice: options.totalDailyPrice ?? 50000,
        notes: options.notes,
        legStartTime,
        legEndTime,
        fleetOwnerEarningForLeg: options.fleetOwnerEarningForLeg ?? 40000,
        itemsNetValueForLeg: options.itemsNetValueForLeg ?? 50000,
        platformCommissionAmountOnLeg: options.platformCommissionAmountOnLeg,
        platformCommissionRateOnLeg: options.platformCommissionRateOnLeg,
      },
      select: { id: true },
    });

    return bookingLeg;
  }

  /**
   * Create a test extension in the database.
   */
  async createExtension(
    bookingLegId: string,
    options: CreateExtensionOptions = {},
  ): Promise<{ id: string }> {
    let extensionStartTime: Date;
    if (options.extensionStartTime instanceof Date) {
      extensionStartTime = options.extensionStartTime;
    } else if (options.extensionStartTime) {
      extensionStartTime = new Date(options.extensionStartTime);
    } else {
      extensionStartTime = new Date();
    }
    const extensionEndTime =
      options.extensionEndTime ?? new Date(extensionStartTime.getTime() + 60 * 60 * 1000);

    const extension = await this.prisma.extension.create({
      data: {
        bookingLegId,
        totalAmount: options.totalAmount ?? 5000,
        paymentStatus: options.paymentStatus ?? "UNPAID",
        paymentId: options.paymentId,
        paymentIntent: options.paymentIntent,
        status: options.status ?? "PENDING",
        eventType: options.eventType ?? "HOURLY_ADDITION",
        extendedDurationHours: options.extendedDurationHours ?? 1,
        extensionStartTime,
        extensionEndTime,
        fleetOwnerPayoutAmountNet: options.fleetOwnerPayoutAmountNet,
        netTotal: options.netTotal,
        overallPayoutStatus: options.overallPayoutStatus,
        platformCustomerServiceFeeAmount: options.platformCustomerServiceFeeAmount,
        platformCustomerServiceFeeRatePercent: options.platformCustomerServiceFeeRatePercent,
        platformFleetOwnerCommissionAmount: options.platformFleetOwnerCommissionAmount,
        platformFleetOwnerCommissionRatePercent: options.platformFleetOwnerCommissionRatePercent,
        subtotalBeforeVat: options.subtotalBeforeVat,
        vatAmount: options.vatAmount,
        vatRatePercent: options.vatRatePercent,
      },
      select: { id: true },
    });

    return extension;
  }

  /**
   * Create a test payment in the database.
   */
  async createPayment(
    bookingId: string,
    options: CreatePaymentOptions = {},
  ): Promise<{ id: string; txRef: string }> {
    const payment = await this.prisma.payment.create({
      data: {
        txRef: options.txRef ?? `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        bookingId,
        amountExpected: options.amountExpected ?? 50000,
        amountCharged: options.amountCharged,
        currency: options.currency ?? "NGN",
        status: options.status ?? "PENDING",
        flutterwaveTransactionId: options.flutterwaveTransactionId,
        confirmedAt: options.confirmedAt,
      },
      select: { id: true, txRef: true },
    });
    return payment;
  }

  /**
   * Create a test review in the database.
   */
  async createReview(
    bookingId: string,
    userId: string,
    options: Omit<CreateReviewOptions, "bookingId" | "userId"> = {},
  ): Promise<{ id: string }> {
    const review = await this.prisma.review.create({
      data: {
        bookingId,
        userId,
        overallRating: options.overallRating ?? 5,
        carRating: options.carRating ?? 5,
        chauffeurRating: options.chauffeurRating ?? 5,
        serviceRating: options.serviceRating ?? 5,
        comment: options.comment === undefined ? "Great experience" : options.comment,
        isVisible: options.isVisible ?? true,
        moderatedAt: options.moderatedAt,
        moderatedBy: options.moderatedBy,
        moderationNotes: options.moderationNotes,
      },
      select: { id: true },
    });
    return review;
  }

  /**
   * Convenience method to create a booking with all its dependencies (fleet owner, car).
   * Use this when you just need a booking for testing and don't need fine-grained control
   * over the intermediate entities.
   *
   * @example
   * ```typescript
   * const booking = await factory.createBookingWithDependencies(userId);
   * ```
   */
  async createBookingWithDependencies(
    userId: string,
    options: {
      fleetOwner?: Omit<CreateUserOptions, "roles">;
      car?: CreateCarOptions;
      booking?: CreateBookingOptions;
    } = {},
  ): Promise<{ id: string; bookingReference: string }> {
    const fleetOwner = await this.createFleetOwner(options.fleetOwner);
    const car = await this.createCar(fleetOwner.id, options.car);
    return this.createBooking(userId, car.id, options.booking);
  }

  /**
   * Convenience method to create a completed booking with chauffeur assignment.
   * Useful for review lifecycle E2E tests.
   */
  async createCompletedBookingWithChauffeur(
    userId: string,
    options: {
      fleetOwner?: Omit<CreateUserOptions, "roles">;
      chauffeur?: Omit<CreateUserOptions, "roles">;
      car?: CreateCarOptions;
      booking?: CreateBookingOptions;
    } = {},
  ): Promise<{ id: string; bookingReference: string; chauffeurId: string; carId: string }> {
    const fleetOwner = await this.createFleetOwner(options.fleetOwner);
    const chauffeur = await this.createChauffeur(options.chauffeur);
    const car = await this.createCar(fleetOwner.id, options.car);
    const booking = await this.createBooking(userId, car.id, {
      ...options.booking,
      status: options.booking?.status ?? "COMPLETED",
      chauffeurId: options.booking?.chauffeurId ?? chauffeur.id,
    });

    return {
      ...booking,
      chauffeurId: chauffeur.id,
      carId: car.id,
    };
  }

  /**
   * Create a payout transaction in the database.
   */
  async createPayoutTransaction(
    fleetOwnerId: string,
    options: Omit<CreatePayoutTransactionOptions, "fleetOwnerId"> = {},
  ): Promise<{ id: string }> {
    const payoutTransaction = await this.prisma.payoutTransaction.create({
      data: {
        fleetOwnerId,
        bookingId: options.bookingId,
        extensionId: options.extensionId,
        amountToPay: options.amountToPay ?? 45000,
        currency: options.currency ?? "NGN",
        status: (options.status ?? "PROCESSING") as PayoutTransactionStatus,
        payoutProviderReference:
          options.payoutProviderReference ??
          `payout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      select: { id: true },
    });
    return payoutTransaction;
  }

  /**
   * Get a payment by ID.
   */
  async getPaymentById(paymentId: string) {
    return this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
  }

  /**
   * Get a payout transaction by ID.
   */
  async getPayoutTransactionById(payoutTransactionId: string) {
    return this.prisma.payoutTransaction.findUnique({
      where: { id: payoutTransactionId },
    });
  }

  /**
   * Get a booking by ID.
   */
  async getBookingById(bookingId: string) {
    return this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
  }

  /**
   * Get a car by ID.
   */
  async getCarById(carId: string) {
    return this.prisma.car.findUnique({
      where: { id: carId },
    });
  }

  /**
   * Get a review by ID.
   */
  async getReviewById(reviewId: string) {
    return this.prisma.review.findUnique({
      where: { id: reviewId },
    });
  }

  /**
   * Get the most recent payment for a booking.
   */
  async getPaymentByBookingId(bookingId: string) {
    return this.prisma.payment.findFirst({
      where: { bookingId },
      orderBy: { initiatedAt: "desc" },
    });
  }

  /**
   * Create platform rates required for booking calculations.
   * Creates platform fee rate, fleet owner commission rate, VAT rate, and security detail addon rate.
   * Must be called before booking creation tests.
   */
  async createPlatformRates(): Promise<void> {
    const effectiveSince = new Date("2020-01-01");
    await Promise.all([
      this.prisma.platformFeeRate.createMany({
        data: [
          {
            feeType: "PLATFORM_SERVICE_FEE",
            ratePercent: 10,
            effectiveSince,
            description: "Platform service fee for customers",
          },
          {
            feeType: "FLEET_OWNER_COMMISSION",
            ratePercent: 15,
            effectiveSince,
            description: "Platform commission from fleet owner earnings",
          },
        ],
        skipDuplicates: true,
      }),
      this.prisma.taxRate.createMany({
        data: [
          {
            ratePercent: 7.5,
            effectiveSince,
            description: "Value Added Tax",
          },
        ],
        skipDuplicates: true,
      }),
      this.prisma.addonRate.createMany({
        data: [
          {
            addonType: "SECURITY_DETAIL",
            rateAmount: 15000,
            effectiveSince,
            description: "Security detail addon",
          },
        ],
        skipDuplicates: true,
      }),
    ]);
  }
}

/**
 * Generate a unique email for testing to avoid conflicts.
 */
export function uniqueEmail(prefix: string): string {
  const randomId = Math.floor(Math.random() * 100000);
  return `${prefix}-${randomId}-${Date.now()}@example.com`;
}
