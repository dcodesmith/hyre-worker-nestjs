import type { ExecutionContext } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import type { CustomParamFactory } from "@nestjs/common/interfaces";
import { describe, expect, it } from "vitest";
import type { AuthSession } from "../guards/session.guard";
import { AUTH_SESSION_KEY } from "../guards/session.guard";
import { CurrentUser } from "./current-user.decorator";

/**
 * Extracts the factory function from a NestJS param decorator created with createParamDecorator.
 * Applies the decorator to a dummy method and reads the stored metadata.
 */
function getParamDecoratorFactory(decorator: () => ParameterDecorator): CustomParamFactory {
  class Test {
    test(@decorator() _value: unknown) {}
  }

  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Test, "test");
  const key = Object.keys(metadata)[0];
  return metadata[key].factory;
}

describe("CurrentUser decorator", () => {
  const factory = getParamDecoratorFactory(CurrentUser);

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

  it("should return user when no data argument is provided", () => {
    const ctx = createMockExecutionContext(mockAuthSession);

    const result = factory(undefined, ctx);

    expect(result).toEqual(mockUser);
  });

  it("should return full session when data is 'session'", () => {
    const ctx = createMockExecutionContext(mockAuthSession);

    const result = factory("session", ctx);

    expect(result).toEqual(mockAuthSession);
  });

  it("should return null when no auth session exists on request", () => {
    const ctx = createMockExecutionContext(undefined);

    const result = factory(undefined, ctx);

    expect(result).toBeNull();
  });

  it("should return null for session data when no auth session exists", () => {
    const ctx = createMockExecutionContext(undefined);

    const result = factory("session", ctx);

    expect(result).toBeNull();
  });
});
