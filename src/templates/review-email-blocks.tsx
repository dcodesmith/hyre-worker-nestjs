import { Heading, Hr, Section, Text } from "react-email";
import type { ReviewReceivedTemplateData } from "../modules/notification/template-data.interface";
import { firstNameFrom } from "./booking-email-helpers";

export function formatReviewDateDisplay(reviewDate: Date | string): string {
  if (typeof reviewDate === "string") {
    return reviewDate;
  }
  if (Number.isNaN(reviewDate.getTime())) {
    return String(reviewDate);
  }
  return reviewDate.toLocaleString();
}

export function formatRating(rating: unknown): string {
  const numericRating = typeof rating === "number" && Number.isFinite(rating) ? rating : 0;
  const clamped = Math.max(0, Math.min(5, numericRating));
  return clamped.toFixed(1);
}

function getRatingStars(rating: number): string {
  const clampedRating = Math.max(0, Math.min(5, Math.round(rating)));
  return "★".repeat(clampedRating) + "☆".repeat(5 - clampedRating);
}

type RatingOrder = "owner" | "chauffeur";

function ReviewSummaryCard({
  reviewData,
  ratingOrder,
}: {
  readonly reviewData: ReviewReceivedTemplateData;
  readonly ratingOrder: RatingOrder;
}) {
  const ratings =
    ratingOrder === "owner"
      ? [
          { label: "Overall Rating", value: reviewData.overallRating },
          { label: "Car Rating", value: reviewData.carRating },
          { label: "Chauffeur Rating", value: reviewData.chauffeurRating },
          { label: "Service Rating", value: reviewData.serviceRating },
        ]
      : [
          { label: "Chauffeur Rating", value: reviewData.chauffeurRating },
          { label: "Overall Rating", value: reviewData.overallRating },
          { label: "Car Rating", value: reviewData.carRating },
          { label: "Service Rating", value: reviewData.serviceRating },
        ];

  return (
    <Section className="mt-6 border border-solid border-[#E6E6E8] rounded-[14px] overflow-hidden">
      <Section className="px-5 py-4">
        <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
          Review summary
        </Text>
        {ratings.map(({ label, value }, index) => (
          <Text
            key={label}
            className={`text-[14px] leading-[20px] text-[#0B0B0F] m-0 ${index === 0 ? "mt-2" : "mt-3"}`}
          >
            <span className="font-semibold">{label}:</span> {getRatingStars(value)} (
            {formatRating(value)}/5)
          </Text>
        ))}
      </Section>
      {reviewData.comment && (
        <>
          <Hr className="m-0 border-t border-solid border-[#EFEFF1]" />
          <Section className="px-5 py-4 bg-[#FAFAFB]">
            <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
              Comment
            </Text>
            <Text className="text-[14px] leading-[22px] text-[#0B0B0F] m-0 mt-2 italic">
              {reviewData.comment}
            </Text>
          </Section>
        </>
      )}
    </Section>
  );
}

function ReviewBookingMetaCard({
  reviewData,
}: {
  readonly reviewData: ReviewReceivedTemplateData;
}) {
  return (
    <Section className="mt-6 border border-solid border-[#E6E6E8] rounded-[14px] overflow-hidden">
      <Section className="px-5 py-4">
        <Text className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#6A6A71] m-0">
          Booking details
        </Text>
        <Text className="text-[14px] leading-[20px] font-semibold text-[#0B0B0F] m-0 mt-2">
          Ref {reviewData.bookingReference}
        </Text>
        <Text className="text-[13px] leading-[18px] text-[#6A6A71] m-0 mt-1">
          Reviewed on {formatReviewDateDisplay(reviewData.reviewDate)}
        </Text>
      </Section>
    </Section>
  );
}

export function ReviewReceivedOwnerContent({
  ownerName,
  reviewData,
}: {
  readonly ownerName: string;
  readonly reviewData: ReviewReceivedTemplateData;
}) {
  return (
    <>
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        New review
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        Great news, {firstNameFrom(ownerName)} ⭐
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        <span className="font-semibold">{reviewData.customerName}</span> has left a{" "}
        <span className="font-semibold">{formatRating(reviewData.overallRating)}-star review</span>{" "}
        for your vehicle, <span className="font-semibold">{reviewData.carName}</span>.
      </Text>

      <ReviewSummaryCard reviewData={reviewData} ratingOrder="owner" />
      <ReviewBookingMetaCard reviewData={reviewData} />

      <Text className="text-[13px] leading-[18px] text-[#6A6A71] mt-6 mb-0">
        Thank you for providing excellent service. Your reviews help build trust and attract more
        customers.
      </Text>
    </>
  );
}

export function ReviewReceivedChauffeurContent({
  chauffeurName,
  reviewData,
}: {
  readonly chauffeurName: string;
  readonly reviewData: ReviewReceivedTemplateData;
}) {
  return (
    <>
      <Text className="text-[12px] font-semibold tracking-[0.08em] uppercase text-[#6A6A71] m-0 mb-2">
        New review
      </Text>
      <Heading as="h1" className="text-[26px] leading-[32px] font-extrabold text-[#0B0B0F] m-0">
        Great news, {firstNameFrom(chauffeurName)} ⭐
      </Heading>
      <Text className="text-[15px] leading-[22px] text-[#4A4A52] mt-3 mb-0">
        <span className="font-semibold">{reviewData.customerName}</span> has left a{" "}
        <span className="font-semibold">
          {formatRating(reviewData.chauffeurRating)}-star review
        </span>{" "}
        for your service as chauffeur for the{" "}
        <span className="font-semibold">{reviewData.carName}</span> booking.
      </Text>

      <ReviewSummaryCard reviewData={reviewData} ratingOrder="chauffeur" />
      <ReviewBookingMetaCard reviewData={reviewData} />

      <Text className="text-[13px] leading-[18px] text-[#6A6A71] mt-6 mb-0">
        Thank you for providing excellent service. Your reviews help build trust and showcase your
        professionalism.
      </Text>
    </>
  );
}
