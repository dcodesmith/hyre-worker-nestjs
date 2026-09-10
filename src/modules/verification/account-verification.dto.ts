import { z } from "zod";

const multipartBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

const ninSchema = z
  .string()
  .trim()
  .regex(/^\d{11}$/, "NIN must contain exactly 11 digits");

export const payoutVerificationSchema = z.object({
  bankName: z.string().trim().min(2).max(100),
  bankCode: z
    .string()
    .trim()
    .regex(/^\d{2,6}$/, "Bank code must contain 2 to 6 digits"),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Account number must contain exactly 10 digits"),
});

const individualIdentityVerificationSchema = z.object({
  accountType: z.literal("INDIVIDUAL"),
  nin: ninSchema,
});

const businessIdentityVerificationSchema = z.object({
  accountType: z.literal("BUSINESS"),
  nin: ninSchema,
  businessName: z.string().trim().min(2).max(200),
  registrationNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{2,30}$/),
  registrationType: z.enum(["RC", "BN", "IT", "LP", "LLP"]),
});

export const accountIdentityVerificationSchema = z.discriminatedUnion("accountType", [
  individualIdentityVerificationSchema,
  businessIdentityVerificationSchema,
]);

export const drivingCredentialsSchema = z.object({
  isOwnerDriver: multipartBooleanSchema,
});

export const createAccountVerificationSchema = z.discriminatedUnion("accountType", [
  individualIdentityVerificationSchema.extend({
    ...payoutVerificationSchema.shape,
    ...drivingCredentialsSchema.shape,
  }),
  businessIdentityVerificationSchema.extend({
    ...payoutVerificationSchema.shape,
    ...drivingCredentialsSchema.shape,
  }),
]);

export const sendPhoneVerificationSchema = z.object({
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format"),
});

export const checkPhoneVerificationSchema = sendPhoneVerificationSchema.extend({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,10}$/, "Verification code must contain 4 to 10 digits"),
});

export type CreateAccountVerificationDto = z.infer<typeof createAccountVerificationSchema>;
export type AccountIdentityVerificationDto = z.infer<typeof accountIdentityVerificationSchema>;
export type PayoutVerificationDto = z.infer<typeof payoutVerificationSchema>;
export type DrivingCredentialsDto = z.infer<typeof drivingCredentialsSchema>;
export type SendPhoneVerificationDto = z.infer<typeof sendPhoneVerificationSchema>;
export type CheckPhoneVerificationDto = z.infer<typeof checkPhoneVerificationSchema>;

export interface UploadedAccountDocument {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface AccountDocumentUploadFields {
  driversLicense?: UploadedAccountDocument[];
  lasdri?: UploadedAccountDocument[];
}
