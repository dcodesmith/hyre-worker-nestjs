import { ReviewReceivedEmailForChauffeur } from "../emails";
import { sampleReviewReceived } from "./preview-data";

const CHAUFFEUR_NAME = "Sam Driver";

export default function ReviewChauffeurPreview() {
  return (
    <ReviewReceivedEmailForChauffeur chauffeurName={CHAUFFEUR_NAME} data={sampleReviewReceived} />
  );
}

ReviewChauffeurPreview.PreviewProps = {
  chauffeurName: CHAUFFEUR_NAME,
  data: sampleReviewReceived,
};
