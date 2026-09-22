import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAxiosErrorWithRequest,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { RegCheckError, RegCheckService } from "./regcheck.service";

const PLATE = "KTU683KH";

const vehicleXml = (vehicle: Record<string, unknown>) =>
  `<?xml version="1.0" encoding="utf-8"?><Vehicle xmlns="http://regcheck.org.uk"><vehicleJson>${JSON.stringify(vehicle)}</vehicleJson></Vehicle>`;

const highlander = {
  Description: "Toyota  Highlander",
  CarMake: { CurrentTextValue: "Toyota" },
  CarModel: { CurrentTextValue: " Highlander" },
  Region: "Alimosho, Lagos Ikotun)",
  Colour: "Black",
};

describe("RegCheckService", () => {
  let service: RegCheckService;
  let mockAxiosInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(async () => {
    mockAxiosInstance = createMockAxiosInstance();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegCheckService,
        {
          provide: ConfigService,
          useValue: { get: vi.fn(() => "regcheck-user") },
        },
        {
          provide: HttpClientService,
          useValue: createMockHttpClientService(mockAxiosInstance),
        },
      ],
    }).compile();

    service = module.get(RegCheckService);
  });

  it("reads make, model, and colour from the Nigeria plate response", async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: vehicleXml(highlander) });

    await expect(service.verifyPlate(`  ${PLATE.toLowerCase()}  `)).resolves.toEqual({
      plateNumber: PLATE,
      vehicleName: "Toyota Highlander",
      color: "Black",
    });
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/reg.asmx/CheckNigeria",
      new URLSearchParams({ RegistrationNumber: PLATE, username: "regcheck-user" }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
  });

  it("rejects a plate response that has no make or model", async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({
      data: vehicleXml({
        ...highlander,
        CarMake: { CurrentTextValue: " " },
        CarModel: { CurrentTextValue: "" },
      }),
    });

    await expect(service.verifyPlate(PLATE)).rejects.toEqual(new RegCheckError("INVALID_RESPONSE"));
  });

  it("maps an unavailable HTTP call to UNAVAILABLE", async () => {
    mockAxiosInstance.post.mockRejectedValueOnce(createAxiosErrorWithRequest("timeout"));

    await expect(service.verifyPlate(PLATE)).rejects.toEqual(new RegCheckError("UNAVAILABLE"));
  });
});
