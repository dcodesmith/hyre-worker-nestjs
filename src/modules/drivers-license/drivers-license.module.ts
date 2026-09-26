import { Module } from "@nestjs/common";
import { MonoModule } from "../mono/mono.module";
import { PremblyModule } from "../prembly/prembly.module";
import { DriversLicenseLookupService } from "./drivers-license-lookup.service";

@Module({
  imports: [MonoModule, PremblyModule],
  providers: [DriversLicenseLookupService],
  exports: [DriversLicenseLookupService],
})
export class DriversLicenseModule {}
