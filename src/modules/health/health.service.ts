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
      const reminderStats = {
        waiting: await this.reminderQueue.getWaiting(),
        active: await this.reminderQueue.getActive(),
        completed: await this.reminderQueue.getCompleted(),
        failed: await this.reminderQueue.getFailed(),
      };

      const statusUpdateStats = {
        waiting: await this.statusUpdateQueue.getWaiting(),
        active: await this.statusUpdateQueue.getActive(),
        completed: await this.statusUpdateQueue.getCompleted(),
        failed: await this.statusUpdateQueue.getFailed(),
      };

      const notificationStats = {
        waiting: await this.notificationQueue.getWaiting(),
        active: await this.notificationQueue.getActive(),
        completed: await this.notificationQueue.getCompleted(),
        failed: await this.notificationQueue.getFailed(),
      };

      return {
        timestamp: new Date().toISOString(),
        queues: {
          reminder: {
            waiting: reminderStats.waiting.length,
            active: reminderStats.active.length,
            completed: reminderStats.completed.length,
            failed: reminderStats.failed.length,
          },
          statusUpdate: {
            waiting: statusUpdateStats.waiting.length,
            active: statusUpdateStats.active.length,
            completed: statusUpdateStats.completed.length,
            failed: statusUpdateStats.failed.length,
          },
          notifications: {
            waiting: notificationStats.waiting.length,
            active: notificationStats.active.length,
            completed: notificationStats.completed.length,
            failed: notificationStats.failed.length,
            health:
              notificationStats.failed.length < notificationStats.completed.length * 0.1
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
