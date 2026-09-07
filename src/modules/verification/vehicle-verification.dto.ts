import { z } from "zod";
import { registrationNumberSchema } from "../car/dto/create-car.dto";

export const vehicleVerificationIdSchema = z.cuid();

export const createVehicleVerificationSchema = z.object({
  plateNumber: registrationNumberSchema,
});

export const createInsuranceVerificationSchema = z.object({
  policyNumber: z.string().trim().min(3).max(100),
});

export type CreateVehicleVerificationDto = z.infer<typeof createVehicleVerificationSchema>;
export type CreateInsuranceVerificationDto = z.infer<typeof createInsuranceVerificationSchema>;
