export {
  FirestoreAccessDeniedError,
  FirestoreDocumentTooLargeError,
  FirestoreError,
  FirestoreMissingIndexError,
  FirestoreThrottledError,
  FirestoreUnavailableError,
} from "@moriyoshi/errtraq-firestore-rest";

/** The database was initialised by an incompatible adapter version. */
export class FirestoreSchemaError extends Error {
  override name = "FirestoreSchemaError";
}
