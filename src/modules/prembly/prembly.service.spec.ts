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

  describe("verifyNin", () => {
    it("maps the identity fields and ignores the rest of the registry payload", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          status: true,
          response_code: "00",
          data: {
            firstname: "Ada",
            middlename: "",
            surname: "Lovelace",
            birthdate: "22-05-1998",
            photo: "data:image/jpeg;base64,abc",
            nin: "12345678901",
            telephoneno: "08000000000",
          },
          verification,
        },
      });

      await expect(service.verifyNin("12345678901")).resolves.toEqual({
        firstName: "Ada",
        middleName: null,
        lastName: "Lovelace",
        dateOfBirth: new Date(Date.UTC(1998, 4, 22)),
        officialPhoto: "abc",
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/verification/vnin", {
        number_nin: "12345678901",
      });
    });

    it("rejects a record for a different NIN", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          status: true,
          response_code: "00",
          data: {
            firstname: "Ada",
            surname: "Lovelace",
            birthdate: "22-05-1998",
            nin: "10987654321",
          },
          verification,
        },
      });

      await expect(service.verifyNin("12345678901")).rejects.toEqual(new PremblyError("REJECTED"));
    });
  });

  describe("verifyDriversLicense", () => {
    const licenseRecord = {
      status: true,
      response_code: "00",
      frsc_data: {
        driversLicense: "ABC12345DE67",
        firstname: "Ada",
        middlename: "",
        lastname: "Lovelace",
        birthdate: "22-05-1998",
        expiry_date: "01-01-2029",
        photo: "data:image/jpeg;base64,abc",
        gender: "Female",
      },
      verification,
    };

    it("maps the licence fields and ignores the rest of the registry payload", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: licenseRecord });

      await expect(
        service.verifyDriversLicense("abc12345de67", "Ada", "Lovelace"),
      ).resolves.toEqual({
        licenseNumber: "ABC12345DE67",
        firstName: "Ada",
        middleName: null,
        lastName: "Lovelace",
        dateOfBirth: new Date(Date.UTC(1998, 4, 22)),
        expiresAt: new Date(Date.UTC(2029, 0, 1)),
        officialPhoto: "abc",
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/verification/drivers_license/advance/v2",
        { number: "abc12345de67", first_name: "Ada", last_name: "Lovelace" },
      );
    });

    it("rejects a record for a different licence number", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          ...licenseRecord,
          frsc_data: { ...licenseRecord.frsc_data, driversLicense: "XYZ12345DE67" },
        },
      });

      await expect(service.verifyDriversLicense("ABC12345DE67", "Ada", "Lovelace")).rejects.toEqual(
        new PremblyError("REJECTED"),
      );
    });
  });

  describe("verifyPlate", () => {
    it("returns plate number, vehicle name, color, and reference without requiring a chassis", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: plateSuccess() });

      await expect(service.verifyPlate("kja-123ab")).resolves.toEqual({
        plateNumber: "KJA-123AB",
        vehicleName: "Toyota Camry",
        chassisNumber: null,
        color: "Black",
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/verification/vehicle", {
        vehicle_number: "kja-123ab",
      });
    });

    it("falls back to the requested plate when vehicle_number is omitted", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          data: {
            vehicle_name: "Honda Accord",
            vehicle_color: "Silver",
          },
        }),
      });

      await expect(service.verifyPlate("ABC123XY")).resolves.toEqual({
        plateNumber: "ABC123XY",
        vehicleName: "Honda Accord",
        chassisNumber: null,
        color: "Silver",
        reference: "prembly-ref-1",
      });
    });

    it("treats a missing vehicle_color as null and reads a registry chassis when present", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          data: {
            vehicle_number: "KJA-123AB",
            vehicle_name: "Toyota Camry",
            chassis_number: VALID_CHASSIS.toLowerCase(),
            vehicle: { ChassisNo: VALID_CHASSIS, carMake: "Toyota", carModel: "Camry" },
          },
        }),
      });

      await expect(service.verifyPlate("KJA-123AB")).resolves.toEqual({
        plateNumber: "KJA-123AB",
        vehicleName: "Toyota Camry",
        chassisNumber: VALID_CHASSIS,
        color: null,
        reference: "prembly-ref-1",
      });
    });

    it("reads ChassisNo when chassis_number is omitted", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          data: {
            vehicle_number: "KJA-123AB",
            vehicle_name: "Toyota Camry",
            vehicle: { ChassisNo: `  ${VALID_CHASSIS.toLowerCase()}  ` },
          },
        }),
      });

      await expect(service.verifyPlate("KJA-123AB")).resolves.toMatchObject({
        chassisNumber: VALID_CHASSIS,
      });
    });

    it("rejects a plate payload whose registry chassis is not a VIN", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: plateSuccess({
          data: {
            vehicle_number: "KJA-123AB",
            vehicle_name: "Toyota Camry",
            chassis_number: "NOT-A-VIN",
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

  describe("verifyFaceLiveness", () => {
    it("returns the liveness confidence and reference", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          status: true,
          response_code: "00",
          confidence: 0.92,
          verification,
        },
      });

      await expect(service.verifyFaceLiveness("selfie-b64")).resolves.toEqual({
        confidence: 0.92,
        reference: "prembly-ref-1",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/verification/biometrics/face/liveliness_check",
        { image: "selfie-b64" },
      );
    });
  });

  describe("compareFaces", () => {
    it("returns the face-match confidence", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          status: true,
          response_code: "00",
          confidence: 87.5,
        },
      });

      await expect(service.compareFaces("official-photo", "selfie-b64")).resolves.toEqual({
        confidence: 87.5,
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/verification/biometrics/face/comparison",
        { image_one: "official-photo", image_two: "selfie-b64" },
      );
    });
  });
});
