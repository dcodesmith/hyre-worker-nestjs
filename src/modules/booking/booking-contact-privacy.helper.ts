function omitContactFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const {
    email: _email,
    guestEmail: _guestEmail,
    guestPhone: _guestPhone,
    phone: _phone,
    phoneNumber: _phoneNumber,
    ...safeValue
  } = value as Record<string, unknown>;
  return safeValue;
}

export function redactBookingCustomerContacts<T>(booking: T): T {
  const record = booking as Record<string, unknown>;
  return {
    ...record,
    user: omitContactFields(record.user),
    guestUser: omitContactFields(record.guestUser),
  } as T;
}
