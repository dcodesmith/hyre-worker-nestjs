import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { AuthService } from "../src/modules/auth/auth.service";
import { SessionGuard } from "../src/modules/auth/guards/session.guard";
import { PushTokenController } from "../src/modules/notification/push-token.controller";
import { PushTokenService } from "../src/modules/notification/push-token.service";
import { mockPinoLoggerToken } from "../src/testing/nest-pino-logger.mock";

describe("PushToken E2E", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const authServiceMock = {
      isInitialized: true,
      auth: {
        api: {
          getSession: vi.fn().mockImplementation(({ headers }: { headers: Headers }) => {
            const authHeader = headers.get("authorization");
            if (authHeader !== "Bearer valid-session") {
              return null;
            }

            return {
              user: { id: "user-1", email: "john@example.com" },
              session: {
                id: "session-1",
                userId: "user-1",
                expiresAt: new Date("2030-01-01T00:00:00.000Z"),
              },
            };
          }),
        },
      },
      getUserRoles: vi.fn().mockResolvedValue(["user"]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushTokenController],
      providers: [
        SessionGuard,
        {
          provide: PushTokenService,
          useValue: {
            registerToken: vi.fn().mockResolvedValue(undefined),
            revokeToken: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuthService,
          useValue: authServiceMock,
        },
      ],
    })
      .useMocker(mockPinoLoggerToken)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 401 for unauthenticated POST register route", async () => {
    await request(app.getHttpServer())
      .post("/api/users/me/push-tokens")
      .send({
        token: "ExponentPushToken[abc123]",
        platform: "ios",
      })
      .expect(401);
  });

  it("returns 400 for authenticated POST with malformed body", async () => {
    await request(app.getHttpServer())
      .post("/api/users/me/push-tokens")
      .set("Authorization", "Bearer valid-session")
      .send({
        platform: "ios",
      })
      .expect(400);
  });

  it("returns 401 for unauthenticated DELETE route", async () => {
    await request(app.getHttpServer())
      .delete("/api/users/me/push-tokens")
      .send({
        token: "ExponentPushToken[abc123]",
      })
      .expect(401);
  });

  it("returns 400 for authenticated DELETE with malformed body", async () => {
    await request(app.getHttpServer())
      .delete("/api/users/me/push-tokens")
      .set("Authorization", "Bearer valid-session")
      .send({
        token: "invalid-token",
      })
      .expect(400);
  });
});
