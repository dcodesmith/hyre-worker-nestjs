import { describe, expect, it } from "vitest";
import { createStaffBodySchema } from "./create-staff.dto";

describe("createStaffBodySchema", () => {
  const validBody = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    phoneNumber: "+2348012345678",
  };

  it("accepts a valid staff payload", () => {
    const parsed = createStaffBodySchema.safeParse(validBody);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(validBody);
    }
  });

  it("trims fields and normalizes email to lowercase", () => {
    const parsed = createStaffBodySchema.safeParse({
      name: "  Ada Lovelace  ",
      email: "  Ada@Example.COM  ",
      phoneNumber: "  +2348012345678  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(validBody);
    }
  });

  it("rejects a name shorter than 2 characters after trim", () => {
    expect(createStaffBodySchema.safeParse({ ...validBody, name: " A " }).success).toBe(false);
  });

  it("rejects a name longer than 200 characters", () => {
    expect(createStaffBodySchema.safeParse({ ...validBody, name: "A".repeat(201) }).success).toBe(
      false,
    );
  });

  it("rejects an invalid email", () => {
    expect(createStaffBodySchema.safeParse({ ...validBody, email: "not-an-email" }).success).toBe(
      false,
    );
  });

  it("rejects a phone number shorter than 10 characters after trim", () => {
    expect(
      createStaffBodySchema.safeParse({ ...validBody, phoneNumber: " 123456789 " }).success,
    ).toBe(false);
  });

  it("rejects a phone number longer than 32 characters", () => {
    expect(
      createStaffBodySchema.safeParse({ ...validBody, phoneNumber: "1".repeat(33) }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(createStaffBodySchema.safeParse({ ...validBody, role: "admin" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    expect(
      createStaffBodySchema.safeParse({
        name: validBody.name,
        email: validBody.email,
      }).success,
    ).toBe(false);
  });
});
