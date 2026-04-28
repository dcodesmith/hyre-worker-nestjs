import type { ReactNode } from "react";
import {
  Body,
  Button,
  Container,
  Font,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  pixelBasedPreset,
  render,
  Section,
  Tailwind,
  Text,
} from "react-email";
import { getEmailPublicEnv } from "../email-public-env";
import type {
  BookingCancelledTemplateData,
  BookingExtensionConfirmedTemplateData,
  ReviewReceivedTemplateData,
} from "../modules/notification/template-data.interface";
import { NormalisedBookingDetails, NormalisedBookingLegDetails } from "../types";
import { BookingTripCard } from "./booking-email-cards";
import { bookingLegToTripCardData, firstNameFrom } from "./booking-email-helpers";
import {
  formatRating,
  ReviewReceivedChauffeurContent,
  ReviewReceivedOwnerContent,
} from "./review-email-blocks";

export interface EmailTemplateProps {
  readonly children: ReactNode;
  readonly previewText: string;
  readonly pageTitle?: string;
}

const CURRENT_YEAR = new Date().getFullYear();

export function EmailTemplate({ children, previewText, pageTitle }: EmailTemplateProps) {
  const effectivePageTitle = pageTitle || previewText;
  const { appName: companyName, websiteUrl, supportEmail, companyAddress } = getEmailPublicEnv();

  return (
    <Tailwind config={{ presets: [pixelBasedPreset] }}>
      <Html lang="en">
        <Head>
          <title>{effectivePageTitle}</title>
          <Font
            fontFamily="Nunito Sans"
            fallbackFontFamily={["Arial", "sans-serif"]}
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
        <Body
          className="bg-[#F4F4F5] m-0 py-8"
          style={{ fontFamily: '"Nunito Sans", Arial, sans-serif' }}
        >
          <Container className="max-w-[560px] mx-auto">
            <Section className="bg-white rounded-[16px] overflow-hidden">
              <Section className="px-8 pt-8 pb-2">
                <Text
                  className="text-[28px] leading-[32px] text-[#0B0B0F] m-0"
                  style={{ fontFamily: '"Dancing Script", cursive', fontWeight: 700 }}
                >
                  {companyName}
                </Text>
              </Section>
              <Section className="px-8 pb-8 pt-4">{children}</Section>
            </Section>

            <Section className="px-8 pt-6">
              <Text className="text-[12px] text-[#6A6A71] m-0 leading-5">
                Need a hand?{" "}
                <Link
                  href={`mailto:${supportEmail}`}
                  className="text-[#0B0B0F] font-medium underline"
                >
                  {supportEmail}
                </Link>
              </Text>
              <Text className="text-[12px] text-[#9A9A9F] mt-4 m-0 leading-5">
                &copy; {CURRENT_YEAR} {companyName} &middot; {companyAddress}
              </Text>
              {websiteUrl && websiteUrl !== "#" && (
                <Text className="text-[12px] text-[#9A9A9F] mt-1 m-0 leading-5">
                  <Link href={websiteUrl} className="text-[#9A9A9F] underline">
                    {websiteUrl.replace(/^https?:\/\//, "")}
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

export type BookingStatusUpdateEmailProps = {
  readonly booking: NormalisedBookingDetails & { showReviewRequest?: boolean };
};

export function BookingStatusUpdateEmail({ booking }: BookingStatusUpdateEmailProps) {
  const { websiteUrl } = getEmailPublicEnv();
  const firstName = firstNameFrom(booking.customerName);
  const bookingUrl =
    websiteUrl && websiteUrl !== "#" ? `${websiteUrl}/bookings/${booking.id}` : undefined;
  const previewText = `Your booking has ${booking.title}`;
  const showReviewRequest = booking.showReviewRequest ?? false;

  return (
    <EmailTemplate previewText={previewText} pageTitle={`Booking ${booking.status}`}>
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        Booking update
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        Hi {firstName}, your trip is {booking.status}.
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        Your booking for the <span className="font-semibold">{booking.carName}</span> has{" "}
        {booking.title}.
      </Text>

      <BookingTripCard
        trip={booking}
        vehicleDescription="We'll keep you posted as your ride progresses."
      />

      {bookingUrl && (
        <Section className="mt-6 text-center">
          <Button
            href={bookingUrl}
            className="bg-[#0B0B0F] text-white rounded-[10px] px-6 py-3 text-[14px] font-semibold no-underline inline-block"
          >
            View booking
          </Button>
        </Section>
      )}

      {showReviewRequest && (
        <Section className="mt-6 border border-solid border-[#E6E6E8] rounded-[14px] overflow-hidden">
          <Section className="px-5 py-4">
            <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
              Your feedback
            </Text>
            <Text className="text-[14px] leading-[22px] text-[#0B0B0F] m-0 mt-2">
              Your feedback helps us improve service and vehicle quality. Share your experience in
              about two minutes.
            </Text>
          </Section>
          <Hr className="m-0 border-t border-solid border-[#EFEFF1]" />
          <Section className="px-5 py-4 bg-[#FAFAFB] text-center">
            <Button
              href={`${websiteUrl}/bookings/${booking.id}#review`}
              className="bg-[#0B0B0F] text-white rounded-[10px] px-6 py-3 text-[14px] font-semibold no-underline inline-block"
            >
              Leave your review
            </Button>
          </Section>
        </Section>
      )}
    </EmailTemplate>
  );
}

export async function renderBookingStatusUpdateEmail(
  booking: NormalisedBookingDetails & { showReviewRequest?: boolean },
) {
  return await render(<BookingStatusUpdateEmail booking={booking} />);
}

export type BookingReminderEmailProps = {
  readonly bookingLeg: NormalisedBookingLegDetails;
  readonly recipientType: "client" | "chauffeur";
  readonly isStartReminder?: boolean;
};

export function BookingReminderEmail({
  bookingLeg,
  recipientType,
  isStartReminder = true,
}: BookingReminderEmailProps) {
  const recipientName =
    recipientType === "client" ? bookingLeg.customerName : bookingLeg.chauffeurName;

  const reminderAction = isStartReminder ? "starts" : "ends";
  const previewText = `Reminder: Your booking ${reminderAction} in 1 hour.`;
  const carName = bookingLeg.carName;
  const { websiteUrl } = getEmailPublicEnv();
  const cardTrip = bookingLegToTripCardData(bookingLeg);
  const firstName = firstNameFrom(recipientName);

  const vehicleDescription =
    recipientType === "client"
      ? isStartReminder
        ? `Your chauffeur (${bookingLeg.chauffeurName}) will meet you at pickup.`
        : "Please plan your return and drop-off on time."
      : isStartReminder
        ? `Pickup with ${bookingLeg.customerName} at the scheduled location.`
        : "Coordinate return timing with your client.";

  return (
    <EmailTemplate
      previewText={previewText}
      pageTitle={`Booking Leg ${isStartReminder ? "Start" : "End"} Reminder`}
    >
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        Trip reminder
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        Hi {firstName}, your booking {reminderAction} in about an hour.
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        This is a reminder for the <span className="font-semibold">{carName}</span> booking.
      </Text>

      <BookingTripCard trip={cardTrip} vehicleDescription={vehicleDescription} />

      {recipientType === "client" && !isStartReminder && (
        <Text className="text-[13px] leading-[18px] text-[#6A6A71] mt-6 mb-0">
          Want to keep the car longer?{" "}
          <Link
            href={`${websiteUrl}/bookings/${bookingLeg.bookingId}/extend`}
            className="text-[#0B0B0F] font-medium underline"
          >
            Extend booking
          </Link>
        </Text>
      )}

      {isStartReminder && (
        <Text className="text-[13px] leading-[18px] text-[#6A6A71] mt-6 mb-0">
          Please be prepared for the scheduled time.
        </Text>
      )}
    </EmailTemplate>
  );
}

export async function renderBookingReminderEmail(
  bookingLeg: NormalisedBookingLegDetails,
  recipientType: "client" | "chauffeur",
  isStartReminder = true,
) {
  return await render(
    <BookingReminderEmail
      bookingLeg={bookingLeg}
      recipientType={recipientType}
      isStartReminder={isStartReminder}
    />,
  );
}

export function BookingConfirmationEmail({
  booking,
}: {
  readonly booking: NormalisedBookingDetails;
}) {
  const { websiteUrl } = getEmailPublicEnv();
  const firstName = firstNameFrom(booking.customerName);
  const bookingUrl =
    websiteUrl && websiteUrl !== "#" ? `${websiteUrl}/bookings/${booking.id}` : undefined;
  const previewText = `Your ride is booked for ${booking.startDate}`;

  return (
    <EmailTemplate previewText={previewText} pageTitle="Booking confirmed">
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        Trip confirmed
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        See you soon, {firstName}.
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        Your ride in the <span className="font-semibold text-[#0B0B0F]">{booking.carName}</span> is
        all set. Here are the details for your trip.
      </Text>

      <BookingTripCard
        trip={booking}
        vehicleDescription="A chauffeur will be assigned and introduced before your pickup."
      />

      {bookingUrl && (
        <Section className="mt-6 text-center">
          <Button
            href={bookingUrl}
            className="bg-[#0B0B0F] text-white rounded-[10px] px-6 py-3 text-[14px] font-semibold no-underline inline-block"
          >
            Manage booking
          </Button>
        </Section>
      )}

      <Text className="text-[13px] leading-[18px] text-[#6A6A71] mt-6 mb-0">
        Please be ready at the pickup location on time. We&apos;ll email you again as soon as your
        chauffeur is assigned.
      </Text>

      <Hr className="my-6 border-t border-solid border-[#EFEFF1]" />

      <Text className="text-[12px] leading-[18px] text-[#9A9A9F] m-0">
        Need to make a change? Reply to this email or{" "}
        {bookingUrl ? (
          <Link href={bookingUrl} className="text-[#0B0B0F] font-medium underline">
            manage your booking online
          </Link>
        ) : (
          <span>manage your booking online</span>
        )}
        .
      </Text>
    </EmailTemplate>
  );
}

export async function renderBookingConfirmationEmail(booking: NormalisedBookingDetails) {
  return await render(<BookingConfirmationEmail booking={booking} />);
}

export function UserBookingCancellationEmail({
  booking,
}: {
  readonly booking: BookingCancelledTemplateData;
}) {
  const firstName = firstNameFrom(booking.customerName);
  const previewText = "Your booking has been cancelled";

  return (
    <EmailTemplate previewText={previewText} pageTitle="Booking Cancellation Confirmation">
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        Booking cancelled
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        We&apos;ve cancelled your trip, {firstName}.
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        Your booking for the <span className="font-semibold">{booking.carName}</span> has been
        cancelled.
      </Text>

      <Text className="text-[14px] leading-[20px] text-[#4A4A52] mt-3 mb-0">
        Your payment of <span className="font-semibold">{booking.totalAmount}</span> will be
        refunded shortly according to our policy.
      </Text>

      <BookingTripCard
        trip={booking}
        vehicleDescription="If you'd like to travel at a different time, you can make a new booking anytime."
        extraSection={
          booking.cancellationReason ? (
            <>
              <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
                Cancellation reason
              </Text>
              <Text className="text-[14px] leading-[20px] font-semibold text-[#0B0B0F] m-0 mt-1">
                {booking.cancellationReason}
              </Text>
            </>
          ) : undefined
        }
      />
    </EmailTemplate>
  );
}

export async function renderUserBookingCancellationEmail(booking: BookingCancelledTemplateData) {
  return await render(<UserBookingCancellationEmail booking={booking} />);
}

export function FleetOwnerBookingCancellationEmail({
  booking,
}: {
  readonly booking: BookingCancelledTemplateData;
}) {
  const firstName = firstNameFrom(booking.ownerName);
  const previewText = "A booking for your vehicle has been cancelled";

  return (
    <EmailTemplate previewText={previewText} pageTitle="Booking Cancellation Notification">
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        Fleet update
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        Booking cancelled, {firstName}.
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        The booking for your <span className="font-semibold">{booking.carName}</span> has been
        cancelled by {booking.customerName}.
      </Text>

      <BookingTripCard
        trip={booking}
        amountLabel="Booking amount"
        vehicleDescription="This trip slot is now open and can accept a new booking."
        extraSection={
          booking.cancellationReason ? (
            <>
              <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
                Cancellation reason
              </Text>
              <Text className="text-[14px] leading-[20px] font-semibold text-[#0B0B0F] m-0 mt-1">
                {booking.cancellationReason}
              </Text>
            </>
          ) : undefined
        }
      />
    </EmailTemplate>
  );
}

export async function renderFleetOwnerBookingCancellationEmail(
  booking: BookingCancelledTemplateData,
) {
  return await render(<FleetOwnerBookingCancellationEmail booking={booking} />);
}

export function BookingExtensionConfirmationEmail({
  extension,
}: {
  readonly extension: BookingExtensionConfirmedTemplateData;
}) {
  const firstName = firstNameFrom(extension.customerName);
  const previewText = "Your booking has been extended";

  return (
    <EmailTemplate previewText={previewText} pageTitle="Booking Extension Confirmation">
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        Trip extension
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        Your trip was extended, {firstName}.
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        Your booking for <span className="font-semibold">{extension.carName}</span> on{" "}
        {extension.legDate} has been extended for{" "}
        {extension.extensionHours === 1 ? "1 hour" : `${extension.extensionHours} hours`} from{" "}
        {extension.from} to {extension.to}.
      </Text>

      <Section className="mt-6 border border-solid border-[#E6E6E8] rounded-[14px] overflow-hidden">
        <Section className="px-5 py-4">
          <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
            Updated timeline
          </Text>
          <Text className="text-[18px] leading-[24px] font-bold text-[#0B0B0F] m-0 mt-1">
            {extension.from} - {extension.to}
          </Text>
          <Text className="text-[13px] leading-[18px] text-[#6A6A71] m-0 mt-1">
            {extension.extensionHours === 1
              ? "Extension duration: 1 hour"
              : `Extension duration: ${extension.extensionHours} hours`}
          </Text>
        </Section>
        <Hr className="m-0 border-t border-solid border-[#EFEFF1]" />
        <Section className="px-5 py-4 bg-[#FAFAFB]">
          <Text className="text-[13px] text-[#6A6A71] m-0">Date</Text>
          <Text className="text-[14px] leading-[20px] font-semibold text-[#0B0B0F] m-0 mt-1">
            {extension.legDate}
          </Text>
        </Section>
      </Section>

      <Text className="text-[13px] leading-[18px] text-[#6A6A71] mt-6 mb-0">
        Your chauffeur and trip details remain unchanged. Safe travels.
      </Text>
    </EmailTemplate>
  );
}

export async function renderBookingExtensionConfirmationEmail(
  extension: BookingExtensionConfirmedTemplateData,
) {
  return await render(<BookingExtensionConfirmationEmail extension={extension} />);
}

export interface AuthOTPEmailProps {
  readonly otp: string;
}

export function AuthOTPEmail({ otp }: AuthOTPEmailProps) {
  return (
    <EmailTemplate previewText="Your verification code" pageTitle="Verification Code">
      <Heading as="h2" className="text-xl font-semibold mb-4 text-center text-[#0B0B0F]">
        Your Verification Code
      </Heading>

      <Text className="mb-4 text-center text-[#6A6A71]">
        Use the code below to complete your sign in. This code will expire in 10 minutes.
      </Text>

      <Section className="bg-[#FAFAFA] border border-solid border-[#E6E6E8] rounded-[14px] p-6 my-6 text-center">
        <Text
          className="text-4xl font-bold tracking-widest text-[#0B0B0F] m-0"
          style={{ letterSpacing: "0.5em" }}
        >
          {otp}
        </Text>
      </Section>

      <Text className="text-sm text-[#9A9A9F] text-center">
        If you didn't request this code, you can safely ignore this email.
      </Text>
    </EmailTemplate>
  );
}

export async function renderAuthOTPEmail(props: AuthOTPEmailProps) {
  return await render(<AuthOTPEmail {...props} />);
}

export function FleetOwnerNewBookingEmail({
  booking,
}: {
  readonly booking: NormalisedBookingDetails;
}) {
  const previewText = "New Booking Alert - Action Required";
  const { websiteUrl } = getEmailPublicEnv();
  const firstName = firstNameFrom(booking.ownerName);
  const bookingLink =
    websiteUrl && websiteUrl !== "#"
      ? `${websiteUrl}/fleet-owner/bookings/${booking.id}?startDate=${encodeURIComponent(
          booking.startDate,
        )}`
      : undefined;

  return (
    <EmailTemplate previewText={previewText} pageTitle="New Booking Notification">
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        New booking
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        Assign a chauffeur, {firstName}.
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        A new booking has been made for your{" "}
        <span className="font-semibold">{booking.carName}</span>. Please assign a chauffeur to
        confirm operations.
      </Text>

      <BookingTripCard
        trip={booking}
        vehicleDescription={`Customer: ${booking.customerName}`}
        extraSection={
          <>
            <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
              Action required
            </Text>
            <Text className="text-[14px] leading-[20px] text-[#0B0B0F] m-0 mt-1">
              Assign a chauffeur to this trip so the customer receives final travel details.
            </Text>
          </>
        }
      />

      {bookingLink && (
        <Section className="mt-6 text-center">
          <Button
            href={bookingLink}
            className="bg-[#0B0B0F] text-white rounded-[10px] px-6 py-3 text-[14px] font-semibold no-underline inline-block"
          >
            Assign chauffeur
          </Button>
        </Section>
      )}
    </EmailTemplate>
  );
}

export async function renderFleetOwnerNewBookingEmail(booking: NormalisedBookingDetails) {
  return await render(<FleetOwnerNewBookingEmail booking={booking} />);
}

export function ReviewReceivedEmailForOwner({
  ownerName,
  data,
}: {
  readonly ownerName: string;
  readonly data: ReviewReceivedTemplateData;
}) {
  const previewText = `You received a ${formatRating(data.overallRating)}-star review from ${data.customerName}`;

  return (
    <EmailTemplate previewText={previewText} pageTitle="New Review Received">
      <ReviewReceivedOwnerContent ownerName={ownerName} reviewData={data} />
    </EmailTemplate>
  );
}

export async function renderReviewReceivedEmailForOwner(
  ownerName: string,
  data: ReviewReceivedTemplateData,
) {
  return await render(<ReviewReceivedEmailForOwner ownerName={ownerName} data={data} />);
}

export function ReviewReceivedEmailForChauffeur({
  chauffeurName,
  data,
}: {
  readonly chauffeurName: string;
  readonly data: ReviewReceivedTemplateData;
}) {
  const previewText = `You received a ${formatRating(data.chauffeurRating)}-star chauffeur review from ${data.customerName}`;

  return (
    <EmailTemplate previewText={previewText} pageTitle="New Review Received">
      <ReviewReceivedChauffeurContent chauffeurName={chauffeurName} reviewData={data} />
    </EmailTemplate>
  );
}

export async function renderReviewReceivedEmailForChauffeur(
  chauffeurName: string,
  data: ReviewReceivedTemplateData,
) {
  return await render(
    <ReviewReceivedEmailForChauffeur chauffeurName={chauffeurName} data={data} />,
  );
}
