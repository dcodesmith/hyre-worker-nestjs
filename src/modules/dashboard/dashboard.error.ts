import { HttpStatus } from "@nestjs/common";
import { AppException } from "../../common/errors/app.exception";

export const DashboardErrorCode = {
  DASHBOARD_FETCH_FAILED: "DASHBOARD_FETCH_FAILED",
  DASHBOARD_VALIDATION_ERROR: "DASHBOARD_VALIDATION_ERROR",
} as const;

export class DashboardException extends AppException {}

export class DashboardFetchFailedException extends DashboardException {
  constructor() {
    super(
      DashboardErrorCode.DASHBOARD_FETCH_FAILED,
      "An unexpected error occurred while fetching dashboard data",
      HttpStatus.INTERNAL_SERVER_ERROR,
      { title: "Dashboard Fetch Failed" },
    );
  }
}

export class DashboardValidationException extends DashboardException {
  constructor(detail: string) {
    super(DashboardErrorCode.DASHBOARD_VALIDATION_ERROR, detail, HttpStatus.BAD_REQUEST, {
      title: "Dashboard Validation Failed",
    });
  }
}
