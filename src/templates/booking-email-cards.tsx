import type { ReactNode } from "react";
import { Hr, Section, Text } from "react-email";
export type TripCardData = {
  readonly bookingReference: string;
  readonly pickupLocation: string;
  readonly returnLocation: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly carName: string;
  readonly totalAmount: string;
};

function BookingRouteBlock({ trip }: { readonly trip: TripCardData }) {
  return (
    <Section className="px-5 py-4">
      <table
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        role="presentation"
        className="border-collapse"
      >
        <tbody>
          <tr>
            <td width="20" valign="top" align="center" className="w-[20px] p-0 align-top">
              <table
                width="20"
                cellPadding={0}
                cellSpacing={0}
                role="presentation"
                className="w-[20px]"
              >
                <tbody>
                  <tr>
                    <td align="center" className="h-[14px] p-0 leading-[10px]">
                      <div className="mx-auto mt-[2px] h-[10px] w-[10px] rounded-full bg-[#0B0B0F]" />
                    </td>
                  </tr>
                  <tr>
                    <td align="center" className="h-full p-0">
                      <div className="mx-auto -mb-px h-full min-h-[65px] w-[2px] bg-[#D8D8DC]" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
            <td valign="top" className="align-top pl-[14px] pb-[14px]">
              <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0 leading-[14px]">
                From
              </Text>
              <Text className="text-[14px] leading-[20px] font-semibold text-[#0B0B0F] m-0 mt-1">
                {trip.pickupLocation}
              </Text>
            </td>
          </tr>
          <tr>
            <td width="20" valign="top" align="center" className="w-[20px] p-0 align-top">
              <table
                width="20"
                cellPadding={0}
                cellSpacing={0}
                role="presentation"
                className="w-[20px]"
              >
                <tbody>
                  <tr>
                    <td align="center" className="h-[4px] p-0 leading-[4px]">
                      <div className="mx-auto mt-[-1px] h-[4px] w-[2px] bg-[#D8D8DC]" />
                    </td>
                  </tr>
                  <tr>
                    <td align="center" className="h-[12px] p-0 leading-[10px]">
                      <div className="mx-auto h-[10px] w-[10px] rounded-full bg-[#0B0B0F]" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
            <td valign="top" className="align-top pl-[14px]">
              <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0 leading-[14px]">
                To
              </Text>
              <Text className="text-[14px] leading-[20px] font-semibold text-[#0B0B0F] m-0 mt-1">
                {trip.returnLocation}
              </Text>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

type BookingTripCardProps = {
  readonly trip: TripCardData;
  readonly vehicleDescription: string;
  readonly amountLabel?: string;
  readonly extraSection?: ReactNode;
};

export function BookingTripCard({
  trip,
  vehicleDescription,
  amountLabel = "Total",
  extraSection,
}: BookingTripCardProps) {
  return (
    <Section className="mt-6 border border-solid border-[#E6E6E8] rounded-[14px] overflow-hidden">
      <Section className="px-5 pt-5 pb-4">
        <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
          Pickup
        </Text>
        <Text className="text-[18px] leading-[24px] font-bold text-[#0B0B0F] m-0 mt-1">
          {trip.startDate}
        </Text>
        <Text className="text-[13px] leading-[18px] text-[#6A6A71] m-0 mt-1">
          Drop-off &middot; {trip.endDate}
        </Text>
      </Section>

      <Hr className="m-0 border-t border-solid border-[#EFEFF1]" />
      <BookingRouteBlock trip={trip} />

      <Hr className="m-0 border-t border-solid border-[#EFEFF1]" />
      <Section className="px-5 py-4">
        <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
          Vehicle
        </Text>
        <Text className="text-[14px] leading-[20px] font-semibold text-[#0B0B0F] m-0 mt-1">
          {trip.carName}
        </Text>
        <Text className="text-[13px] leading-[18px] text-[#6A6A71] m-0 mt-1">
          {vehicleDescription}
        </Text>
      </Section>

      {extraSection && (
        <>
          <Hr className="m-0 border-t border-solid border-[#EFEFF1]" />
          <Section className="px-5 py-4">{extraSection}</Section>
        </>
      )}

      <Hr className="m-0 border-t border-solid border-[#EFEFF1]" />
      <Section className="px-5 py-4 bg-[#FAFAFB]">
        <table width="100%" cellPadding={0} cellSpacing={0} role="presentation">
          <tbody>
            <tr>
              <td>
                <Text className="text-[13px] text-[#6A6A71] m-0">{amountLabel}</Text>
              </td>
              <td align="right">
                <Text className="text-[16px] font-extrabold text-[#0B0B0F] m-0">
                  {trip.totalAmount}
                </Text>
              </td>
            </tr>
            <tr>
              <td>
                <Text className="text-[11px] text-[#9A9A9F] m-0 mt-1">
                  Ref {trip.bookingReference}
                </Text>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </Section>
    </Section>
  );
}
