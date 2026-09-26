import { Test, type TestingModule } from "@nestjs/testing";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VERIFICATION_INTERVENTION_RETRY_JOB } from "../../config/constants";
import { InterventionProcessor } from "./intervention.processor";
import { InterventionService } from "./intervention.service";

describe("InterventionProcessor", () => {
  let processor: InterventionProcessor;
  let interventionService: { retry: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    interventionService = { retry: vi.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterventionProcessor,
        { provide: InterventionService, useValue: interventionService },
      ],
    }).compile();
    processor = module.get(InterventionProcessor);
  });

  it("retries the intervention named in the job", async () => {
    await processor.process({
      name: VERIFICATION_INTERVENTION_RETRY_JOB,
      data: { interventionId: "intervention-1", attempt: 2 },
    } as Job);

    expect(interventionService.retry).toHaveBeenCalledWith("intervention-1", 2);
  });

  it("rejects an unknown job without calling retry", async () => {
    await expect(
      processor.process({
        name: "other",
        data: { interventionId: "intervention-1", attempt: 1 },
      } as Job),
    ).rejects.toThrow("Unknown intervention job: other");
    expect(interventionService.retry).not.toHaveBeenCalled();
  });
});
