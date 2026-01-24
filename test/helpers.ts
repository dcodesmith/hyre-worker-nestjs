import type { INestApplication } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";

// ============================================================================
// Test Data Factory Types (using Prisma UncheckedCreateInput for direct FK usage)
// ============================================================================

export type CreateUserOptions = Partial<Prisma.UserUncheckedCreateInput> & {
  roles?: string[];
};

export type CreateCarOptions = Partial<Prisma.CarUncheckedCreateInput>;

export type CreateBookingOptions = Partial<Prisma.BookingUncheckedCreateInput>;

export type CreatePaymentOptions = Partial<Prisma.PaymentUncheckedCreateInput>;

export type AuthRole = "user" | "fleetOwner" | "admin";

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
   * Authenticate a user via OTP flow and return the session cookie.
   * Automatically clears rate limits before authentication.
   * Requires the factory to be initialized with an app instance.
   *
   * @throws Error if app instance was not provided to the factory
   */
  async authenticateAndGetCookie(email: string, role: AuthRole = "user"): Promise<string> {
    if (!this.app) {
      throw new Error("TestDataFactory requires app instance for authentication methods");
    }

    // Clear rate limits before auth to avoid test interference
    await this.clearRateLimits();

    // Send OTP
    await request(this.app.getHttpServer())
      .post("/auth/api/email-otp/send-verification-otp")
      .set("X-Client-Type", "mobile")
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
      .set("X-Client-Type", "mobile")
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
  ): Promise<{ cookie: string; user: { id: string; email: string; name: string | null } }> {
    const cookie = await this.authenticateAndGetCookie(email, role);
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
      },
      select: { id: true, bookingReference: true },
    });
    return booking;
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
}

/**
 * Generate a unique email for testing to avoid conflicts.
 */
export function uniqueEmail(prefix: string): string {
  const randomId = Math.floor(Math.random() * 100000);
  return `${prefix}-${randomId}-${Date.now()}@example.com`;
}
