import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAxiosErrorWithRequest,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { PremblyError, PremblyService } from "./prembly.service";

const VALID_CHASSIS = "1HGCM82633A004352";

const verification = { status: "VERIFIED", reference: "prembly-ref-1" };

const plateSuccess = (overrides: Record<string, unknown> = {}) => ({
  status: true,
  detail: "Verification successful",
  response_code: "00",
  data: {
    vehicle_number: "KJA-123AB",
    vehicle_name: "Toyota Camry",
    vehicle_color: "Black",
    vehicle: {
      ChassisNo: VALID_CHASSIS,
      carMake: "Toyota",
      carModel: "Camry",
      bodyColor: "Black",
    },
  },
  verification,
  ...overrides,
});

const vinSuccess = (
  specification: Record<string, string>[] = [
    { year: "2020" },
    { make: "Toyota" },
    { model: "Camry" },
    { standard_seating: "5" },
  ],
) => ({
  status: true,
  response_code: "00",
  data: {
    vehicle_name: "Toyota Camry",
    vehicle_specification: specification,
  },
  verification,
});

const insuranceSuccess = () => ({
  status: true,
  response_code: "00",
  data: {
    policy_number: "POLICY-123",
    reg_number: "KJA-123AB",
    vehicle_color: "Black",
    vehicle_chasis: VALID_CHASSIS,
    policy_status: "Active",
    expiry_date: "2099-12-31",
  },
  verification,
});

describe("PremblyService", () => {
  let service: PremblyService;
  let mockAxiosInstance: ReturnType<typeof createMockAxiosInstance>;

  const mockConfig = {
    PREMBLY_API_KEY: "test-prembly-api-key",
    PREMBLY_APP_ID: "test-prembly-app-id",
    PREMBLY_BASE_URL: "https://api.prembly.com",
  };

  beforeEach(async () => {
    mockAxiosInstance = createMockAxiosInstance();
    const mockHttpClientService = createMockHttpClientService(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PremblyService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => mockConfig[key as keyof typeof mockConfig]),
          },
        },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    }).compile();

    service = module.get(PremblyService);
  });

  describe("verifyPlate", () => {
    it("normalizes plate details and required chassis from nested vehicle fields", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: plateSuccess() });

      await expect(service.verifyPlate("kja-123ab")).resolves.toEqual({
        plateNumber: "KJA-123AB",
        chassisNumber: VALID_CHASSIS,
        make: "Toyota",
        model: "Camry",
        color: "Black",
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/verification/vehicle", {
        vehicle_number: "kja-123ab",
      });
    });

    it("falls back to top-level chassis_number and uppercases it", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          data: {
            vehicle_number: "ABC123XY",
            chassis_number: `  ${VALID_CHASSIS.toLowerCase()}  `,
            vehicle: { carMake: "Honda", carModel: "Accord" },
          },
        }),
      });

      const result = await service.verifyPlate("ABC123XY");

      expect(result.chassisNumber).toBe(VALID_CHASSIS);
      expect(result.make).toBe("Honda");
      expect(result.model).toBe("Accord");
    });

    it("rejects a missing chassis number as an invalid provider response", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          data: {
            vehicle_number: "KJA-123AB",
            vehicle: { carMake: "Toyota", carModel: "Camry" },
          },
        }),
      });

      await expect(service.verifyPlate("KJA-123AB")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("rejects a chassis that is not a valid VIN", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          data: {
            vehicle: { ChassisNo: "1HGCM82633A00435I", carMake: "Toyota", carModel: "Camry" },
          },
        }),
      });

      await expect(service.verifyPlate("KJA-123AB")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });
  });

  describe("verifyVin", () => {
    it("merges specification fragments and extracts year, make, model, and seating", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: vinSuccess() });

      await expect(service.verifyVin(VALID_CHASSIS)).resolves.toEqual({
        year: 2020,
        make: "Toyota",
        model: "Camry",
        passengerCapacity: 5,
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/verification/vehicle/vin", {
        vin: VALID_CHASSIS,
      });
    });

    it("rejects a specification that cannot produce a valid year or seating", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: vinSuccess([
          { year: "1800" },
          { make: "Toyota" },
          { model: "Camry" },
          { standard_seating: "5" },
        ]),
      });

      await expect(service.verifyVin(VALID_CHASSIS)).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("maps a provider rejection envelope to REJECTED", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { status: false, response_code: "01", detail: "VIN not found", verification },
      });

      await expect(service.verifyVin(VALID_CHASSIS)).rejects.toEqual(new PremblyError("REJECTED"));
    });
  });

  describe("verifyInsurance", () => {
    it("returns the verified policy expiry date", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: insuranceSuccess() });

      await expect(service.verifyInsurance("POLICY-123")).resolves.toEqual({
        policyNumber: "POLICY-123",
        policyStatus: "Active",
        plateNumbers: ["KJA-123AB"],
        chassisNumber: VALID_CHASSIS,
        color: "Black",
        expiresAt: new Date("2099-12-31"),
        reference: "prembly-ref-1",
      });
    });

    it("parses an ISO insurance expiry and includes both registration numbers", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          ...insuranceSuccess(),
          data: {
            policy_number: "POLICY-456",
            new_reg_number: "ABC-999ZZ",
            reg_number: "KJA-123AB",
            vehicle_color: "  Silver  ",
            vehicle_chasis: VALID_CHASSIS,
            policy_status: "Active",
            expiry_date: "2099-06-15T23:59:59.000Z",
          },
        },
      });

      await expect(service.verifyInsurance("POLICY-456")).resolves.toEqual({
        policyNumber: "POLICY-456",
        policyStatus: "Active",
        plateNumbers: ["ABC-999ZZ", "KJA-123AB"],
        chassisNumber: VALID_CHASSIS,
        color: "Silver",
        expiresAt: new Date("2099-06-15T23:59:59.000Z"),
        reference: "prembly-ref-1",
      });
    });

    it("rejects a malformed insurance payload without an expiry date", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          status: true,
          response_code: "00",
          data: {
            policy_number: "POLICY-123",
            policy_status: "Active",
          },
          verification,
        },
      });

      await expect(service.verifyInsurance("POLICY-123")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("rejects an insurance chassis that is not a valid VIN", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          ...insuranceSuccess(),
          data: {
            ...insuranceSuccess().data,
            vehicle_chasis: "1HGCM82633A00435I",
          },
        },
      });

      await expect(service.verifyInsurance("POLICY-123")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("returns a null chassis when insurance omits vehicle_chasis", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          ...insuranceSuccess(),
          data: {
            policy_number: "POLICY-123",
            reg_number: "KJA-123AB",
            vehicle_color: "Black",
            policy_status: "Active",
            expiry_date: "2099-12-31",
          },
        },
      });

      await expect(service.verifyInsurance("POLICY-123")).resolves.toMatchObject({
        chassisNumber: null,
        plateNumbers: ["KJA-123AB"],
        color: "Black",
      });
    });

    it.each([undefined, "", "   "])(
      "treats a missing or blank vehicle_color as null",
      async (vehicleColor) => {
        mockAxiosInstance.post.mockResolvedValueOnce({
          data: {
            ...insuranceSuccess(),
            data: {
              ...insuranceSuccess().data,
              vehicle_color: vehicleColor,
            },
          },
        });

        await expect(service.verifyInsurance("POLICY-123")).resolves.toMatchObject({
          color: null,
        });
      },
    );
  });

  describe("provider errors", () => {
    it("maps a timeout or network failure to UNAVAILABLE", async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(
        createAxiosErrorWithRequest("timeout of 15000ms exceeded"),
      );

      await expect(service.verifyPlate("KJA-123AB")).rejects.toEqual(
        new PremblyError("UNAVAILABLE"),
      );
    });

    it("maps an unparseable payload to INVALID_RESPONSE", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { unexpected: true } });

      await expect(service.verifyVin(VALID_CHASSIS)).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it.each(["02", "03"] as const)(
      "maps soft-unavailable response code %s to UNAVAILABLE",
      async (responseCode) => {
        mockAxiosInstance.post.mockResolvedValueOnce({
          data: { status: true, response_code: responseCode, detail: "Retry later" },
        });

        await expect(service.verifyPlate("KJA-123AB")).rejects.toEqual(
          new PremblyError("UNAVAILABLE"),
        );
      },
    );

    it("maps an unknown success-looking response code to INVALID_RESPONSE", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { status: true, response_code: "99", detail: "Unknown", verification },
      });

      await expect(service.verifyVin(VALID_CHASSIS)).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("rejects a non-verified provider status even when response_code is 00", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          verification: { status: "PENDING", reference: "prembly-ref-1" },
        }),
      });

      await expect(service.verifyPlate("KJA-123AB")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("rejects a missing verification object as an invalid provider response", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          status: true,
          response_code: "00",
          data: { vehicle_specification: [{ year: "2020" }] },
        },
      });

      await expect(service.verifyVin(VALID_CHASSIS)).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("maps a false envelope status to REJECTED", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { status: false, response_code: "00", detail: "Not found", verification },
      });

      await expect(service.verifyInsurance("POLICY-123")).rejects.toEqual(
        new PremblyError("REJECTED"),
      );
    });
  });

  describe("verifyNin", () => {
    const ninSuccess = (data: Record<string, unknown> = {}) => ({
      status: true,
      response_code: "00",
      data: {
        firstname: "JOHN",
        middlename: "MIDDLE",
        surname: "DOE",
        nin: "12345678901",
        nin_suspension_status: false,
        ...data,
      },
      verification,
    });

    it("parses names and trims optional middle name", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: ninSuccess() });

      await expect(service.verifyNin("12345678901")).resolves.toEqual({
        firstName: "JOHN",
        middleName: "MIDDLE",
        lastName: "DOE",
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/verification/vnin-basic", {
        number: "12345678901",
      });
    });

    it("accepts Prembly nin_data payloads", async () => {
      const { data, ...rest } = ninSuccess();
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { ...rest, nin_data: data },
      });

      await expect(service.verifyNin("12345678901")).resolves.toEqual({
        firstName: "JOHN",
        middleName: "MIDDLE",
        lastName: "DOE",
        reference: "prembly-ref-1",
      });
    });

    it("treats a blank middle name as null", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ middlename: "   " }),
      });

      await expect(service.verifyNin("12345678901")).resolves.toMatchObject({
        middleName: null,
      });
    });

    it("rejects a suspended NIN", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ nin_suspension_status: true }),
      });

      await expect(service.verifyNin("12345678901")).rejects.toEqual(new PremblyError("REJECTED"));
    });

    it("rejects a payload missing the surname", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ surname: "" }),
      });

      await expect(service.verifyNin("12345678901")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("rejects a payload missing the NIN", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ nin: undefined }),
      });

      await expect(service.verifyNin("12345678901")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });

    it("rejects a NIN that does not exactly match the requested number", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ nin: "10987654321" }),
      });

      await expect(service.verifyNin("12345678901")).rejects.toEqual(new PremblyError("REJECTED"));
    });
  });

  describe("verifyCac", () => {
    const director = {
      firstname: "JOHN",
      surname: "DOE",
      otherName: "MIDDLE",
    };
    const company = {
      rc_number: "RC-123456",
      company_name: "Hyre Mobility Limited",
      company_status: "Active",
      entity_type: "RC",
      directors: [director],
    };
    const cacSuccess = (data: unknown[] = [company]) => ({
      status: true,
      response_code: "00",
      data,
      verification,
    });

    it("selects the matching RC and prefers an exact business-name match", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([{ ...company, company_name: "Other Mobility Limited" }, company]),
      });

      await expect(service.verifyCac("RC123456", "RC", "Hyre Mobility Limited")).resolves.toEqual({
        businessName: "Hyre Mobility Limited",
        registrationNumber: "RC-123456",
        registrationType: "RC",
        status: "ACTIVE",
        directors: [{ firstName: "JOHN", middleName: "MIDDLE", lastName: "DOE" }],
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/verification/cac/advance", {
        rc_number: "RC123456",
        company_type: "RC",
        company_name: "Hyre Mobility Limited",
      });
    });

    it("matches a prefixed RC against Prembly's digits-only rc_number", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([{ ...company, rc_number: "123456" }]),
      });

      await expect(
        service.verifyCac("RC123456", "RC", "Hyre Mobility Limited"),
      ).resolves.toMatchObject({
        registrationNumber: "123456",
        registrationType: "RC",
      });
    });

    it("matches a digits-only RC against a prefixed Prembly rc_number", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess(),
      });

      await expect(
        service.verifyCac("123456", "RC", "Hyre Mobility Limited"),
      ).resolves.toMatchObject({
        registrationNumber: "RC-123456",
        registrationType: "RC",
      });
    });

    it("strips punctuation when matching the RC number", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([{ ...company, rc_number: "RC.123456" }]),
      });

      await expect(
        service.verifyCac("RC-123456", "rc", "Hyre Mobility Limited"),
      ).resolves.toMatchObject({
        registrationNumber: "RC.123456",
        registrationType: "RC",
      });
    });

    it("strips leading zeros from the entire identifier when matching", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([{ ...company, rc_number: "000123456" }]),
      });

      await expect(
        service.verifyCac("00123456", "RC", "Hyre Mobility Limited"),
      ).resolves.toMatchObject({
        registrationNumber: "000123456",
        registrationType: "RC",
      });
    });

    it("strips zero padding after an optional letter prefix when matching", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([{ ...company, rc_number: "RC-00123456" }]),
      });

      await expect(
        service.verifyCac("RC123456", "RC", "Hyre Mobility Limited"),
      ).resolves.toMatchObject({
        registrationNumber: "RC-00123456",
        registrationType: "RC",
      });
    });

    it("returns a null status when CAC omits company_status", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([{ ...company, company_status: null, directors: [] }]),
      });

      await expect(
        service.verifyCac("RC123456", "RC", "Hyre Mobility Limited"),
      ).resolves.toMatchObject({
        status: null,
        directors: [],
      });
    });

    it("drops directors that have no first or last name", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([
          {
            ...company,
            directors: [
              { firstname: "", surname: "", otherName: "X" },
              { firstname: "ADA", surname: "LOVELACE" },
            ],
          },
        ]),
      });

      await expect(
        service.verifyCac("RC123456", "RC", "Hyre Mobility Limited"),
      ).resolves.toMatchObject({
        directors: [{ firstName: "ADA", middleName: null, lastName: "LOVELACE" }],
      });
    });

    it("rejects a payload with no matching RC and company type", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: cacSuccess([{ ...company, entity_type: "BN" }]),
      });

      await expect(service.verifyCac("RC123456", "RC", "Hyre Mobility Limited")).rejects.toEqual(
        new PremblyError("INVALID_RESPONSE"),
      );
    });
  });
});
