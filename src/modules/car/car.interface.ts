export interface UploadedCarFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface CarUploadFields {
  images?: UploadedCarFile[];
  vehicleRegistration?: UploadedCarFile[];
  motCertificate?: UploadedCarFile[];
  insuranceCertificate?: UploadedCarFile[];
}

export interface CarDocumentFiles {
  vehicleRegistration: UploadedCarFile;
  motCertificate: UploadedCarFile;
  insuranceCertificate: UploadedCarFile;
}
