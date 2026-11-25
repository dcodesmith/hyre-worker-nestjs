import { omitStoredClientContext } from "../../common/client-request";

const OWNER_PUBLIC_FIELDS = ["id", "name", "username"] as const;
const CHAUFFEUR_PUBLIC_FIELDS = ["id", "name", "phoneNumber", "image"] as const;
const CUSTOMER_SELF_FIELDS = ["id", "name", "email", "phoneNumber", "image"] as const;
const CUSTOMER_REDACTED_FIELDS = ["id", "name", "image"] as const;
const GUEST_SELF_FIELDS = ["id", "name", "guestEmail", "guestPhone"] as const;
const GUEST_REDACTED_FIELDS = ["id", "name"] as const;

function pickPresentFields(value: unknown, allowedKeys: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in record) {
      picked[key] = record[key];
    }
  }
  return picked;
}

export function sanitizeBookingResponse<T extends object>(
  booking: T,
  options: { redactCustomerContacts: boolean },
): T {
  const {
    completionTokenHash: _completionTokenHash,
    guestAccessTokenHash: _guestAccessTokenHash,
    paymentStatusTokenHash: _paymentStatusTokenHash,
    ...rest
  } = omitStoredClientContext(booking) as Record<string, unknown>;

  if ("car" in rest && rest.car && typeof rest.car === "object" && !Array.isArray(rest.car)) {
    const car = rest.car as Record<string, unknown>;
    if ("owner" in car) {
      rest.car = {
        ...car,
        owner: pickPresentFields(car.owner, OWNER_PUBLIC_FIELDS),
      };
    }
  }

  if ("chauffeur" in rest) {
    rest.chauffeur = pickPresentFields(rest.chauffeur, CHAUFFEUR_PUBLIC_FIELDS);
  }

  if ("user" in rest) {
    rest.user = pickPresentFields(
      rest.user,
      options.redactCustomerContacts ? CUSTOMER_REDACTED_FIELDS : CUSTOMER_SELF_FIELDS,
    );
  }

  if ("guestUser" in rest) {
    rest.guestUser = pickPresentFields(
      rest.guestUser,
      options.redactCustomerContacts ? GUEST_REDACTED_FIELDS : GUEST_SELF_FIELDS,
    );
  }

  return rest as T;
}
