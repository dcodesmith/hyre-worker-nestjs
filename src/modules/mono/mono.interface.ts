export type MonoNinResult = {
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: Date;
  officialPhoto: string | null;
  reference: string;
};

export type MonoDriversLicenseResult = {
  licenseNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: Date;
  expiresAt: Date;
  officialPhoto: string | null;
  reference: string;
};

export type MonoBank = {
  code: string;
  name: string;
  bankCode: string | null;
};

export type MonoBankAccountResult = {
  accountNumber: string;
  accountName: string;
  bankCode: string;
};
