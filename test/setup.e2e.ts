import { vi } from "vitest";

// Mock email template rendering functions to avoid React dependency in e2e tests
// The NotificationProcessor imports these functions which use @react-email/components (React)
// Since BullMQ workers are created independently of NestJS DI, we need to mock at module level
vi.mock("../src/templates/emails", () => ({
  renderBookingConfirmationEmail: vi
    .fn()
    .mockResolvedValue("<html>Mocked booking confirmation</html>"),
  renderBookingStatusUpdateEmail: vi.fn().mockResolvedValue("<html>Mocked status update</html>"),
  renderBookingReminderEmail: vi.fn().mockResolvedValue("<html>Mocked reminder</html>"),
  renderAuthOTPEmail: vi.fn().mockResolvedValue("<html>Mocked OTP email</html>"),
}));

// Mock the EmailService to prevent actual API calls to Resend during e2e tests
vi.mock("../src/modules/notification/email.service", () => ({
  EmailService: vi.fn().mockImplementation(() => ({
    sendEmail: vi.fn().mockResolvedValue(undefined),
  })),
}));
