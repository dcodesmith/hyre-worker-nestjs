import { Global, Module } from "@nestjs/common";
import { FlutterwaveService } from "./flutterwave.service";

@Global()
@Module({
  providers: [FlutterwaveService],
  exports: [FlutterwaveService],
})
export class FlutterwaveModule {}
