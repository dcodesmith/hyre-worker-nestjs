import { z } from "zod";

export const documentIdParamSchema = z
  .string()
  .min(1, "documentId is required")
  .max(128, "documentId is too long");
