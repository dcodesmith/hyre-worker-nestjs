import { Test, TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service";
import { FlutterwaveService } from "../flutterwave/flutterwave.service";
import { PaymentService } from "./payment.service";

describe("PaymentService", () => {
  let service: PaymentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: DatabaseService,
          useValue: {
            payoutTransaction: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({ id: "payout-123" }),
              update: vi.fn().mockResolvedValue({ id: "payout-123" }),
            },
            bankDetails: {
              findUnique: vi.fn().mockResolvedValue({
                id: "bank-123",
                bankCode: "044",
                accountNumber: "1234567890",
                bankName: "Access Bank",
                isVerified: true,
              }),
            },
            booking: {
              update: vi.fn().mockResolvedValue({}),
            },
          },
        },
        {
          provide: FlutterwaveService,
          useValue: {
            initiatePayout: vi.fn().mockResolvedValue({
              success: true,
              data: { id: 12345 },
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should have database and flutterwave services injected", () => {
    expect(service).toHaveProperty("databaseService");
    expect(service).toHaveProperty("flutterwaveService");
  });
});
