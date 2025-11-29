import { ACTIVE_TO_COMPLETED, CONFIRMED_TO_ACTIVE } from "../../config/constants";

type StatusUpdateType = typeof CONFIRMED_TO_ACTIVE | typeof ACTIVE_TO_COMPLETED;

export interface StatusUpdateJobData {
  type: StatusUpdateType;
  timestamp?: string;
}
