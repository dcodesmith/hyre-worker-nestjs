import { InjectQueue } from "@nestjs/bull";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bull";
import { DatabaseService } from "../database/database.service";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly databaseService: DatabaseService,
    @InjectQueue("reminder-emails") private readonly reminderQueue: Queue,
    @InjectQueue("status-updates") private readonly statusUpdateQueue: Queue,
    @InjectQueue("notifications") private readonly notificationQueue: Queue,
  ) {}

  async checkHealth() {
    try {
      // Test Redis
      await this.redisService.ping();

      // Test Database
      await this.databaseService.$queryRaw`SELECT 1`;

      return {
        status: "healthy",
        timestamp: new Date().toISOString(),
        services: {
          redis: "connected",
          database: "connected",
        },
      };
    } catch (error) {
      this.logger.error("Health check failed:", error);
      throw {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getQueueStats() {
    try {
      const [reminderCounts, statusUpdateCounts, notificationCounts] = await Promise.all([
        this.reminderQueue.getJobCounts(),
        this.statusUpdateQueue.getJobCounts(),
        this.notificationQueue.getJobCounts(),
      ]);

      return {
        timestamp: new Date().toISOString(),
        queues: {
          reminder: {
            waiting: reminderCounts.waiting || 0,
            active: reminderCounts.active || 0,
            completed: reminderCounts.completed || 0,
            failed: reminderCounts.failed || 0,
          },
          statusUpdate: {
            waiting: statusUpdateCounts.waiting || 0,
            active: statusUpdateCounts.active || 0,
            completed: statusUpdateCounts.completed || 0,
            failed: statusUpdateCounts.failed || 0,
          },
          notifications: {
            waiting: notificationCounts.waiting || 0,
            active: notificationCounts.active || 0,
            completed: notificationCounts.completed || 0,
            failed: notificationCounts.failed || 0,
            health:
              (notificationCounts.failed || 0) < (notificationCounts.completed || 0) * 0.1
                ? "healthy"
                : "degraded",
          },
        },
      };
    } catch (error) {
      this.logger.error("Failed to get queue stats:", error);
      throw error;
    }
  }
}
