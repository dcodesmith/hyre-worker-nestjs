import { Injectable, type PipeTransform } from "@nestjs/common";
import type { CarDocumentFiles, CarUploadFields } from "./car.interface";
import { validateCarCertificate } from "./car-create-files.pipe";

@Injectable()
export class CarDocumentsPipe implements PipeTransform<CarUploadFields, CarDocumentFiles> {
  transform(files: CarUploadFields): CarDocumentFiles {
    const motCertificate = files.motCertificate?.[0];
    const insuranceCertificate = files.insuranceCertificate?.[0];

    validateCarCertificate(motCertificate, "MOT");
    validateCarCertificate(insuranceCertificate, "Insurance");

    return { motCertificate, insuranceCertificate };
  }
}
