export type SmileIdErrorKind = "INVALID_RESPONSE" | "UNAVAILABLE";

export type SmileIdComparisonImageType = "DOCUMENT" | "ID_PHOTO" | "PORTRAIT";

export type CompareSelfieToImageInput = {
  readonly selfie: Buffer;
  readonly comparisonImage: Buffer;
  readonly comparisonImageType: SmileIdComparisonImageType;
  readonly consent: {
    readonly grantedAt: Date;
    readonly noticeLanguage: string;
    readonly privacyPolicyUrl: string;
  };
  readonly user: {
    readonly givenNames: string;
    readonly lastName: string;
    readonly email?: string;
    readonly phoneNumber?: string;
  };
  readonly callbackUrl?: string;
  readonly partnerParams?: Readonly<Record<string, string>>;
};

export type CompareSelfieToImageResult = {
  readonly jobId: string;
  readonly createdAt: string | null;
};
