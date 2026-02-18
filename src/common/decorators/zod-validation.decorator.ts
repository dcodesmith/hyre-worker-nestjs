import { Body, Param, Query } from "@nestjs/common";
import type { z } from "zod";
import { ZodValidationPipe, type ZodValidationPipeOptions } from "../pipes/zod-validation.pipe";

export function ZodBody<T>(
  schema: z.ZodType<T>,
  options?: ZodValidationPipeOptions,
): ParameterDecorator {
  return Body(new ZodValidationPipe(schema, options));
}

export function ZodQuery<T>(
  schema: z.ZodType<T>,
  options?: ZodValidationPipeOptions,
): ParameterDecorator {
  return Query(new ZodValidationPipe(schema, options));
}

export function ZodParam<T>(
  paramName: string,
  schema: z.ZodType<T>,
  options?: ZodValidationPipeOptions,
): ParameterDecorator {
  return Param(paramName, new ZodValidationPipe(schema, options));
}
