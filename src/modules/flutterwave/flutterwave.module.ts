import { Global, Module } from "@nestjs/common";
import { HttpClientService } from "../../shared/http-client.service";
import { FlutterwaveService } from "./flutterwave.service";

@Global()
@Module({
  providers: [FlutterwaveService, HttpClientService],
  exports: [FlutterwaveService],
})
export class FlutterwaveModule {}
