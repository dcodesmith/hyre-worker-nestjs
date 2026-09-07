export interface UploadedCarFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface CarUploadFields {
  images?: UploadedCarFile[];
  motCertificate?: UploadedCarFile[];
  insuranceCertificate?: UploadedCarFile[];
}

export interface CarDocumentFiles {
  motCertificate: UploadedCarFile;
  insuranceCertificate: UploadedCarFile;
}
