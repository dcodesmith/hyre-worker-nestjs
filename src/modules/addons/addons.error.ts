import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const AddonsErrorCode = {
  ADDON_NOT_FOUND: "ADDON_NOT_FOUND",
  ADDON_CODE_CONFLICT: "ADDON_CODE_CONFLICT",
  ADDON_PRICE_OVERLAP: "ADDON_PRICE_OVERLAP",
  ADDON_PRICE_NOT_FOUND: "ADDON_PRICE_NOT_FOUND",
  ADDON_PRICE_CANNOT_END: "ADDON_PRICE_CANNOT_END",
  INVALID_BOOKING_ADDONS: "INVALID_BOOKING_ADDONS",
} as const;

export class AddonsException extends AppException {}

export class AddonNotFoundException extends AddonsException {
  constructor() {
    super(AddonsErrorCode.ADDON_NOT_FOUND, "Add-on not found", HttpStatus.NOT_FOUND, {
      title: "Add-on Not Found",
    });
  }
}

export class AddonCodeConflictException extends AddonsException {
  constructor() {
    super(
      AddonsErrorCode.ADDON_CODE_CONFLICT,
      "An add-on with this code already exists",
      HttpStatus.CONFLICT,
      { title: "Add-on Code Conflict" },
    );
  }
}

export class AddonPriceOverlapException extends AddonsException {
  constructor() {
    super(
      AddonsErrorCode.ADDON_PRICE_OVERLAP,
      "An add-on price already overlaps this date range",
      HttpStatus.CONFLICT,
      { title: "Add-on Price Overlap" },
    );
  }
}

export class AddonPriceNotFoundException extends AddonsException {
  constructor() {
    super(AddonsErrorCode.ADDON_PRICE_NOT_FOUND, "Add-on price not found", HttpStatus.NOT_FOUND, {
      title: "Add-on Price Not Found",
    });
  }
}

export class AddonPriceCannotEndException extends AddonsException {
  constructor(detail: string) {
    super(AddonsErrorCode.ADDON_PRICE_CANNOT_END, detail, HttpStatus.CONFLICT, {
      title: "Add-on Price Cannot End",
    });
  }
}

export class InvalidBookingAddonsException extends AddonsException {
  constructor() {
    super(
      AddonsErrorCode.INVALID_BOOKING_ADDONS,
      "One or more selected add-ons are unavailable for this booking",
      HttpStatus.BAD_REQUEST,
      { title: "Invalid Booking Add-ons" },
    );
  }
}
