import { Injectable } from "@nestjs/common";
import type { MonoNinResult } from "../mono/mono.interface";
import { MonoError, MonoService } from "../mono/mono.service";
import { PremblyService } from "../prembly/prembly.service";

@Injectable()
export class NinLookupService {
  constructor(
    private readonly monoService: MonoService,
    private readonly premblyService: PremblyService,
  ) {}

  async lookup(nin: string): Promise<MonoNinResult> {
    try {
      return await this.monoService.verifyNin(nin);
    } catch (error) {
      if (
        !(error instanceof MonoError) ||
        !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.kind)
      ) {
        throw error;
      }
      return this.premblyService.verifyNin(nin);
    }
  }
}
