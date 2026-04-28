import { FleetOwnerBookingCancellationEmail } from "../emails";
import { sampleFleetOwnerCancellation } from "./preview-data";

export default function BookingFleetOwnerCancellationPreview() {
  return <FleetOwnerBookingCancellationEmail booking={sampleFleetOwnerCancellation} />;
}

BookingFleetOwnerCancellationPreview.PreviewProps = {
  booking: sampleFleetOwnerCancellation,
};
