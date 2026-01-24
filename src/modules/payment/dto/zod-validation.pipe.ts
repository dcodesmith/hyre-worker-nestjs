import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { z } from "zod";

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Zod v4 uses result.error.issues instead of result.error.errors
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      throw new BadRequestException({
        message: "Validation failed",
        errors,
      });
    }

    return result.data;
  }
}
