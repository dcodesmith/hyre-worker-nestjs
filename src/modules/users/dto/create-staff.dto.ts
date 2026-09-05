import { z } from "zod";

export const createStaffBodySchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    email: z
      .string()
      .trim()
      .pipe(z.email("Invalid email address"))
      .transform((value) => value.toLowerCase()),
    phoneNumber: z.string().trim().min(10).max(32),
  })
  .strict();

export type CreateStaffBodyDto = z.infer<typeof createStaffBodySchema>;
