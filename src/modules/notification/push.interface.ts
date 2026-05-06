export interface SendPushNotificationsInput {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface SendPushNotificationsResult {
  sent: number;
  /**
   * Retryable failures only (invalid/unregistered tokens are excluded).
   */
  failed: number;
  invalidTokens: string[];
  errors?: PushDeliveryError[];
}

export interface PushDeliveryError {
  code: string;
  retryable: boolean;
  token?: string;
  message?: string;
}
