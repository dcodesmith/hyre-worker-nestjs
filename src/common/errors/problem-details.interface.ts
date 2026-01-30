/**
 * RFC 7807 Problem Details interface for structured error responses.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7807
 */
export interface ProblemDetails {
  /**
   * A URI reference that identifies the problem type.
   * When dereferenced, it should provide human-readable documentation.
   * Example: "VALIDATION_ERROR", "CAR_NOT_AVAILABLE"
   */
  type: string;

  /**
   * A short, human-readable summary of the problem type.
   * Example: "Validation Failed", "Car Not Available"
   */
  title: string;

  /**
   * The HTTP status code for this occurrence of the problem.
   */
  status: number;

  /**
   * A human-readable explanation specific to this occurrence of the problem.
   * Example: "One or more validation errors occurred"
   */
  detail: string;

  /**
   * A URI reference that identifies the specific occurrence of the problem.
   * Optional - can be used for tracking/debugging.
   */
  instance?: string;
}

/**
 * Extended Problem Details with field-level errors for validation failures.
 */
export interface ValidationProblemDetails extends ProblemDetails {
  /**
   * Array of field-level validation errors.
   */
  errors: FieldError[];
}

/**
 * Individual field validation error.
 */
export interface FieldError {
  /**
   * The field/property that has the error.
   * Can use dot notation for nested fields: "address.city"
   */
  field: string;

  /**
   * Machine-readable error code for this specific error.
   * Example: "REQUIRED", "INVALID_FORMAT", "PAST_DATE"
   */
  code?: string;

  /**
   * Human-readable description of the error.
   */
  message: string;
}
