import { z } from "zod";
import { registrationNumberSchema } from "../car/dto/create-car.dto";

export const vehicleVerificationIdSchema = z.cuid();

const policyNumberSchema = z.string().trim().min(3).max(100);

export const createVehicleVerificationSchema = z.object({
  plateNumber: registrationNumberSchema,
  policyNumber: policyNumberSchema,
});

export const createInsuranceVerificationSchema = z.object({
  policyNumber: policyNumberSchema,
});

export type CreateVehicleVerificationDto = z.infer<typeof createVehicleVerificationSchema>;
export type CreateInsuranceVerificationDto = z.infer<typeof createInsuranceVerificationSchema>;
