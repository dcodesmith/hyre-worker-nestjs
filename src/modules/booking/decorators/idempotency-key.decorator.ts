import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { BookingValidationException } from "../booking.error";
import { idempotencyKeySchema } from "../dto/idempotency-key.dto";

export class IdempotencyKeyPipe extends ZodValidationPipe<string> {
  constructor() {
    super(idempotencyKeySchema, {
      exceptionFactory: (errors) =>
        new BookingValidationException(
          errors.map((error) => ({ ...error, field: "Idempotency-Key" })),
        ),
    });
  }
}

const idempotencyKeyPipe = new IdempotencyKeyPipe();

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return idempotencyKeyPipe.transform(request.get("Idempotency-Key"));
  },
);
