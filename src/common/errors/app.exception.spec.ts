import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AppException } from "./app.exception";

describe("AppException", () => {
  it("builds an RFC7807-compatible response body", () => {
    const exception = new AppException(
      "BOOKING_NOT_FOUND",
      "Booking not found",
      HttpStatus.NOT_FOUND,
      {
        title: "Booking Not Found",
        details: { bookingId: "booking-1" },
      },
    );

    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.getResponse()).toEqual({
      type: "BOOKING_NOT_FOUND",
      title: "Booking Not Found",
      status: HttpStatus.NOT_FOUND,
      detail: "Booking not found",
      errorCode: "BOOKING_NOT_FOUND",
      details: {
        bookingId: "booking-1",
      },
    });
  });

  it("keeps validation errors at top-level", () => {
    const exception = new AppException(
      "VALIDATION_ERROR",
      "One or more validation errors occurred",
      HttpStatus.BAD_REQUEST,
      {
        title: "Validation Failed",
        errors: [{ field: "email", code: "invalid_string", message: "Invalid email" }],
        details: { source: "schema" },
      },
    );

    expect(exception.getResponse()).toEqual({
      type: "VALIDATION_ERROR",
      title: "Validation Failed",
      status: HttpStatus.BAD_REQUEST,
      detail: "One or more validation errors occurred",
      errorCode: "VALIDATION_ERROR",
      errors: [{ field: "email", code: "invalid_string", message: "Invalid email" }],
      details: { source: "schema" },
    });
  });
});
