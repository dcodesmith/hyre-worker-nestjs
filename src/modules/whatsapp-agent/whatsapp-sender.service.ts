import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import type { CreateOutboxInput } from "./whatsapp-agent.interface";

@Injectable()
export class WhatsAppSenderService {
  private readonly logger = new Logger(WhatsAppSenderService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async enqueueOutbound(input: CreateOutboxInput): Promise<void> {
    try {
      await this.databaseService.whatsAppOutbox.create({
        data: {
          conversationId: input.conversationId,
          dedupeKey: input.dedupeKey,
          mode: input.mode,
          textBody: input.textBody ?? null,
          mediaUrl: input.mediaUrl ?? null,
          templateName: input.templateName ?? null,
          templateVariables: input.templateVariables
            ? (input.templateVariables as unknown as Prisma.InputJsonValue)
            : undefined,
        },
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        this.logger.debug("Skipping duplicate outbound enqueue", { dedupeKey: input.dedupeKey });
        return;
      }
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}
