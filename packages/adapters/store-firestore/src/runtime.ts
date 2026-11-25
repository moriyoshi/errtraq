import type {
  ActiveStore,
  CreateContext,
  Logger,
} from "@moriyoshi/errtraq-core";
import { withIdentifierLimits } from "@moriyoshi/errtraq-core/store";
import {
  encodeFields,
  type FirestoreClient,
  FirestoreRestClient,
} from "@moriyoshi/errtraq-firestore-rest";
import { create as createDocument, field } from "./base.js";
import { FirestoreSchemaError } from "./errors.js";
import { eventRepository } from "./events.js";
import { issueRepository } from "./issues.js";
import { metaRepository } from "./meta.js";
import { projectRepository } from "./projects.js";
import { recordEvent, recordEvents } from "./record-event.js";
import { releaseRepository } from "./releases.js";
import { type Config, DATABASE_BINDING } from "./stack.js";

export {
  FirestoreAccessDeniedError,
  FirestoreDocumentTooLargeError,
  FirestoreError,
  FirestoreMissingIndexError,
  FirestoreSchemaError,
  FirestoreThrottledError,
  FirestoreUnavailableError,
} from "./errors.js";

/** The schema version this adapter writes and understands. */
export const SCHEMA_VERSION = 1;
const SCHEMA_PATH = "meta/schema";

export interface FirestoreStoreOptions {
  client: FirestoreClient;
  logger?: Logger;
}
/**
 * Firestore active store. The layout, transactions and index requirements are documented in
 * GCP_PLAN.md section 3; indexes come from `indexes.ts` through Terraform.
 */
export class FirestoreStore implements ActiveStore {
  readonly capabilities = {
    textSearch: false,
    lastSeenRangeOnOtherSort: false,
    recordEvents: true,
  };
  recordEvent: ActiveStore["recordEvent"];
  recordEvents: ActiveStore["recordEvents"];
  projects: ActiveStore["projects"];
  issues: ActiveStore["issues"];
  events: ActiveStore["events"];
  releases: ActiveStore["releases"];
  meta: ActiveStore["meta"];
  constructor(private readonly options: FirestoreStoreOptions) {
    const client = options.client;
    this.recordEvent = recordEvent(client);
    this.recordEvents = recordEvents(client);
    this.projects = projectRepository(client);
    this.issues = issueRepository(client);
    this.events = eventRepository(client);
    this.releases = releaseRepository(client);
    this.meta = metaRepository(client);
    // biome-ignore lint/correctness/noConstructorReturn: the guard proxy is the store every caller receives
    return withIdentifierLimits(this);
  }
  get client(): FirestoreClient {
    return this.options.client;
  }
  async migrate(): Promise<void> {
    await this.client.runTransaction(async (tx) => {
      const doc = await tx.get(SCHEMA_PATH);
      if (!doc) {
        await tx.commit([
          createDocument(
            SCHEMA_PATH,
            encodeFields({ schemaVersion: SCHEMA_VERSION }),
          ),
        ]);
        return;
      }
      if (field(doc, "schemaVersion") !== SCHEMA_VERSION)
        throw new FirestoreSchemaError(
          "Firestore store schema version is not supported by this adapter",
        );
    });
  }
}

/** `host:port` from the standard emulator variable, or an explicit origin. */
export function resolveEndpoint(
  config: Pick<Config, "emulatorEndpoint">,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (config.emulatorEndpoint) return new URL(config.emulatorEndpoint).origin;
  const host = environment.FIRESTORE_EMULATOR_HOST;
  return host ? `http://${host}` : undefined;
}

export function create({
  config,
  bindings,
  environment = {},
  logger,
}: CreateContext<Config>): FirestoreStore {
  const database = bindings[DATABASE_BINDING] ?? config.databaseId;
  if (typeof database !== "string" || !database)
    throw new Error("Missing Firestore database binding");
  const endpoint = resolveEndpoint(config, environment);
  const accessToken = bindings.accessToken;
  // TODO(G5): the platform wiring injects the gcp-auth token source as `accessToken`.
  if (!endpoint && typeof accessToken !== "function")
    throw new Error("Missing Firestore access token source");
  return new FirestoreStore({
    client: new FirestoreRestClient({
      projectId: config.projectId,
      databaseId: database,
      ...(endpoint ? { endpoint } : {}),
      ...(typeof accessToken === "function"
        ? { accessToken: accessToken as () => Promise<string> }
        : {}),
      ...(config.requestTimeoutMs
        ? { requestTimeoutMs: config.requestTimeoutMs }
        : {}),
      ...(config.transactionTimeoutMs
        ? { transactionTimeoutMs: config.transactionTimeoutMs }
        : {}),
    }),
    logger,
  });
}
