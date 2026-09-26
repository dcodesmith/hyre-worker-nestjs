export type PremblyNinResult = {
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: Date;
  officialPhoto: string | null;
  reference: string;
};

export type PremblyPlateResult = {
  plateNumber: string;
  vehicleName: string;
  chassisNumber: string | null;
  color: string | null;
  reference: string;
};

export type PremblyVinResult = {
  year: number;
  make: string;
  model: string;
  passengerCapacity: number | null;
  reference: string;
};

export type PremblyInsuranceResult = {
  policyNumber: string;
  policyStatus: string;
  plateNumbers: string[];
  chassisNumber: string | null;
  color: string | null;
  expiresAt: Date;
  reference: string;
};

export type PremblyLivenessResult = {
  confidence: number;
  reference: string;
};

export type PremblyFaceComparisonResult = {
  confidence: number;
};

export type PremblyCacDirector = {
  firstName: string;
  middleName: string | null;
  lastName: string;
};

export type PremblyCacResult = {
  businessName: string;
  registrationNumber: string;
  registrationType: string;
  status: string | null;
  directors: PremblyCacDirector[];
  reference: string;
};
