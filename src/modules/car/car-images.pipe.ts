import { Injectable, type PipeTransform } from "@nestjs/common";
import type { UploadedCarFile } from "./car.interface";
import { validateCarImages } from "./car-create-files.pipe";

@Injectable()
export class CarImagesPipe
  implements PipeTransform<UploadedCarFile[] | undefined, UploadedCarFile[]>
{
  transform(files: UploadedCarFile[] | undefined): UploadedCarFile[] {
    const images = files ?? [];
    validateCarImages(images);
    return images;
  }
}
