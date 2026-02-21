import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { buildActiveWindowWhere } from "./rates.helper";
import type { PlatformRates } from "./rates.interface";

/**
 * Service for fetching platform rates (fees, VAT, addon rates).
 *
 * Implements in-memory caching with 5-minute TTL to reduce database load
 * since rates change infrequently.
 */
@Injectable()
export class RatesService {
  private readonly logger = new Logger(RatesService.name);

  private readonly cache: {
    data: PlatformRates | null;
    timestamp: number;
  } = {
    data: null,
    timestamp: 0,
  };

  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Get current platform rates for booking/extension calculations.
   *
   * Rates are cached for 5 minutes to reduce database load.
   * Throws an error if any required rate is not found.
   */
  async getRates(): Promise<PlatformRates> {
    const now = Date.now();

    // Return cached data if still valid
    if (this.cache.data && now - this.cache.timestamp < this.CACHE_TTL_MS) {
      this.logger.debug("Returning cached rates");
      return this.cache.data;
    }

    this.logger.debug("Fetching rates from database");
    const currentDate = new Date();

    // Run all rate queries in parallel for better performance
    const [platformRates, vatRate, securityDetailAddonRate] = await Promise.all([
      // Get both platform fee rates in a single query
      this.databaseService.platformFeeRate.findMany({
        where: {
          feeType: { in: ["PLATFORM_SERVICE_FEE", "FLEET_OWNER_COMMISSION"] },
          ...buildActiveWindowWhere(currentDate),
        },
        orderBy: { effectiveSince: "desc" },
      }),
      // Get VAT rate
      this.databaseService.taxRate.findFirst({
        where: {
          ...buildActiveWindowWhere(currentDate),
        },
        orderBy: { effectiveSince: "desc" },
      }),
      // Get security detail addon rate
      this.databaseService.addonRate.findFirst({
        where: {
          addonType: "SECURITY_DETAIL",
          ...buildActiveWindowWhere(currentDate),
        },
        orderBy: { effectiveSince: "desc" },
      }),
    ]);

    // Extract the specific rates from the array
    const platformFeeRate = platformRates.find((rate) => rate.feeType === "PLATFORM_SERVICE_FEE");
    const fleetOwnerCommissionRate = platformRates.find(
      (rate) => rate.feeType === "FLEET_OWNER_COMMISSION",
    );

    // Validate all rates are found
    if (!platformFeeRate) {
      throw new Error("No active platform service fee rate found");
    }

    if (!fleetOwnerCommissionRate) {
      throw new Error("No active fleet owner commission rate found");
    }

    if (!vatRate) {
      throw new Error("No active VAT rate found");
    }

    if (!securityDetailAddonRate) {
      throw new Error("No active security detail rate found");
    }

    const result: PlatformRates = {
      platformCustomerServiceFeeRatePercent: platformFeeRate.ratePercent,
      platformFleetOwnerCommissionRatePercent: fleetOwnerCommissionRate.ratePercent,
      vatRatePercent: vatRate.ratePercent,
      securityDetailRate: securityDetailAddonRate.rateAmount,
    };

    // Cache the result
    this.cache.data = result;
    this.cache.timestamp = now;

    this.logger.debug("Rates fetched and cached", {
      platformFee: platformFeeRate.ratePercent.toString(),
      fleetOwnerCommission: fleetOwnerCommissionRate.ratePercent.toString(),
      vat: vatRate.ratePercent.toString(),
      securityDetail: securityDetailAddonRate.rateAmount.toString(),
    });

    return result;
  }

  /**
   * Clear the rates cache. Useful for testing or when rates are updated.
   */
  clearCache(): void {
    this.cache.data = null;
    this.cache.timestamp = 0;
    this.logger.debug("Rates cache cleared");
  }
}
