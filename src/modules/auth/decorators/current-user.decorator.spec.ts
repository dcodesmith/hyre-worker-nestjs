import { ExecutionContext } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import type { Session, User } from "better-auth";
import { describe, expect, it } from "vitest";
import { AUTH_SESSION_KEY, AuthSession } from "../guards/session.guard";
import { CurrentUser } from "./current-user.decorator";

describe("CurrentUser Decorator", () => {
  const mockUser: AuthSession["user"] = {
    id: "user-123",
    email: "test@example.com",
    name: "Test User",
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: ["user"],
  };

  const mockSessionData: Session = {
    id: "session-123",
    userId: "user-123",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    token: "token-123",
    createdAt: new Date(),
    updatedAt: new Date(),
    ipAddress: "127.0.0.1",
    userAgent: "test-agent",
  };

  const mockSession: AuthSession = {
    user: mockUser,
    session: mockSessionData,
  };

  const getParamDecoratorFactory = () => {
    class TestClass {
      testMethod(@CurrentUser() _user: User) {}
    }

    const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestClass, "testMethod");
    const key = Object.keys(metadata)[0];
    return metadata[key].factory;
  };

  const createMockExecutionContext = (session?: AuthSession) => {
    const mockRequest = { [AUTH_SESSION_KEY]: session };
    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;
  };

  it("should return user by default when session exists", () => {
    const factory = getParamDecoratorFactory();
    const context = createMockExecutionContext(mockSession);

    const result = factory(undefined, context);

    expect(result).toEqual(mockSession.user);
  });

  it("should return full session when data is 'session'", () => {
    class TestClass {
      testMethod(@CurrentUser("session") _session: AuthSession) {}
    }

    const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestClass, "testMethod");
    const key = Object.keys(metadata)[0];
    const factory = metadata[key].factory;
    const context = createMockExecutionContext(mockSession);

    const result = factory("session", context);

    expect(result).toEqual(mockSession);
  });

  it("should return null when no session exists", () => {
    const factory = getParamDecoratorFactory();
    const context = createMockExecutionContext(undefined);

    const result = factory(undefined, context);

    expect(result).toBeNull();
  });

  it("should return user when data is 'user'", () => {
    class TestClass {
      testMethod(@CurrentUser("user") _user: User) {}
    }

    const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestClass, "testMethod");
    const key = Object.keys(metadata)[0];
    const factory = metadata[key].factory;
    const context = createMockExecutionContext(mockSession);

    const result = factory("user", context);

    expect(result).toEqual(mockSession.user);
  });
});
