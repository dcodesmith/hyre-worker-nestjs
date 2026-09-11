import { z } from "zod";

export const createChauffeurInvitationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format"),
});

export const exchangeChauffeurInvitationSchema = z.object({
  token: z.string().min(32).max(200),
});

export const acceptChauffeurConsentSchema = z.object({
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
});

export const checkChauffeurPhoneSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,10}$/, "Verification code must contain 4 to 10 digits"),
});

export const verifyChauffeurNinSchema = z.object({
  nin: z
    .string()
    .trim()
    .regex(/^\d{11}$/, "NIN must contain exactly 11 digits"),
});

export const verifyChauffeurDrivingSchema = z.object({
  driversLicenseNumber: z
    .string()
    .trim()
    .min(5)
    .max(30)
    .regex(/^[A-Za-z0-9-]+$/, "Driver's licence number is invalid"),
});

export const listChauffeursQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateChauffeurSchema = z.object({
  isActive: z.boolean(),
});

export const chauffeurIdParamSchema = z.cuid();

export type CreateChauffeurInvitationDto = z.infer<typeof createChauffeurInvitationSchema>;
export type ExchangeChauffeurInvitationDto = z.infer<typeof exchangeChauffeurInvitationSchema>;
export type AcceptChauffeurConsentDto = z.infer<typeof acceptChauffeurConsentSchema>;
export type CheckChauffeurPhoneDto = z.infer<typeof checkChauffeurPhoneSchema>;
export type VerifyChauffeurNinDto = z.infer<typeof verifyChauffeurNinSchema>;
export type VerifyChauffeurDrivingDto = z.infer<typeof verifyChauffeurDrivingSchema>;
export type ListChauffeursQueryDto = z.infer<typeof listChauffeursQuerySchema>;
export type UpdateChauffeurDto = z.infer<typeof updateChauffeurSchema>;

export type UploadedChauffeurSelfie = {
  mimetype: string;
  size: number;
  buffer: Buffer;
};
