const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "application/pdf":
      return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    default:
      return false;
  }
}
