/** A Firestore failure whose message never carries request bodies or credentials. */
export class FirestoreError extends Error {
  override name = "FirestoreError";
  constructor(
    message: string,
    /** The canonical gRPC status name from the error body, for example `ABORTED`. */
    readonly status?: string,
    readonly httpStatus?: number,
    readonly retryable = false,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}
/** Transaction contention: the whole transaction is retried. */
export class FirestoreAbortedError extends FirestoreError {
  override name = "FirestoreAbortedError";
}
/** `exists: false` precondition on a document that exists. */
export class FirestoreAlreadyExistsError extends FirestoreError {
  override name = "FirestoreAlreadyExistsError";
}
/** `exists: true` precondition on a missing document. */
export class FirestoreNotFoundError extends FirestoreError {
  override name = "FirestoreNotFoundError";
}
/** `updateTime` precondition mismatch. */
export class FirestorePreconditionError extends FirestoreError {
  override name = "FirestorePreconditionError";
}
export class FirestoreAccessDeniedError extends FirestoreError {
  override name = "FirestoreAccessDeniedError";
}
export class FirestoreThrottledError extends FirestoreError {
  override name = "FirestoreThrottledError";
}
export class FirestoreUnavailableError extends FirestoreError {
  override name = "FirestoreUnavailableError";
}
/** The document would exceed the 1 MiB limit; the client never truncates. */
export class FirestoreDocumentTooLargeError extends RangeError {
  override name = "FirestoreDocumentTooLargeError";
}
/**
 * A query needs a composite index that the database lacks. This is a deployment configuration
 * error: the index list comes from the adapter's `indexes.ts` and is provisioned by Terraform.
 */
export class FirestoreMissingIndexError extends FirestoreError {
  override name = "FirestoreMissingIndexError";
  constructor(
    readonly collection: string,
    /** The index definition the query needs, for example `issues: status ASC, lastSeen DESC, __name__ ASC`. */
    readonly requiredIndex: string,
  ) {
    super(
      `Firestore query requires a composite index that is not deployed (${requiredIndex}); apply the infrastructure generated from the adapter's indexes.ts`,
      "FAILED_PRECONDITION",
      400,
    );
  }
}
