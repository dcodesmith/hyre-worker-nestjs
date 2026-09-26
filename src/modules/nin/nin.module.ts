import { Module } from "@nestjs/common";
import { MonoModule } from "../mono/mono.module";
import { PremblyModule } from "../prembly/prembly.module";
import { NinLookupService } from "./nin-lookup.service";

@Module({
  imports: [MonoModule, PremblyModule],
  providers: [NinLookupService],
  exports: [NinLookupService],
})
export class NinModule {}
