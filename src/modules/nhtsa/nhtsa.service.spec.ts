import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createAxiosErrorWithRequest,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { NhtsaError, NhtsaService } from "./nhtsa.service";

const VALID_VIN = "1HGCM82633A004352";

const decodeSuccess = (overrides: Record<string, unknown> = {}) => ({
  Results: [
    {
      VIN: VALID_VIN,
      ErrorCode: "0",
      Make: "Honda",
      Model: "Accord",
      ModelYear: "2020",
      Seats: "5",
      ...overrides,
    },
  ],
});

describe("NhtsaService", () => {
  let service: NhtsaService;
  let mockAxiosInstance: ReturnType<typeof createMockAxiosInstance>;

  beforeEach(async () => {
    mockAxiosInstance = createMockAxiosInstance();
    const mockHttpClientService = createMockHttpClientService(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [NhtsaService, { provide: HttpClientService, useValue: mockHttpClientService }],
    }).compile();

    service = module.get(NhtsaService);
  });

  it("decodes an exact VIN including passenger seats", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: decodeSuccess() });

    await expect(service.verifyVin(`  ${VALID_VIN.toLowerCase()}  `)).resolves.toEqual({
      year: 2020,
      make: "Honda",
      model: "Accord",
      passengerCapacity: 5,
    });
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/vehicles/DecodeVinValues/${VALID_VIN}`, {
      params: { format: "json" },
    });
  });

  it("rejects a VIN that is not a valid 17-character identifier before calling vPIC", async () => {
    await expect(service.verifyVin("1HGCM82633A00435I")).rejects.toEqual(
      new NhtsaError("REJECTED"),
    );
    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
  });

  it("rejects a provider row whose ErrorCode is not 0", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: decodeSuccess({ ErrorCode: "7" }),
    });

    await expect(service.verifyVin(VALID_VIN)).rejects.toEqual(new NhtsaError("REJECTED"));
  });

  it("rejects an empty Results array", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { Results: [] } });

    await expect(service.verifyVin(VALID_VIN)).rejects.toEqual(new NhtsaError("REJECTED"));
  });

  it("treats a malformed payload as an invalid provider response", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { unexpected: true } });

    await expect(service.verifyVin(VALID_VIN)).rejects.toEqual(new NhtsaError("INVALID_RESPONSE"));
  });

  it("rejects a response VIN that does not exactly match the requested VIN", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: decodeSuccess({ VIN: "1HGCM82633A999999" }),
    });

    await expect(service.verifyVin(VALID_VIN)).rejects.toEqual(new NhtsaError("INVALID_RESPONSE"));
  });

  it("rejects a decode that cannot produce a valid year, make, and model", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: decodeSuccess({ ModelYear: "1800", Make: "  ", Model: "" }),
    });

    await expect(service.verifyVin(VALID_VIN)).rejects.toEqual(new NhtsaError("INVALID_RESPONSE"));
  });

  it("maps an unavailable HTTP call to UNAVAILABLE", async () => {
    mockAxiosInstance.get.mockRejectedValueOnce(
      createAxiosErrorWithRequest("timeout of 10000ms exceeded"),
    );

    await expect(service.verifyVin(VALID_VIN)).rejects.toEqual(new NhtsaError("UNAVAILABLE"));
  });

  it.each([
    ["missing seats", undefined],
    ["blank seats", ""],
    ["non-numeric seats", "N/A"],
    ["zero seats", "0"],
    ["over-capacity seats", "16"],
    ["fractional seats", "5.5"],
  ])("returns null passengerCapacity for %s", async (_label, seats) => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: decodeSuccess(seats === undefined ? { Seats: undefined } : { Seats: seats }),
    });

    await expect(service.verifyVin(VALID_VIN)).resolves.toEqual({
      year: 2020,
      make: "Honda",
      model: "Accord",
      passengerCapacity: null,
    });
  });
});
