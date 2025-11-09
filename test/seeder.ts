import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SEED_LOCK_KEY = 42_042;

export async function resetAndSeedDb() {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY});`;

      await tx.booking.deleteMany();
      await tx.car.deleteMany();
      await tx.user.deleteMany();

      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dayAfterTomorrow = new Date(now);
      dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);

      const customer1 = await tx.user.create({
        data: {
          email: "customer1@test.com",
          name: "Customer One",
          phoneNumber: "+2348012345671",
          hasOnboarded: true,
        },
      });

      const customer2 = await tx.user.create({
        data: {
          email: "customer2@test.com",
          name: "Customer Two",
          phoneNumber: "+2348012345672",
          hasOnboarded: true,
        },
      });

      const fleetOwner = await tx.user.create({
        data: {
          email: "fleetowner@test.com",
          name: "Fleet Owner",
          phoneNumber: "+2348012345673",
          hasOnboarded: true,
          fleetOwnerStatus: "APPROVED",
        },
      });

      const car1 = await tx.car.create({
        data: {
          make: "Toyota",
          model: "Camry",
          year: 2022,
          color: "Black",
          registrationNumber: "ABC123XY",
          status: "AVAILABLE",
          approvalStatus: "APPROVED",
          hourlyRate: 5000,
          dayRate: 80000,
          nightRate: 60000,
          fuelUpgradeRate: 10000,
          fullDayRate: 120000,
          ownerId: fleetOwner.id,
        },
      });

      const car2 = await tx.car.create({
        data: {
          make: "Honda",
          model: "Accord",
          year: 2023,
          color: "White",
          registrationNumber: "DEF456ZT",
          status: "AVAILABLE",
          approvalStatus: "APPROVED",
          hourlyRate: 5500,
          dayRate: 85000,
          nightRate: 65000,
          fuelUpgradeRate: 10000,
          fullDayRate: 130000,
          ownerId: fleetOwner.id,
        },
      });

      await tx.booking.create({
        data: {
          bookingReference: "BK-TEST-001",
          carId: car1.id,
          userId: customer1.id,
          status: "CONFIRMED",
          startDate: tomorrow,
          endDate: dayAfterTomorrow,
          type: "DAY",
          totalAmount: 80000,
          paymentStatus: "PAID",
          pickupLocation: "Lagos Island",
          returnLocation: "Lagos Island",
          platformCustomerServiceFeeAmount: 8000,
          platformCustomerServiceFeeRatePercent: 10,
          platformFleetOwnerCommissionAmount: 12000,
          platformFleetOwnerCommissionRatePercent: 15,
          subtotalBeforeVat: 80000,
          vatAmount: 6000,
          vatRatePercent: 7.5,
          fleetOwnerPayoutAmountNet: 60000,
          netTotal: 74000,
        },
      });

      await tx.booking.create({
        data: {
          bookingReference: "BK-TEST-002",
          carId: car2.id,
          userId: customer2.id,
          status: "PENDING",
          startDate: tomorrow,
          endDate: dayAfterTomorrow,
          type: "FULL_DAY",
          totalAmount: 130000,
          paymentStatus: "UNPAID",
          pickupLocation: "Victoria Island",
          returnLocation: "Lekki Phase 1",
          specialRequests: "Need GPS and child seat",
        },
      });
    });
  } catch (error) {
    console.error("Error during database reset/seed:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}
