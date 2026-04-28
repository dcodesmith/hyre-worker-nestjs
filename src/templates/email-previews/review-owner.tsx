import { ReviewReceivedEmailForOwner } from "../emails";
import { sampleReviewReceived } from "./preview-data";

export default function ReviewOwnerPreview() {
  return <ReviewReceivedEmailForOwner ownerName="Fleet Lagos Ltd" data={sampleReviewReceived} />;
}

ReviewOwnerPreview.PreviewProps = {
  ownerName: "Fleet Lagos Ltd",
  data: sampleReviewReceived,
};
