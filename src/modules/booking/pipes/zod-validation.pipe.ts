import { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { BookingValidationException } from "../booking.error";

/**
 * Zod validation pipe for booking endpoints.
 *
 * Transforms Zod validation errors into BookingValidationException
 * with RFC 7807 Problem Details format.
 */
export class BookingZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      }));

      throw new BookingValidationException(errors);
    }

    return result.data;
  }
}
