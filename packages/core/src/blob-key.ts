import { BlobInvalidKeyError } from "./errors.js";

/** Portable object keys must survive both S3 and Web URL path handling. */
export function validateBlobKey(key: string): void {
  if (
    !key ||
    new TextEncoder().encode(key).length > 1024 ||
    [...key].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new BlobInvalidKeyError("Invalid blob key");
}
