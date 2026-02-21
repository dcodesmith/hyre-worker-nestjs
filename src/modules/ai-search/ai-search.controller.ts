import { Controller, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { ZodBody } from "../../common/decorators/zod-validation.decorator";
import { AiSearchService } from "./ai-search.service";
import { type AiSearchBodyDto, aiSearchBodySchema } from "./dto/ai-search.dto";

@Controller("api")
export class AiSearchController {
  constructor(private readonly aiSearchService: AiSearchService) {}

  @Post("ai-search")
  async search(
    @ZodBody(aiSearchBodySchema) body: AiSearchBodyDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return this.aiSearchService.search(body.query);
  }
}
