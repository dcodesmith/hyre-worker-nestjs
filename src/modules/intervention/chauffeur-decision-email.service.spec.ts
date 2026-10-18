import { Test, type TestingModule } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockPinoLoggerToken } from "@/testing/nest-pino-logger.mock";
import * as emailTemplates from "../../templates/emails";
import { EmailService } from "../email/email.service";
import {
  type ChauffeurDecisionEmail,
  ChauffeurDecisionEmailService,
} from "./chauffeur-decision-email.service";

const VERIFICATION_ID = "018f47a2-7b3c-7d4e-8f90-1234567894a1";
const RECIPIENT = "ada@example.com";
const RECIPIENT_NAME = "Ada Lovelace";
const STAFF_NOTES = "Photo does not match the NIN portrait. STAFF_REJECTED";
const INTERNAL_REASONS = [
  "CHAUFFEUR_MINIMUM_AGE_NOT_MET",
  "CHAUFFEUR_ACCOUNT_CONFLICT",
  "CHAUFFEUR_OPERATION_FAILED",
] as const;

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

function approvedEmail(): ChauffeurDecisionEmail {
  return {
    decision: "APPROVED",
    email: RECIPIENT,
    recipientName: RECIPIENT_NAME,
  };
}

function rejectedEmail(): ChauffeurDecisionEmail & {
  notes: string;
  failureReason: string;
  resolutionNotes: string;
} {
  return {
    decision: "REJECTED",
    email: RECIPIENT,
    recipientName: RECIPIENT_NAME,
    notes: STAFF_NOTES,
    failureReason: INTERNAL_REASONS[0],
    resolutionNotes: INTERNAL_REASONS[1],
  };
}

function loggedContext(logger: { warn: ReturnType<typeof vi.fn> }) {
  return logger.warn.mock.calls[0][0] as {
    verificationId: string;
    decision: string;
    err: Error;
  };
}

describe("ChauffeurDecisionEmailService", () => {
  let service: ChauffeurDecisionEmailService;
  let emailService: { sendEmail: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    emailService = { sendEmail: vi.fn().mockResolvedValue({ data: { id: "email-1" } }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ChauffeurDecisionEmailService, { provide: EmailService, useValue: emailService }],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    service = module.get(ChauffeurDecisionEmailService);
    logger = module.get(PinoLogger);
  });

  it("sends an approval with the recipient, subject, rendered copy, and stable key", async () => {
    await service.send(VERIFICATION_ID, approvedEmail());
    await service.send(VERIFICATION_ID, approvedEmail());

    expect(emailService.sendEmail).toHaveBeenCalledTimes(2);
    const [first, second] = emailService.sendEmail.mock.calls.map((call) => call[0]);
    expect(first).toEqual(
      expect.objectContaining({
        to: RECIPIENT,
        subject: "You're approved to drive on Tripdly",
        idempotencyKey: `chauffeur-decision_${VERIFICATION_ID}_approved`,
      }),
    );
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.html).toContain("You are approved");
    expect(first.html).toContain("Ada");
    expect(first.html).toContain("Your chauffeur verification is approved");
    expect(first.html).toContain(
      "Your chauffeur verification is complete. Your account is active, and your fleet owner can now assign you to bookings.",
    );
    expect(first.html).not.toContain("We could not approve");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sends a generic rejection and leaves staff notes and internal reasons out", async () => {
    const input = rejectedEmail();

    await service.send(VERIFICATION_ID, input);

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const payload = emailService.sendEmail.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        to: RECIPIENT,
        subject: "Update on your Tripdly chauffeur application",
        idempotencyKey: `chauffeur-decision_${VERIFICATION_ID}_rejected`,
      }),
    );
    expect(payload.html).toContain("We could not approve your application");
    expect(payload.html).toContain("Ada");
    expect(payload.html).toContain("An update on your chauffeur verification");
    expect(payload.html).toContain(
      "We could not approve your chauffeur verification. Contact Tripdly support if you believe this decision was made in error.",
    );
    expect(payload.html).not.toContain("You are approved");
    expect(payload.html).not.toContain("Your account is active");
    expect(payload.html).not.toContain(RECIPIENT);
    expect(payload.html).not.toContain(STAFF_NOTES);
    for (const reason of INTERNAL_REASONS) {
      expect(payload.html).not.toContain(reason);
    }
    expect(payload).not.toHaveProperty("notes");
    expect(payload).not.toHaveProperty("failureReason");
    expect(payload).not.toHaveProperty("resolutionNotes");
  });

  it("swallows a render failure and logs it without the recipient", async () => {
    const render = vi
      .spyOn(emailTemplates, "renderChauffeurDecisionEmail")
      .mockRejectedValueOnce(new Error("template failed"));

    try {
      await expect(service.send(VERIFICATION_ID, approvedEmail())).resolves.toBeUndefined();
    } finally {
      render.mockRestore();
    }

    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        verificationId: VERIFICATION_ID,
        decision: "APPROVED",
        err: expect.any(Error),
      },
      "Failed to send chauffeur decision email",
    );
    const context = loggedContext(logger);
    expect(context.err.message).toBe("template failed");
    expect(context).not.toHaveProperty("email");
    expect(context).not.toHaveProperty("recipientName");
    expect(context).not.toHaveProperty("notes");
    expect(JSON.stringify({ ...context, err: context.err.message })).not.toContain(RECIPIENT);
    expect(JSON.stringify({ ...context, err: context.err.message })).not.toContain(RECIPIENT_NAME);
  });

  it("swallows an email delivery failure and logs it without the recipient", async () => {
    emailService.sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    const input = rejectedEmail();

    await expect(service.send(VERIFICATION_ID, input)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      {
        verificationId: VERIFICATION_ID,
        decision: "REJECTED",
        err: expect.any(Error),
      },
      "Failed to send chauffeur decision email",
    );
    const context = loggedContext(logger);
    expect(context.err.message).toBe("smtp down");
    expect(context).not.toHaveProperty("email");
    expect(context).not.toHaveProperty("recipientName");
    expect(context).not.toHaveProperty("notes");
    const logged = JSON.stringify({ ...context, err: context.err.message });
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).not.toContain(RECIPIENT_NAME);
    expect(logged).not.toContain(STAFF_NOTES);
    for (const reason of INTERNAL_REASONS) {
      expect(logged).not.toContain(reason);
    }
  });
});
