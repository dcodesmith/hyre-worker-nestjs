import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { BookingReceiptModel } from "./booking-receipt.model";
import { BookingReceiptPdfService } from "./booking-receipt-pdf.service";

const receipt: BookingReceiptModel = {
  bookingReference: "TRIP-123",
  generatedAt: new Date("2026-08-31T12:00:00.000Z"),
  customerName: "Adé Customer",
  vehicle: "Toyota Camry (2025, Black)",
  chauffeurName: null,
  bookingStart: new Date("2026-08-20T08:00:00.000Z"),
  bookingEnd: new Date("2026-08-20T20:00:00.000Z"),
  pickupLocation: "Lagos Airport",
  returnLocation: "Victoria Island",
  paymentStatus: "PARTIALLY_REFUNDED",
  paymentReference: "booking_booking-1",
  currency: "NGN",
  lineItems: [
    { label: "Base booking charge", amount: 100000 },
    { label: "VAT (7.5%)", amount: 7500 },
    { label: "Refunds", amount: -2500 },
  ],
  totalPaid: 105000,
};

describe("BookingReceiptPdfService", () => {
  it("generates a valid single-page Tripdly PDF with built-in fonts", async () => {
    const buffer = await new BookingReceiptPdfService().render(receipt);
    const document = await PDFDocument.load(buffer);

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(document.getPageCount()).toBe(1);
    expect(document.getTitle()).toBe("Tripdly receipt TRIP-123");
    expect(document.getAuthor()).toBe("Tripdly");
  });
});
