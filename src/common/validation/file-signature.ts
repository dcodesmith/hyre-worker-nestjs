const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF_SIGNATURE = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const WEBP_SIGNATURE = Buffer.from([0x57, 0x45, 0x42, 0x50]);
const PDF_SIGNATURE = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/**
 * Verifies the leading magic bytes of an uploaded file match its declared MIME type.
 */
export function hasValidFileSignature(buffer: Buffer | undefined, mimetype: string): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }

  switch (mimetype) {
    case "image/jpeg":
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
    case "image/webp":
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).equals(RIFF_SIGNATURE) &&
        buffer.subarray(8, 12).equals(WEBP_SIGNATURE)
      );
    case "application/pdf":
      return buffer.length >= 5 && buffer.subarray(0, 5).equals(PDF_SIGNATURE);
    default:
      return false;
  }
}
