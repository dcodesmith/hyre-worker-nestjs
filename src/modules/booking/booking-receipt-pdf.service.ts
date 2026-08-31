import { Injectable } from "@nestjs/common";
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { BookingReceiptModel } from "./booking-receipt.model";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

@Injectable()
export class BookingReceiptPdfService {
  async render(receipt: BookingReceiptModel): Promise<Buffer> {
    const document = await PDFDocument.create();
    document.setTitle(`Tripdly receipt ${receipt.bookingReference}`);
    document.setAuthor("Tripdly");
    document.setCreator("Tripdly");
    document.setCreationDate(receipt.generatedAt);

    const regular = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const dark = rgb(0.09, 0.13, 0.2);
    const muted = rgb(0.38, 0.42, 0.48);
    const accent = rgb(0.93, 0.42, 0.16);
    let y = PAGE_HEIGHT - MARGIN;

    page.drawText("Tripdly", { x: MARGIN, y, size: 24, font: bold, color: dark });
    page.drawText("RECEIPT", {
      x: PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize("RECEIPT", 20),
      y: y + 2,
      size: 20,
      font: bold,
      color: accent,
    });
    y -= 28;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 1.5,
      color: accent,
    });
    y -= 30;

    y = this.drawDetail(page, regular, bold, y, "Booking reference", receipt.bookingReference);
    y = this.drawDetail(page, regular, bold, y, "Issued", this.formatDate(receipt.generatedAt));
    if (receipt.customerName) {
      y = this.drawDetail(page, regular, bold, y, "Customer", receipt.customerName);
    }
    y = this.drawDetail(page, regular, bold, y, "Vehicle", receipt.vehicle);
    if (receipt.chauffeurName) {
      y = this.drawDetail(page, regular, bold, y, "Chauffeur", receipt.chauffeurName);
    }
    y = this.drawDetail(
      page,
      regular,
      bold,
      y,
      "Booking period",
      `${this.formatDate(receipt.bookingStart)} - ${this.formatDate(receipt.bookingEnd)}`,
    );
    y = this.drawDetail(page, regular, bold, y, "Pickup", receipt.pickupLocation);
    y = this.drawDetail(page, regular, bold, y, "Return", receipt.returnLocation);
    y = this.drawDetail(
      page,
      regular,
      bold,
      y,
      "Payment status",
      receipt.paymentStatus.replaceAll("_", " "),
    );
    y = this.drawDetail(page, regular, bold, y, "Payment reference", receipt.paymentReference);
    y -= 14;

    page.drawText("Payment breakdown", { x: MARGIN, y, size: 14, font: bold, color: dark });
    y -= 12;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.75,
      color: muted,
    });
    y -= 22;

    for (const item of receipt.lineItems) {
      page.drawText(this.fitText(item.label, regular, 10, CONTENT_WIDTH - 130), {
        x: MARGIN,
        y,
        size: 10,
        font: regular,
        color: dark,
      });
      const amount = this.formatMoney(item.amount, receipt.currency);
      page.drawText(amount, {
        x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(amount, 10),
        y,
        size: 10,
        font: regular,
        color: dark,
      });
      y -= 21;
    }

    page.drawLine({
      start: { x: MARGIN, y: y + 5 },
      end: { x: PAGE_WIDTH - MARGIN, y: y + 5 },
      thickness: 1,
      color: dark,
    });
    const totalLabel = "Total paid";
    const total = this.formatMoney(receipt.totalPaid, receipt.currency);
    page.drawText(totalLabel, { x: MARGIN, y: y - 12, size: 13, font: bold, color: dark });
    page.drawText(total, {
      x: PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize(total, 13),
      y: y - 12,
      size: 13,
      font: bold,
      color: dark,
    });

    page.drawText("Thank you for your business", {
      x: MARGIN,
      y: MARGIN + 24,
      size: 12,
      font: bold,
      color: accent,
    });
    page.drawText("This is a customer payment receipt, not a tax invoice.", {
      x: MARGIN,
      y: MARGIN + 7,
      size: 8,
      font: regular,
      color: muted,
    });

    return Buffer.from(await document.save());
  }

  private drawDetail(
    page: PDFPage,
    regular: PDFFont,
    bold: PDFFont,
    y: number,
    label: string,
    value: string,
  ): number {
    page.drawText(label, { x: MARGIN, y, size: 9, font: bold, color: rgb(0.38, 0.42, 0.48) });
    page.drawText(this.fitText(value, regular, 10, CONTENT_WIDTH - 130), {
      x: MARGIN + 130,
      y,
      size: 10,
      font: regular,
      color: rgb(0.09, 0.13, 0.2),
    });
    return y - 20;
  }

  private fitText(value: string, font: PDFFont, size: number, maxWidth: number): string {
    const text = value
      .normalize("NFKD")
      .replaceAll(/\p{Mark}/gu, "")
      .replaceAll(/[^\x20-\x7e]/g, "?");
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;

    let truncated = text.slice(0, 120);
    while (truncated.length > 1 && font.widthOfTextAtSize(`${truncated}...`, size) > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    return `${truncated}...`;
  }

  private formatDate(value: Date): string {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: true,
      timeZone: "Africa/Lagos",
    }).format(value);
  }

  private formatMoney(amount: number, currency: string): string {
    const formatted = new Intl.NumberFormat("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(amount));
    return `${amount < 0 ? "-" : ""}${currency} ${formatted}`;
  }
}
