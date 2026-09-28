import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import {
  VERIFICATION_INTERVENTION_QUEUE,
  VERIFICATION_INTERVENTION_RETRY_JOB,
} from "../../config/constants";
import { InterventionService } from "./intervention.service";

type RetryJob = { interventionId: string; attempt: number; openedAt: number };

@Processor(VERIFICATION_INTERVENTION_QUEUE)
export class InterventionProcessor extends WorkerHost {
  constructor(private readonly interventionService: InterventionService) {
    super();
  }

  async process(job: Job<RetryJob>): Promise<void> {
    if (job.name !== VERIFICATION_INTERVENTION_RETRY_JOB) {
      throw new Error(`Unknown intervention job: ${job.name}`);
    }
    if (!Number.isSafeInteger(job.data.openedAt)) return;
    await this.interventionService.retry(
      job.data.interventionId,
      job.data.attempt,
      job.data.openedAt,
    );
  }
}
