import { InjectionToken } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { vi } from "vitest";

/**
 * Mock instance for tests that need an explicit `useValue` (rare).
 * Prefer {@link mockPinoLoggerToken} with `Test.createTestingModule(...).useMocker(...)`.
 */
export function createMockPinoLogger() {
  return {
    setContext: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Nest `TestingModule` `useMocker` callback: auto-mock `PinoLogger` DI token.
 */
export function mockPinoLoggerToken(token: InjectionToken) {
  if (token === PinoLogger) {
    return createMockPinoLogger();
  }
  return undefined;
}
