import { ReviewReceivedEmailForChauffeur } from "../emails";
import { sampleReviewReceived } from "./preview-data";

export default function ReviewChauffeurPreview() {
  return <ReviewReceivedEmailForChauffeur chauffeurName="Sam Driver" data={sampleReviewReceived} />;
}

ReviewChauffeurPreview.PreviewProps = {
  chauffeurName: "Sam Driver",
  data: sampleReviewReceived,
};
