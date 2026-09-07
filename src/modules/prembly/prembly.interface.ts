export type PremblyPlateResult = {
  plateNumber: string;
  chassisNumber: string;
  make: string | null;
  model: string | null;
  color: string | null;
  reference: string;
};

export type PremblyVinResult = {
  year: number;
  make: string;
  model: string;
  passengerCapacity: number;
  reference: string;
};

export type PremblyInsuranceResult = {
  policyNumber: string;
  policyStatus: string;
  plateNumbers: string[];
  chassisNumber: string | null;
  expiresAt: Date;
  reference: string;
};
