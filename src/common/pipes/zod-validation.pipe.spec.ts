import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mapZodIssuesToFieldErrors, ZodValidationPipe } from "./zod-validation.pipe";

describe("ZodValidationPipe", () => {
  const schema = z.object({
    name: z.string().min(2),
  });

  it("throws RFC7807 validation payload by default", () => {
    const pipe = new ZodValidationPipe(schema);

    try {
      pipe.transform({ name: "A" });
      throw new Error("Expected transform to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        type: string;
        title: string;
        status: number;
        detail: string;
        errors: Array<{ field: string; code?: string; message: string }>;
      };

      expect(response).toMatchObject({
        type: "VALIDATION_ERROR",
        title: "Validation Failed",
        status: 400,
        detail: "One or more validation errors occurred",
      });
      expect(response.errors).toHaveLength(1);
      expect(response.errors[0]).toMatchObject({
        field: "name",
        code: "too_small",
      });
      expect(typeof response.errors[0]?.message).toBe("string");
    }
  });

  it("uses custom exception factory when provided", () => {
    const pipe = new ZodValidationPipe(schema, {
      exceptionFactory: (errors) => new Error(`custom:${errors.length}`),
    });

    expect(() => pipe.transform({ name: "A" })).toThrow("custom:1");
  });

  it("maps root-level zod issues to _root field sentinel", () => {
    const mapped = mapZodIssuesToFieldErrors([
      {
        path: [],
        code: "custom",
        message: "Payload is invalid",
      },
    ]);

    expect(mapped).toEqual([
      {
        field: "_root",
        code: "custom",
        message: "Payload is invalid",
      },
    ]);
  });
});
