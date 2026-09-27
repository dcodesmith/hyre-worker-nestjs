import {
  type CreateBookingInput,
  createBookingSchema,
  createGuestBookingSchema,
} from "../../booking/dto/create-booking.dto";

export function parsePublicBookingInput(
  input: CreateBookingInput,
  isAuthenticated: boolean,
): { ok: true; data: CreateBookingInput } | { ok: false; issues: string[] } {
  const schema = isAuthenticated ? createBookingSchema : createGuestBookingSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      }),
    };
  }

  return { ok: true, data: parsed.data };
}
