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
            get: () => "preview",
          },
        },
      ],
    }).compile();

    const controller = module.get<RootController>(RootController);
    const response = controller.getRootInfo();

    expect(response.service).toBe("hyre-worker-nestjs");
    expect(response.status).toBe("ok");
    expect(response.environment).toBe("preview");
    expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
