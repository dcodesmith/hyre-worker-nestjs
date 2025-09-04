import {
  Body,
  Container,
  Font,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";
import { ReactNode } from "react";
import tailwindConfig from "../email-tailwind.config";
import { NormalisedBookingDetails, NormalisedBookingLegDetails } from "../types";

export interface EmailTemplateProps {
  readonly children: ReactNode;
  readonly previewText: string;
  readonly pageTitle?: string;
}

const COMPANY_NAME = process.env.APP_NAME || "Your Company Name";
const COMPANY_LOGO_URL =
  process.env.COMPANY_LOGO_URL || "https://via.placeholder.com/150x50?text=Your+Logo";
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || "Lagos, Nigeria";
const WEBSITE_URL = process.env.WEBSITE_URL || process.env.DOMAIN || "https://dcodesmith.com";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@dcodesmith.com";
const CURRENT_YEAR = new Date().getFullYear();

export function EmailTemplate({ children, previewText, pageTitle }: EmailTemplateProps) {
  const effectivePageTitle = pageTitle || previewText;

  return (
    <Tailwind config={tailwindConfig}>
      <Html lang="en">
        <Head>
          <title className="capitalize">{effectivePageTitle.toLowerCase()}</title>
          <Font
            fontFamily="Nunito Sans"
            fallbackFontFamily="sans-serif"
            webFont={{
              url: "https://fonts.googleapis.com/css2?family=Nunito+Sans:ital,wght@0,200..900;1,200..900&display=swap",
              format: "woff2",
            }}
            fontWeight={400}
            fontStyle="normal"
          />
          <Preview>{previewText}</Preview>
        </Head>
        <Body className="bg-gray-100 text-gray-800 font-sans text-base leading-relaxed">
          <Container className="bg-white border border-gray-200 rounded-md shadow-sm mx-auto my-8 p-6 sm:p-8 max-w-xl">
            <Section className="mb-6 text-center">
              <Img
                src={COMPANY_LOGO_URL}
                alt={`${COMPANY_NAME} Logo`}
                width="150"
                height="auto"
                className="mx-auto mb-4"
              />
            </Section>

            <Section>{children}</Section>

            <Hr className="my-6 border-gray-300" />
            <Section className="text-center text-xs text-gray-500">
              <Text className="mb-1">
                &copy; {CURRENT_YEAR} {COMPANY_NAME}. All rights reserved.
              </Text>
              {COMPANY_ADDRESS && <Text className="mb-1">{COMPANY_ADDRESS}</Text>}
              {WEBSITE_URL && WEBSITE_URL !== "#" && (
                <Text className="mb-1">
                  <Link href={WEBSITE_URL} className="text-blue-600 hover:underline">
                    Visit our website
                  </Link>
                </Text>
              )}
              {SUPPORT_EMAIL && (
                <Text>
                  Need help? Contact{" "}
                  <Link href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
                    {SUPPORT_EMAIL}
                  </Link>
                </Text>
              )}
            </Section>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}

interface DetailListItemProps {
  readonly label: string;
  readonly value: string | number | undefined | null;
  readonly isCurrency?: boolean;
  readonly currencyCode?: string;
}

function DetailListItem({
  label,
  value,
  isCurrency = false,
  currencyCode = "NGN",
}: DetailListItemProps) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  let displayValue: string | number = value;

  if (isCurrency) {
    displayValue = new Intl.NumberFormat("en-NG", {
      // Consider making locale dynamic if needed
      style: "currency",
      currency: currencyCode,
    }).format(Number(value));
  }

  return (
    <Text className="m-0 py-1">
      {" "}
      {/* Adjusted to text-sm for potentially long lists */}
      <span className="font-semibold">{label}:</span> {displayValue}
    </Text>
  );
}

export async function renderBookingStatusUpdateEmail(booking: NormalisedBookingDetails) {
  const previewText = `Your booking has ${booking.title}`;

  return await render(
    <EmailTemplate previewText={previewText} pageTitle={`Booking ${booking.title}`}>
      <Heading as="h2" className="text-xl font-semibold mb-4">
        Booking {booking.title}
      </Heading>
      <Text className="mb-3">Hello {booking.customerName},</Text>
      <Text className="mb-3">
        Your booking for the <span className="font-semibold">{booking.carName}</span> has{" "}
        {booking.title} and is now {booking.status}.
      </Text>
      <Section className="mt-4 border-t border-gray-200 pt-4">
        <Text className="font-semibold mb-2 underline">
          Booking Details (Booking Reference: {booking.bookingReference})
        </Text>
        <DetailListItem label="Start Date" value={booking.startDate} />
        <DetailListItem label="End Date" value={booking.endDate} />
        <DetailListItem label="Pickup Location" value={booking.pickupLocation} />
        <DetailListItem label="Drop-off Location" value={booking.returnLocation} />
        <Hr className="my-2 border-gray-300" />
        <DetailListItem label="Total Amount" value={booking.totalAmount} />
      </Section>
    </EmailTemplate>,
  );
}

export async function renderBookingReminderEmail(
  bookingLeg: NormalisedBookingLegDetails,
  recipientType: "client" | "chauffeur",
  isStartReminder = true,
) {
  const recipientName =
    recipientType === "client" ? bookingLeg.customerName : bookingLeg.chauffeurName;

  const reminderAction = isStartReminder ? "starts" : "ends";
  const previewText = `Reminder: Your booking ${reminderAction} in 1 hour.`;
  const carName = bookingLeg.carName;

  return await render(
    <EmailTemplate
      previewText={previewText}
      pageTitle={`Booking Leg ${isStartReminder ? "Start" : "End"} Reminder`}
    >
      <Heading as="h2" className="text-xl font-semibold mb-4">
        Booking Reminder
      </Heading>

      <Text className="mb-3">Hello {recipientName},</Text>

      <Text className="mb-3">
        This is a friendly reminder that your booking for the {carName} {reminderAction} in
        approximately 1 hour.
      </Text>

      <Section className="border border-gray-200 p-4 bg-gray-50">
        <Text className="font-semibold mb-2 underline">Booking Leg Details</Text>
        <DetailListItem label="Car" value={carName} />
        <DetailListItem label="Start Date & Time" value={bookingLeg.legStartTime} />
        <DetailListItem label="End Date & Time" value={bookingLeg.legEndTime} />
        <DetailListItem label="Pickup Location" value={bookingLeg.pickupLocation} />
        <DetailListItem label="Drop-off Location" value={bookingLeg.returnLocation} />
      </Section>

      {recipientType === "client" && isStartReminder && (
        <Text className="mb-3">
          Your chauffeur, {bookingLeg.chauffeurName}, will meet you at the pickup location.
        </Text>
      )}

      {recipientType === "chauffeur" && isStartReminder && (
        <Text className="mb-3">
          Your client, {bookingLeg.customerName}, will meet you at the pickup location.
        </Text>
      )}

      {recipientType === "client" && !isStartReminder && (
        // format(endDateToCheck, "HH:mm") !== "00:00" && (
        <Text className="mt-4 mb-3">
          Want to keep the car longer?{" "}
          <Link
            href={`${process.env.DOMAIN}/bookings/${bookingLeg.bookingId}/extend`} // Ensure this link is correct
            className="text-blue-600 underline"
          >
            Extend Booking
          </Link>
        </Text>
      )}

      {isStartReminder && <Text className="mt-4">Please be prepared for the scheduled time.</Text>}
    </EmailTemplate>,
  );
}
