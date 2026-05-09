import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { NotificationJobData } from "./notification.interface";
import type { notificationJobDataSchema } from "./notification.schema";

/**
 * Locks the seam between the durable Zod envelope and the rich TS interface.
 *
 * The schema validates JSON structure at the outbox boundary; the TS interface
 * adds semantic typing for downstream consumers. Two fields are intentionally
 * at different abstraction levels and excluded from the equality check:
 *
 * - `recipients` — TS uses `Partial<Record<RecipientType, ...>>` (closed key
 *   set); the schema uses `Record<string, ...>` (open) because RecipientType
 *   is a string-literal union not worth round-tripping through Zod.
 * - `templateData` — TS uses the rich `TemplateData` discriminated union; the
 *   schema treats it as opaque `Record<string, unknown>` because Zod can't
 *   ergonomically express the per-template-kind variants.
 *
 * Drift on every other envelope field (id, type, channels, bookingId,
 * pushPayload, priority) fails this file at compile time via the vanilla
 * TypeScript type-equality trick below.
 */

type SchemaInferred = z.infer<typeof notificationJobDataSchema>;
type EnvelopeOnly<T> = Omit<T, "recipients" | "templateData">;

// Mutual structural assignability between the two envelope shapes.
//
// We don't use strict equality (`(<T>() => T extends A ? 1 : 2)`) because the
// project compiles with `strictNullChecks: false`, which makes optional-key
// vs `T | undefined` distinctions ambiguous and trip the equality trick on
// equivalent shapes. Mutual assignability is the right semantic here: each
// envelope must be a valid stand-in for the other.
type AssertAssignable<A, B> = A extends B ? true : false;

const _interfaceAssignableToSchema: AssertAssignable<
  EnvelopeOnly<NotificationJobData>,
  EnvelopeOnly<SchemaInferred>
> = true;

const _schemaAssignableToInterface: AssertAssignable<
  EnvelopeOnly<SchemaInferred>,
  EnvelopeOnly<NotificationJobData>
> = true;

describe("NotificationJobData ↔ notificationJobDataSchema contract", () => {
  it("envelope fields stay mutually assignable between schema and TS interface", () => {
    // The real assertions are at compile time above; this test exists so the
    // contract appears in the suite and the spec file gets type-checked.
    expect(_interfaceAssignableToSchema).toBe(true);
    expect(_schemaAssignableToInterface).toBe(true);
  });
});
