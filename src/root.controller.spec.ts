import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { RootController } from "./root.controller";

describe("RootController", () => {
  it("returns the deploy environment from APP_ENV", async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RootController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                APP_ENV: "preview",
                DEPLOYMENT_COMMIT: "a".repeat(40),
                DEPLOYMENT_VERSION: "pr-207-aaaaaaa",
              })[key],
          },
        },
      ],
    }).compile();

    const controller = module.get<RootController>(RootController);
    const response = controller.getRootInfo();

    expect(response.service).toBe("hyre-worker-nestjs");
    expect(response.status).toBe("ok");
    expect(response.environment).toBe("preview");
    expect(response.deployment).toEqual({
      version: "pr-207-aaaaaaa",
      commit: "a".repeat(40),
    });
    expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
