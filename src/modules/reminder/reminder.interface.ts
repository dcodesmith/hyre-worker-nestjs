import { TRIP_END, TRIP_START } from "../../config/constants";

type ReminderType = typeof TRIP_START | typeof TRIP_END;

export interface ReminderJobData {
  type: ReminderType;
  timestamp: string;
}
