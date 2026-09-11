import { Controller, Get } from "@nestjs/common";
import { ZodQuery } from "../../common/decorators/zod-validation.decorator";
import { AddonsService } from "./addons.service";
import { type ListPublicAddonsQueryDto, listPublicAddonsQuerySchema } from "./dto/addons.dto";

@Controller("api/addons")
export class AddonsController {
  constructor(private readonly addonsService: AddonsService) {}

  @Get()
  list(@ZodQuery(listPublicAddonsQuerySchema) query: ListPublicAddonsQueryDto) {
    return this.addonsService.listPublic(query.bookingType);
  }
}
