import { HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAxiosErrorWithRequest,
  createAxiosErrorWithResponse,
  createMockAxiosInstance,
  createMockHttpClientService,
} from "../http-client/http-client.fixtures";
import { HttpClientService } from "../http-client/http-client.service";
import { MonoError, MonoService } from "./mono.service";

const NIN = "12345678901";
const LICENSE_NUMBER = "AAD23208212298";
const DATE_OF_BIRTH = new Date(Date.UTC(1990, 0, 1));
const ACCOUNT_NUMBER = "0123456789";

const ninSuccess = (data: Record<string, unknown> = {}) => ({
  status: "successful",
  message: "NIN Lookup Successfull",
  timestamp: "2024-02-28T15:00:20.917Z",
  data: {
    firstname: "JOHN",
    middlename: "MIDDLE",
    surname: "DOE",
    nin: NIN,
    birthdate: "01-01-1990",
    photo: "nin-photo",
    ...data,
  },
});

const licenseSuccess = (data: Record<string, unknown> = {}) => ({
  status: "successful",
  message: "Lookup Successful",
  timestamp: "2024-02-28T15:00:20.917Z",
  data: {
    gender: "Male",
    photo: "license-photo",
    license_no: LICENSE_NUMBER,
    first_name: "JOHN",
    last_name: "DOE",
    middle_name: "MIDDLE",
    issued_date: "2021-10-07",
    expiry_date: "2099-12-31",
    state_ofIssue: "OYO",
    birth_date: "1990-01-01",
    ...data,
  },
});

const banksSuccess = (banks: unknown[] = []) => ({
  status: "successful",
  message: "Lookup Successful",
  data: { banks },
});

const accountSuccess = (data: Record<string, unknown> = {}) => ({
  status: "successful",
  message: "Lookup Successful",
  data: {
    name: "JOHN DOE",
    account_number: ACCOUNT_NUMBER,
    bank: { name: "GTBANK PLC", code: "000013" },
    ...data,
  },
});

describe("MonoService", () => {
  let service: MonoService;
  let mockAxiosInstance: ReturnType<typeof createMockAxiosInstance>;

  const mockConfig = {
    MONO_SECRET_KEY: "test-mono-secret-key",
    MONO_BASE_URL: "https://api.withmono.com",
  };

  beforeEach(async () => {
    mockAxiosInstance = createMockAxiosInstance();
    const mockHttpClientService = createMockHttpClientService(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonoService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => mockConfig[key as keyof typeof mockConfig]),
          },
        },
        { provide: HttpClientService, useValue: mockHttpClientService },
      ],
    }).compile();

    service = module.get(MonoService);
  });

  describe("verifyNin", () => {
    it("parses names, photo, and DD-MM-YYYY birthdate as UTC", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: ninSuccess() });

      await expect(service.verifyNin(NIN)).resolves.toEqual({
        firstName: "JOHN",
        middleName: "MIDDLE",
        lastName: "DOE",
        dateOfBirth: DATE_OF_BIRTH,
        officialPhoto: "nin-photo",
        reference: "2024-02-28T15:00:20.917Z",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/v3/lookup/nin", { nin: NIN });
    });

    it("treats a blank middle name and photo as null", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ middlename: "   ", photo: "" }),
      });

      await expect(service.verifyNin(NIN)).resolves.toMatchObject({
        middleName: null,
        officialPhoto: null,
      });
    });

    it("falls back to a stable reference when timestamp is omitted", async () => {
      const { timestamp: _timestamp, ...payload } = ninSuccess();
      mockAxiosInstance.post.mockResolvedValueOnce({ data: payload });

      await expect(service.verifyNin(NIN)).resolves.toMatchObject({
        reference: "mono:nin",
      });
    });

    it("rejects a NIN that does not exactly match the requested number", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ nin: "10987654321" }),
      });

      await expect(service.verifyNin(NIN)).rejects.toEqual(new MonoError("REJECTED"));
    });

    it("rejects an unsuccessful lookup status", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { ...ninSuccess(), status: "failed" },
      });

      await expect(service.verifyNin(NIN)).rejects.toEqual(new MonoError("REJECTED"));
    });

    it("rejects a payload missing the surname", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ surname: "" }),
      });

      await expect(service.verifyNin(NIN)).rejects.toEqual(new MonoError("INVALID_RESPONSE"));
    });

    it("rejects an impossible birthdate as an invalid response", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: ninSuccess({ birthdate: "31-02-1990" }),
      });

      await expect(service.verifyNin(NIN)).rejects.toEqual(new MonoError("INVALID_RESPONSE"));
    });

    it("maps a 400 lookup error to REJECTED", async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(
        createAxiosErrorWithResponse(HttpStatus.BAD_REQUEST, { message: "Invalid NIN Number" }),
      );

      await expect(service.verifyNin(NIN)).rejects.toEqual(new MonoError("REJECTED"));
    });

    it("maps a network failure to UNAVAILABLE", async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(createAxiosErrorWithRequest("timeout"));

      await expect(service.verifyNin(NIN)).rejects.toEqual(new MonoError("UNAVAILABLE"));
    });
  });

  describe("verifyDriversLicense", () => {
    it("sends the NIN date of birth and parses ISO licence dates", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: licenseSuccess() });

      await expect(
        service.verifyDriversLicense(LICENSE_NUMBER, "JOHN", "DOE", DATE_OF_BIRTH),
      ).resolves.toEqual({
        licenseNumber: LICENSE_NUMBER,
        firstName: "JOHN",
        middleName: "MIDDLE",
        lastName: "DOE",
        dateOfBirth: DATE_OF_BIRTH,
        expiresAt: new Date(Date.UTC(2099, 11, 31)),
        officialPhoto: "license-photo",
        reference: "2024-02-28T15:00:20.917Z",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/v3/lookup/driver_license", {
        license_number: LICENSE_NUMBER,
        first_name: "JOHN",
        last_name: "DOE",
        date_of_birth: "1990-01-01",
      });
    });

    it("allows a null official photo", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: licenseSuccess({ photo: null }),
      });

      await expect(
        service.verifyDriversLicense(LICENSE_NUMBER, "JOHN", "DOE", DATE_OF_BIRTH),
      ).resolves.toMatchObject({ officialPhoto: null });
    });

    it("rejects a licence number that does not match the submitted identifier", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: licenseSuccess({ license_no: "OTHER999" }),
      });

      await expect(
        service.verifyDriversLicense(LICENSE_NUMBER, "JOHN", "DOE", DATE_OF_BIRTH),
      ).rejects.toEqual(new MonoError("REJECTED"));
    });

    it("rejects an impossible expiry date as an invalid response", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: licenseSuccess({ expiry_date: "2026-13-40" }),
      });

      await expect(
        service.verifyDriversLicense(LICENSE_NUMBER, "JOHN", "DOE", DATE_OF_BIRTH),
      ).rejects.toEqual(new MonoError("INVALID_RESPONSE"));
    });

    it("maps a 422 lookup error to REJECTED", async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(
        createAxiosErrorWithResponse(HttpStatus.UNPROCESSABLE_ENTITY),
      );

      await expect(
        service.verifyDriversLicense(LICENSE_NUMBER, "JOHN", "DOE", DATE_OF_BIRTH),
      ).rejects.toEqual(new MonoError("REJECTED"));
    });

    it("maps a 500 lookup error to UNAVAILABLE", async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(
        createAxiosErrorWithResponse(HttpStatus.INTERNAL_SERVER_ERROR),
      );

      await expect(
        service.verifyDriversLicense(LICENSE_NUMBER, "JOHN", "DOE", DATE_OF_BIRTH),
      ).rejects.toEqual(new MonoError("UNAVAILABLE"));
    });
  });

  describe("listNigerianBanks", () => {
    it("returns sorted NIP bank codes and caches the result", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([
          { name: "ZENITH BANK PLC", bank_code: null, nip_code: "000015" },
          { name: "GTBANK PLC", bank_code: null, nip_code: "000013" },
        ]),
      });

      await expect(service.listNigerianBanks()).resolves.toEqual([
        { code: "000013", name: "GTBANK PLC", bankCode: null },
        { code: "000015", name: "ZENITH BANK PLC", bankCode: null },
      ]);
      await service.listNigerianBanks();

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/v3/lookup/banks");
    });

    it("rejects malformed bank-list responses", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([{ name: "GTBANK PLC", nip_code: "13" }]),
      });

      await expect(service.listNigerianBanks()).rejects.toEqual(new MonoError("INVALID_RESPONSE"));
    });
  });

  describe("resolveBankAccount", () => {
    it("resolves with a submitted Mono NIP code", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([{ name: "GTBANK PLC", nip_code: "000013" }]),
      });
      mockAxiosInstance.post.mockResolvedValueOnce({ data: accountSuccess() });

      await expect(
        service.resolveBankAccount("GTBANK PLC", "000013", ACCOUNT_NUMBER),
      ).resolves.toEqual({
        accountNumber: ACCOUNT_NUMBER,
        accountName: "JOHN DOE",
        bankCode: "000013",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/v3/lookup/account-number", {
        nip_code: "000013",
        account_number: ACCOUNT_NUMBER,
      });
    });

    it("maps a legacy provider code to Mono by normalized bank name", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([{ name: "GTBANK PLC", nip_code: "000013" }]),
      });
      mockAxiosInstance.post.mockResolvedValueOnce({ data: accountSuccess() });

      await service.resolveBankAccount("GTBank Plc", "058", ACCOUNT_NUMBER);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/v3/lookup/account-number", {
        nip_code: "000013",
        account_number: ACCOUNT_NUMBER,
      });
    });

    it("maps a Flutterwave code through Mono bank metadata when provider names differ", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([
          { name: "PROVIDER-SPECIFIC NAME", bank_code: "058", nip_code: "000013" },
        ]),
      });
      mockAxiosInstance.post.mockResolvedValueOnce({ data: accountSuccess() });

      await service.resolveBankAccount("GTBank Plc", "058", ACCOUNT_NUMBER);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/v3/lookup/account-number", {
        nip_code: "000013",
        account_number: ACCOUNT_NUMBER,
      });
    });

    it("maps known provider aliases when Mono omits the Flutterwave code", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([{ name: "OPAY", bank_code: null, nip_code: "100004" }]),
      });
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: accountSuccess({ bank: { name: "OPAY", code: "100004" } }),
      });

      await service.resolveBankAccount("Paycom", "305", ACCOUNT_NUMBER);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/v3/lookup/account-number", {
        nip_code: "100004",
        account_number: ACCOUNT_NUMBER,
      });
    });

    it("does not let an exact NIP code override a different canonical bank name", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([
          { name: "GTBANK PLC", nip_code: "000013" },
          { name: "ACCESS BANK", nip_code: "000014" },
        ]),
      });
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: accountSuccess({ bank: { name: "ACCESS BANK", code: "000014" } }),
      });

      await service.resolveBankAccount("Access Bank", "000013", ACCOUNT_NUMBER);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/v3/lookup/account-number", {
        nip_code: "000014",
        account_number: ACCOUNT_NUMBER,
      });
    });

    it("rejects an unsupported bank without requesting account details", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([{ name: "GTBANK PLC", nip_code: "000013" }]),
      });

      await expect(
        service.resolveBankAccount("UNKNOWN BANK", "999", ACCOUNT_NUMBER),
      ).rejects.toEqual(new MonoError("REJECTED"));
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it("rejects account details that do not match the request", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: banksSuccess([{ name: "GTBANK PLC", nip_code: "000013" }]),
      });
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: accountSuccess({ account_number: "9999999999" }),
      });

      await expect(
        service.resolveBankAccount("GTBANK PLC", "000013", ACCOUNT_NUMBER),
      ).rejects.toEqual(new MonoError("REJECTED"));
    });
  });
});
