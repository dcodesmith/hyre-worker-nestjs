export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

export interface EmailSendResult {
  data?: {
    id: string;
  } | null;
  error?: unknown;
  headers?: unknown;
  meta?: Record<string, unknown>;
}

export interface EmailTransport {
  sendEmail(payload: EmailPayload): Promise<EmailSendResult>;
}

export type EmailProvider = "resend" | "smtp";
