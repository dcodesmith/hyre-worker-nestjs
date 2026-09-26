import { VerificationInterventionStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  approveInterventionSchema,
  interventionIdSchema,
  listInterventionsSchema,
  rejectInterventionSchema,
} from "./intervention.dto";

const interventionId = "018f47a2-7b3c-7d4e-8f90-1234567894c1";

describe("intervention DTO schemas", () => {
  it("defaults the queue to the first page of open interventions", () => {
    expect(listInterventionsSchema.parse({})).toEqual({
      status: VerificationInterventionStatus.OPEN,
      page: 1,
      limit: 20,
    });
  });

  it("rejects a page, limit, or status outside the contract", () => {
    expect(listInterventionsSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(listInterventionsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(listInterventionsSchema.safeParse({ status: "WAITING" }).success).toBe(false);
  });

  it("requires approval notes, a source, and an explicit attestation flag", () => {
    expect(
      approveInterventionSchema.parse({
        notes: "Checked FRSC",
        source: "FRSC",
      }),
    ).toEqual({
      notes: "Checked FRSC",
      source: "FRSC",
      authoritativeSourceAttested: false,
    });
    expect(approveInterventionSchema.safeParse({ notes: "no", source: "FRSC" }).success).toBe(
      false,
    );
    expect(
      approveInterventionSchema.safeParse({ notes: "Checked FRSC", source: "F" }).success,
    ).toBe(false);
  });

  it("requires rejection notes", () => {
    expect(rejectInterventionSchema.parse({ notes: "  Photo does not match  " })).toEqual({
      notes: "Photo does not match",
    });
    expect(rejectInterventionSchema.safeParse({ notes: "no" }).success).toBe(false);
  });

  it("accepts only a uuid intervention id", () => {
    expect(interventionIdSchema.parse(interventionId)).toBe(interventionId);
    expect(interventionIdSchema.safeParse("intervention-1").success).toBe(false);
  });
});
