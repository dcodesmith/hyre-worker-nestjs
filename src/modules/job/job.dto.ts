import { PipeTransform } from "@nestjs/common";
import { ZodError } from "zod";
import { InvalidJobTypeException } from "./errors";
import { JobType, JobTypeSchema } from "./job.schema";

/**
 * Custom pipe to validate job type parameter using Zod
 * Throws InvalidJobTypeException with error code if the job type is invalid
 */
export class ValidateJobTypePipe implements PipeTransform<string, JobType> {
  transform(value: string): JobType {
    try {
      return JobTypeSchema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const validTypes = JobTypeSchema.options;
        throw new InvalidJobTypeException(value, validTypes);
      }
      throw error;
    }
  }
}
