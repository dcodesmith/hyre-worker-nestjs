import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { smileIdCompareWebhookSchema } from "../smile-id/smile-id.schema";
import { SmileIdService } from "../smile-id/smile-id.service";
import { ChauffeurService } from "./chauffeur.service";

@Controller("api/webhook")
export class SmileIdWebhookController {
  constructor(
    private readonly smileIdService: SmileIdService,
    private readonly chauffeurService: ChauffeurService,
  ) {}

  @Post("smile-id")
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers("response-timestamp") timestamp: string | undefined,
    @Headers("response-signature") signature: string | undefined,
    @Headers("job-id") jobIdHeader: string | undefined,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    if (!this.smileIdService.webhookAuthentic(timestamp, signature)) {
      throw new UnauthorizedException();
    }
    const parsed = smileIdCompareWebhookSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const jobId = parsed.data.partner_params.job_id;
    if (jobIdHeader && jobIdHeader !== jobId) throw new BadRequestException();
    await this.chauffeurService.applySmileCompareResult({
      jobId,
      verificationId: parsed.data.partner_params.verificationId,
      stageRequestId: parsed.data.partner_params.stageRequestId,
      status: parsed.data.status,
    });
    return { status: "ok" };
  }
}
