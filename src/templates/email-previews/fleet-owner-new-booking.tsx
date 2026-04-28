import { FleetOwnerNewBookingEmail } from "../emails";
import { sampleBooking } from "./preview-data";

export default function FleetOwnerNewBookingPreview() {
  return <FleetOwnerNewBookingEmail booking={sampleBooking} />;
}

FleetOwnerNewBookingPreview.PreviewProps = {
  booking: sampleBooking,
};
