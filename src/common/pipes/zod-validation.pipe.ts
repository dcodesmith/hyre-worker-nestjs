import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import type { FieldError } from "../errors/problem-details.interface";

export type ExceptionFactory = (errors: FieldError[]) => Error;
export type ZodValidationPipeOptions = {
  exceptionFactory?: ExceptionFactory;
};

export function mapZodIssuesToFieldErrors(
  issues: Array<{ path: PropertyKey[]; code?: string; message: string }>,
): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly options?: ZodValidationPipeOptions,
  ) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const errors = mapZodIssuesToFieldErrors(result.error.issues);

      if (this.options?.exceptionFactory) {
        throw this.options.exceptionFactory(errors);
      }

      throw new BadRequestException({
        type: "VALIDATION_ERROR",
        title: "Validation Failed",
        status: 400,
        detail: "One or more validation errors occurred",
        errors,
      });
    }

    return result.data;
  }
}
