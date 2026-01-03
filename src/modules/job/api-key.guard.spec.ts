import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyGuard } from "./api-key.guard";

function createMockRequest(headers: Record<string, string | string[]>): Partial<Request> {
  const getFn: Request["get"] = vi.fn((name: string) => {
    const header = headers[name.toLowerCase()];
    if (name.toLowerCase() === "set-cookie") {
      if (!header) return [];
      return Array.isArray(header) ? header : [header];
    }
    if (!header) return undefined;
    return Array.isArray(header) ? header[0] : header;
  }) as Request["get"];

  return {
    headers,
    get: getFn,
  };
}

function createMockExecutionContext(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: vi.fn().mockReturnValue({
      getRequest: vi.fn().mockReturnValue(request),
      getResponse: vi.fn(),
      getNext: vi.fn(),
    }),
    getClass: vi.fn(),
    getHandler: vi.fn(),
    getArgs: vi.fn(),
    getArgByIndex: vi.fn(),
    switchToRpc: vi.fn(),
    switchToWs: vi.fn(),
    getType: vi.fn(),
  } as ExecutionContext;
}

async function createGuard(apiKey: string | undefined): Promise<ApiKeyGuard> {
  const configGet = vi.fn().mockReturnValue(apiKey);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ApiKeyGuard,
      {
        provide: ConfigService,
        useValue: {
          get: configGet,
        },
      },
    ],
  }).compile();
  return module.get<ApiKeyGuard>(ApiKeyGuard);
}

describe("ApiKeyGuard", () => {
  it("should be defined", async () => {
    const guard = await createGuard(undefined);
    expect(guard).toBeDefined();
  });

  describe("when API_KEY is not configured", () => {
    it("should allow all requests", async () => {
      const testGuard = await createGuard(undefined);

      const request = createMockRequest({});
      const mockExecutionContext = createMockExecutionContext(request);

      const result = testGuard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
    });
  });

  describe("when API_KEY is configured", () => {
    const validApiKey = "test-api-key-12345";

    it("should allow request with valid API key", async () => {
      const testGuard = await createGuard(validApiKey);
      const request = createMockRequest({
        "x-api-key": validApiKey,
      });

      const mockExecutionContext = createMockExecutionContext(request);
      const result = testGuard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
    });

    it("should throw UnauthorizedException when API key is missing", async () => {
      const testGuard = await createGuard(validApiKey);
      const request = createMockRequest({});
      const mockExecutionContext = createMockExecutionContext(request);

      expect(() => testGuard.canActivate(mockExecutionContext)).toThrow(
        new UnauthorizedException("Missing API key"),
      );
    });

    it("should throw UnauthorizedException when API key is not a string", async () => {
      const testGuard = await createGuard(validApiKey);
      const request = createMockRequest({
        "x-api-key": ["array-value"],
      });

      const mockExecutionContext = createMockExecutionContext(request);

      expect(() => testGuard.canActivate(mockExecutionContext)).toThrow(
        new UnauthorizedException("Missing API key"),
      );
    });

    it("should throw UnauthorizedException when API key is invalid", async () => {
      const testGuard = await createGuard(validApiKey);
      const request = createMockRequest({
        "x-api-key": "wrong-api-key",
      });

      const mockExecutionContext = createMockExecutionContext(request);

      expect(() => testGuard.canActivate(mockExecutionContext)).toThrow(
        new UnauthorizedException("Invalid API key"),
      );
    });

    it("should throw UnauthorizedException when API key has different length", async () => {
      const testGuard = await createGuard(validApiKey);
      const request = createMockRequest({
        "x-api-key": "short",
      });

      const mockExecutionContext = createMockExecutionContext(request);

      expect(() => testGuard.canActivate(mockExecutionContext)).toThrow(
        new UnauthorizedException("Invalid API key"),
      );
    });
  });
});
