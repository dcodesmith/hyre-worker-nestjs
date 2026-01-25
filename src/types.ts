import { Prisma } from "@prisma/client";

export interface GuestUserDetails {
  name?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}

export type NormalisedBookingDetails = {
  customerPhone?: string;
  customerEmail?: string;
  bookingReference: string;
  id: string;
  customerName: string;
  ownerName: string;
  chauffeurName: string;
  chauffeurPhoneNumber: string;
  carName: string;
  pickupLocation: string;
  returnLocation: string;
  startDate: string;
  endDate: string;
  totalAmount: string;
  title: string;
  status: string;
  cancellationReason: string;
};

export type NormalisedBookingLegDetails = {
  bookingLegId: string;
  bookingId: string;
  customerName: string;
  chauffeurName: string;
  customerPhone?: string;
  customerEmail?: string;
  legDate: string;
  legStartTime: string;
  legEndTime: string;
  chauffeurPhone?: string;
  chauffeurEmail?: string;
  carName: string;
  pickupLocation: string;
  returnLocation: string;
};

export type BookingWithRelations = Prisma.BookingGetPayload<{
  include: {
    chauffeur: true;
    user: true;
    car: { include: { owner: true } };
    legs: {
      include: {
        extensions: true;
      };
    };
  };
}>;

export type BookingLegWithRelations = Prisma.BookingLegGetPayload<{
  include: {
    extensions: true;
    booking: {
      include: {
        car: { include: { owner: true } };
        user: true;
        chauffeur: true;
      };
    };
  };
}>;

export type ExtensionWithBookingLeg = Prisma.ExtensionGetPayload<{
  include: { bookingLeg: { select: { booking: { select: { userId: true; status: true } } } } };
}>;

export type PaymentWithRelations = Prisma.PaymentGetPayload<{
  include: {
    booking: { select: { id: true; status: true; userId: true } };
    extension: {
      select: {
        id: true;
        status: true;
        bookingLeg: { select: { booking: { select: { userId: true; status: true } } } };
      };
    };
  };
}>;
