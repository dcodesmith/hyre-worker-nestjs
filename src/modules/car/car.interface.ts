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

export interface CarCreateFiles {
  images: UploadedCarFile[];
  motCertificate: UploadedCarFile;
  insuranceCertificate: UploadedCarFile;
}

export interface UploadedFiles {
  imageUrls: string[];
  motCertificateUrl: string;
  insuranceCertificateUrl: string;
  uploadedKeys: string[];
}
