import { z } from "zod";
import { VIN_PATTERN } from "../../shared/vehicle-validation";
import { registrationNumberSchema } from "../car/dto/create-car.dto";

export const vehicleVerificationIdSchema = z.uuid();

const policyNumberSchema = z.string().trim().min(3).max(100);
const chassisNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(VIN_PATTERN, "Chassis number must be a valid 17-character VIN"));

export const createVehicleVerificationSchema = z.object({
  plateNumber: registrationNumberSchema,
  chassisNumber: chassisNumberSchema,
});

export const createInsuranceVerificationSchema = z.object({
  policyNumber: policyNumberSchema,
});

export type CreateVehicleVerificationDto = z.infer<typeof createVehicleVerificationSchema>;
export type CreateInsuranceVerificationDto = z.infer<typeof createInsuranceVerificationSchema>;
