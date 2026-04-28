import { BookingExtensionConfirmationEmail } from "../emails";
import { sampleExtension } from "./preview-data";

export default function BookingExtensionPreview() {
  return <BookingExtensionConfirmationEmail extension={sampleExtension} />;
}

BookingExtensionPreview.PreviewProps = {
  extension: sampleExtension,
};
