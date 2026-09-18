import { Module } from "@nestjs/common";
import { MonoService } from "./mono.service";

@Module({
  providers: [MonoService],
  exports: [MonoService],
})
export class MonoModule {}
