export type BookingReceiptLineItem = {
  label: string;
  amount: number;
};

export type BookingReceiptModel = {
  bookingReference: string;
  generatedAt: Date;
  customerName: string | null;
  vehicle: string;
  chauffeurName: string | null;
  bookingStart: Date;
  bookingEnd: Date;
  pickupLocation: string;
  returnLocation: string;
  paymentStatus: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED";
  paymentReference: string;
  currency: string;
  lineItems: BookingReceiptLineItem[];
  totalPaid: number;
};

export type BookingReceiptPdf = {
  buffer: Buffer;
  fileName: string;
};
