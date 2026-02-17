import {
  Body,
  Container,
  Font,
  Head,
  Heading,
  Hr,
  Html,
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

const COMPANY_NAME = process.env.APP_NAME || "Tripdly";
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || "Lagos, Nigeria";
const WEBSITE_URL = process.env.DOMAIN;
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
          <style>
            {`@import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&display=swap');`}
          </style>
          <Preview>{previewText}</Preview>
        </Head>
        <Body className="bg-gray-100 text-gray-800 font-sans text-base leading-relaxed">
          <Container className="bg-white border border-gray-200 rounded-md shadow-sm mx-auto my-8 p-6 sm:p-8 max-w-xl">
            <Section className="mb-6 text-center">
              <Text
                style={{ fontFamily: '"Dancing Script", cursive' }}
                className="mx-auto mb-4 text-4xl leading-tight text-gray-900"
              >
                {COMPANY_NAME}
              </Text>
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

export async function renderBookingStatusUpdateEmail(
  booking: NormalisedBookingDetails & { showReviewRequest?: boolean },
) {
  const previewText = `Your booking has ${booking.title}`;
  const showReviewRequest = booking.showReviewRequest ?? false;

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

      {showReviewRequest && (
        <Section className="mt-6 border-t-2 border-blue-200 pt-6">
          <Section className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6 mb-4">
            <Heading as="h3" className="text-xl font-bold mb-3 text-gray-900">
              Your Feedback Matters
            </Heading>
            <Text className="mb-3 text-gray-700 leading-relaxed">
              Your feedback is essential to our service improvement process. We review every comment
              and rating to identify areas for enhancement and celebrate what we're doing right.
            </Text>
            <Text className="mb-4 text-gray-700 leading-relaxed">
              Your review helps us maintain high standards and improve our service. We use your
              feedback to make data-driven decisions that directly impact vehicle quality, chauffeur
              training, and customer experience.
            </Text>
            <Section className="bg-white rounded-md p-4 border border-blue-100 mb-4">
              <Text className="text-sm text-gray-600 mb-2 font-semibold">
                Share your experience in just 2 minutes:
              </Text>
              <Text className="text-sm text-gray-700 mb-0">
                • Rate your overall experience, the car, chauffeur, and service
              </Text>
              <Text className="text-sm text-gray-700 mb-0">
                • Help us understand what we did well and where we can improve
              </Text>
            </Section>
            <Section className="text-center">
              <Link
                href={`${WEBSITE_URL}/bookings/${booking.id}#review`}
                className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-8 py-3 rounded-lg text-base shadow-md transition-colors"
              >
                Leave Your Review
              </Link>
            </Section>
            <Text className="mt-4 text-xs text-gray-500 text-center italic">
              Thank you for being part of our journey to excellence
            </Text>
          </Section>
        </Section>
      )}
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

      <Section className="border border-gray-200 p-4">
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

export async function renderBookingConfirmationEmail(booking: NormalisedBookingDetails) {
  const customerName = booking.customerName;
  const carName = booking.carName;
  const previewText = "Your booking is confirmed!";

  return await render(
    <EmailTemplate previewText={previewText} pageTitle="Booking Confirmation">
      <Heading as="h2" className="text-xl font-semibold mb-4">
        Booking Confirmed!
      </Heading>
      <Text className="mb-3">Hello {customerName},</Text>
      <Text className="mb-3">
        Your booking for the <span className="font-semibold">{carName}</span> has been confirmed.
      </Text>
      <Section className="border border-gray-200 rounded-md p-4 bg-gray-50">
        <Text className="font-semibold mb-2 underline">
          Booking Details (Booking Reference: {booking.bookingReference})
        </Text>
        <DetailListItem label="Start Date & Time" value={booking.startDate} />
        <DetailListItem label="End Date & Time" value={booking.endDate} />
        <DetailListItem label="Pickup Location" value={booking.pickupLocation} />
        <DetailListItem label="Drop-off Location" value={booking.returnLocation} />
        <Hr className="my-2 border-gray-300" />
        <DetailListItem label="Total Amount" value={booking.totalAmount} />
      </Section>
      <Text className="mb-3">
        Please be at the pickup location on time. You'll be assigned a chauffeur shortly, and we
        will notify you with their details.
      </Text>
    </EmailTemplate>,
  );
}

export interface AuthOTPEmailProps {
  readonly otp: string;
}

export async function renderAuthOTPEmail({ otp }: AuthOTPEmailProps) {
  return await render(
    <EmailTemplate previewText="Your verification code" pageTitle="Verification Code">
      <Heading as="h2" className="text-xl font-semibold mb-4 text-center">
        Your Verification Code
      </Heading>

      <Text className="mb-4 text-center text-gray-600">
        Use the code below to complete your sign in. This code will expire in 10 minutes.
      </Text>

      <Section className="bg-gray-50 border border-gray-200 rounded-lg p-6 my-6 text-center">
        <Text
          className="text-4xl font-bold tracking-widest text-gray-900 m-0"
          style={{ letterSpacing: "0.5em" }}
        >
          {otp}
        </Text>
      </Section>

      <Text className="text-sm text-gray-500 text-center">
        If you didn't request this code, you can safely ignore this email.
      </Text>
    </EmailTemplate>,
  );
}

export async function renderFleetOwnerNewBookingEmail(booking: NormalisedBookingDetails) {
  const previewText = "New Booking Alert - Action Required";
  const dashboardUrl = `${WEBSITE_URL}/fleet-owner/bookings/${booking.id}?startDate=${encodeURIComponent(booking.startDate)}`;

  return await render(
    <EmailTemplate previewText={previewText} pageTitle="New Booking Notification">
      <Heading as="h2" className="text-xl font-semibold mb-4">
        New Booking Alert - Action Required
      </Heading>
      <Text className="mb-3">Hello {booking.ownerName},</Text>
      <Text className="mb-3">
        A new booking has been made for your{" "}
        <span className="font-semibold">{booking.carName}</span>. Please{" "}
        <Link href={dashboardUrl} className="text-blue-600 underline">
          assign a chauffeur
        </Link>{" "}
        for this booking as soon as possible.
      </Text>
      <Section className="border border-gray-200 rounded-md p-4 bg-gray-50">
        <Text className="font-semibold mb-2 underline">Booking Details</Text>
        <DetailListItem label="Customer" value={booking.customerName} />
        <DetailListItem label="Start Date & Time" value={booking.startDate} />
        <DetailListItem label="End Date & Time" value={booking.endDate} />
        <DetailListItem label="Car" value={booking.carName} />
        <DetailListItem label="Pickup Location" value={booking.pickupLocation} />
        <DetailListItem label="Drop-off Location" value={booking.returnLocation} />
        <Hr className="my-2 border-gray-300" />
        <DetailListItem label="Total Amount" value={booking.totalAmount} />
      </Section>
      <Text className="mt-4 text-sm text-gray-600">
        If you have any questions, feel free to contact us.
      </Text>
    </EmailTemplate>,
  );
}

export interface ReviewReceivedTemplateData {
  readonly customerName: string;
  readonly bookingReference: string;
  readonly carName: string;
  readonly overallRating: number;
  readonly carRating: number;
  readonly chauffeurRating: number;
  readonly serviceRating: number;
  readonly comment: string | null;
  readonly reviewDate: Date;
}

export async function renderReviewReceivedEmailForOwner(
  ownerName: string,
  data: ReviewReceivedTemplateData,
) {
  return await render(
    <EmailTemplate
      previewText={`New ${data.overallRating}-star review received`}
      pageTitle="New Review Received"
    >
      <Heading as="h2" className="text-xl font-semibold mb-4">
        New Review Received
      </Heading>
      <Text className="mb-3">Hello {ownerName},</Text>
      <Text className="mb-3">
        A customer left a new review for <span className="font-semibold">{data.carName}</span>.
      </Text>
      <Section className="border border-gray-200 rounded-md p-4 bg-gray-50">
        <Text className="font-semibold mb-2 underline">Review Details</Text>
        <DetailListItem label="Customer" value={data.customerName} />
        <DetailListItem label="Booking Reference" value={data.bookingReference} />
        <DetailListItem label="Overall Rating" value={`${data.overallRating}/5`} />
        <DetailListItem label="Car Rating" value={`${data.carRating}/5`} />
        <DetailListItem label="Chauffeur Rating" value={`${data.chauffeurRating}/5`} />
        <DetailListItem label="Service Rating" value={`${data.serviceRating}/5`} />
        <DetailListItem label="Comment" value={data.comment || "No comment"} />
        <DetailListItem label="Review Date" value={data.reviewDate.toLocaleString()} />
      </Section>
    </EmailTemplate>,
  );
}

export async function renderReviewReceivedEmailForChauffeur(
  chauffeurName: string,
  data: ReviewReceivedTemplateData,
) {
  return await render(
    <EmailTemplate
      previewText={`New ${data.chauffeurRating}-star review received`}
      pageTitle="New Review Received"
    >
      <Heading as="h2" className="text-xl font-semibold mb-4">
        New Review Received
      </Heading>
      <Text className="mb-3">Hello {chauffeurName},</Text>
      <Text className="mb-3">A customer left feedback about your service.</Text>
      <Section className="border border-gray-200 rounded-md p-4 bg-gray-50">
        <Text className="font-semibold mb-2 underline">Review Details</Text>
        <DetailListItem label="Customer" value={data.customerName} />
        <DetailListItem label="Booking Reference" value={data.bookingReference} />
        <DetailListItem label="Car" value={data.carName} />
        <DetailListItem label="Your Rating" value={`${data.chauffeurRating}/5`} />
        <DetailListItem label="Overall Rating" value={`${data.overallRating}/5`} />
        <DetailListItem label="Comment" value={data.comment || "No comment"} />
        <DetailListItem label="Review Date" value={data.reviewDate.toLocaleString()} />
      </Section>
    </EmailTemplate>,
  );
}
