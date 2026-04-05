import { Test, type TestingModule } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { RootController } from "./root.controller";

describe("RootController", () => {
  it("returns basic app information", async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RootController],
    }).compile();

    const controller = module.get<RootController>(RootController);
    const response = controller.getRootInfo();

    expect(response.service).toBe("hyre-worker-nestjs");
    expect(response.status).toBe("ok");
    expect(typeof response.environment).toBe("string");
    expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
