import { ReviewReceivedEmailForOwner } from "../emails";
import { sampleReviewReceived } from "./preview-data";

const OWNER_NAME = "Fleet Lagos Ltd";

export default function ReviewOwnerPreview() {
  return <ReviewReceivedEmailForOwner ownerName={OWNER_NAME} data={sampleReviewReceived} />;
}

ReviewOwnerPreview.PreviewProps = {
  ownerName: OWNER_NAME,
  data: sampleReviewReceived,
};
