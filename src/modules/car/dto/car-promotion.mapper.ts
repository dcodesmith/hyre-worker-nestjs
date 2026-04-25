import type { ActivePromotion } from "../../promotion/promotion.interface";
import type { CarPromotionDto } from "./car-promotion.dto";

export function mapActivePromotionToCarPromotionDto(
  promotion: ActivePromotion | null,
): CarPromotionDto | null {
  if (!promotion) {
    return null;
  }

  return {
    id: promotion.id,
    name: promotion.name,
    discountValue: Number(promotion.discountValue.toString()),
  };
}
