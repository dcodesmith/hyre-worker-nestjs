import type { IncomingHttpHeaders } from "node:http";
import { CLIENT_TYPE_HEADER, MOBILE } from "../auth/auth.const";
import type { AnalyticsChannelValue } from "./analytics.interface";
import { AnalyticsChannel } from "./analytics-event.schema";

export function resolveHttpAnalyticsChannel(
  headers: IncomingHttpHeaders | undefined,
): AnalyticsChannelValue {
  return headers?.[CLIENT_TYPE_HEADER] === MOBILE
    ? AnalyticsChannel.MOBILE_APP
    : AnalyticsChannel.WEB;
}
