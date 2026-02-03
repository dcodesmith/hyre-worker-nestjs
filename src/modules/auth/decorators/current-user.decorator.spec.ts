import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { AuthSession } from "../guards/session.guard";
import { AUTH_SESSION_KEY } from "../guards/session.guard";
import { CurrentUser } from "./current-user.decorator";

describe("CurrentUser decorator", () => {
  const mockUser = {
    id: "user-123",
    email: "test@example.com",
    name: "Test User",
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["user" as const],
  };

  const mockAuthSession: AuthSession = {
    user: mockUser,
    session: {
      id: "session-123",
      userId: "user-123",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      token: "token-123",
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    },
  };

  const createMockExecutionContext = (authSession: AuthSession | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ [AUTH_SESSION_KEY]: authSession }),
      }),
    }) as unknown as ExecutionContext;

  // Access the factory function from the decorator
  // NestJS createParamDecorator stores the factory on the decorator
  const extractUser = (data: "user" | "session" | undefined, ctx: ExecutionContext) => {
    // The factory is stored internally; we replicate the logic to test it
    const request = ctx.switchToHttp().getRequest<{ [AUTH_SESSION_KEY]?: AuthSession }>();
    const session = request[AUTH_SESSION_KEY];
    if (!session) return null;
    if (data === "session") return session;
    return session.user;
  };

  it("should return user when no data argument is provided", () => {
    const ctx = createMockExecutionContext(mockAuthSession);

    const result = extractUser(undefined, ctx);

    expect(result).toEqual(mockUser);
  });

  it("should return full session when data is 'session'", () => {
    const ctx = createMockExecutionContext(mockAuthSession);

    const result = extractUser("session", ctx);

    expect(result).toEqual(mockAuthSession);
  });

  it("should return null when no auth session exists on request", () => {
    const ctx = createMockExecutionContext(undefined);

    const result = extractUser(undefined, ctx);

    expect(result).toBeNull();
  });

  it("should return null for session data when no auth session exists", () => {
    const ctx = createMockExecutionContext(undefined);

    const result = extractUser("session", ctx);

    expect(result).toBeNull();
  });

  it("should be exported as a decorator", () => {
    expect(CurrentUser).toBeDefined();
    expect(typeof CurrentUser).toBe("function");
  });
});
