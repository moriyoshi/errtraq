import {
  bootstrapProject,
  DEFAULT_PROJECT_RETENTION_DAYS,
} from "./bootstrap.js";
import {
  type ApiTokenId,
  type ProjectRateLimits,
  toTimestamp,
} from "./domain.js";
import { ConflictError } from "./errors.js";
import { generateApiToken, hashApiToken, WebCryptoIdGen } from "./ids.js";
import type { ActiveStore, KV, Logger } from "./ports.js";
import type { RateRejectionConfig } from "./rate-rejection.js";
import type { StackConfig } from "./stack-model.js";

/** The vault's create-or-read operation returns the same value to concurrent callers. */
export interface BootstrapVault {
  claim(
    name: string,
    candidate: string,
  ): Promise<{ identifier: string; value: string; created?: boolean }>;
}
export interface BootstrapOptions {
  stackName: string;
  store: ActiveStore;
  kv: KV;
  vault: BootstrapVault;
  secretName: string;
  ingestUrl: string;
  orgSlug: string;
  projectSlug: string;
  /** Retention of a newly created project, in days. */
  retentionDays?: number;
  /** Rejects a new or existing project with a longer retention. */
  maxRetentionDays?: number;
  /** Per-project rate limit overrides for a new project, validated against `rateRejection`. */
  rateLimits?: ProjectRateLimits;
  rateRejection?: RateRejectionConfig;
}
/** What a bootstrap run did; ids, slugs and flags only, never the DSN or token. */
export interface BootstrapOutcome {
  secretId: string;
  secretCreated: boolean;
  org: { id: string; slug: string; created: boolean };
  project: {
    id: string;
    slug: string;
    retentionDays: number;
    created: boolean;
  };
  key: { created: boolean };
  token: { id: string; created: boolean };
}
export async function bootstrapDeployed(
  options: BootstrapOptions,
): Promise<string> {
  return (await bootstrapDeployedDetailed(options)).secretId;
}
export async function bootstrapDeployedDetailed(
  options: BootstrapOptions,
): Promise<BootstrapOutcome> {
  const url = new URL(options.ingestUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Ingest URL must be an HTTPS origin");
  if (!/^[A-Za-z0-9/_+=.@-]{1,512}$/.test(options.secretName))
    throw new Error("Invalid bootstrap secret name");
  await options.store.migrate();
  const created = await bootstrapProject({
    store: options.store,
    kv: options.kv,
    ids: new WebCryptoIdGen(),
    orgSlug: options.orgSlug,
    projectSlug: options.projectSlug,
    retentionDays: options.retentionDays,
    maxRetentionDays: options.maxRetentionDays,
    rateLimits: options.rateLimits,
    rateRejection: options.rateRejection,
  });
  const dsn = new URL(url);
  dsn.username = created.key.publicKey;
  dsn.pathname = `/${created.project.id}`;
  const token = generateApiToken();
  const identity = {
    version: 1,
    stack: options.stackName,
    orgId: created.org.id,
    projectId: created.project.id,
    dsn: dsn.toString(),
  };
  const result = await options.vault.claim(
    options.secretName,
    JSON.stringify({ ...identity, token }),
  );
  let saved: unknown;
  try {
    saved = JSON.parse(result.value);
  } catch {
    throw new Error("Bootstrap secret has an invalid format");
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw new Error("Bootstrap secret has an invalid format");
  const obj = saved as Record<string, unknown>;
  if (
    Object.entries(identity).some(([key, value]) => obj[key] !== value) ||
    typeof obj.token !== "string" ||
    !/^errtraq_[a-f0-9]{64}$/.test(obj.token)
  )
    throw new Error("Bootstrap secret does not match this deployment");
  const outcome = (tokenCreated: boolean): BootstrapOutcome => ({
    secretId: result.identifier,
    secretCreated: result.created === true,
    org: {
      id: created.org.id,
      slug: created.org.slug,
      created: created.created.org,
    },
    project: {
      id: created.project.id,
      slug: created.project.slug,
      retentionDays: created.project.retentionDays,
      created: created.created.project,
    },
    key: { created: created.created.key },
    token: { id: record.id, created: tokenCreated },
  });
  const hash = await hashApiToken(obj.token);
  const record = {
    id: hash.slice(0, 32) as ApiTokenId,
    orgId: created.org.id,
    tokenHash: hash,
    scopes: ["event:read", "event:write"],
    label: "bootstrap",
    createdAt: toTimestamp(new Date()),
  };
  const existing = await options.store.projects.getTokenByHash(hash);
  const matches = (value: typeof existing) =>
    !!value &&
    value.id === record.id &&
    value.orgId === record.orgId &&
    !value.revokedAt &&
    value.scopes.length === record.scopes.length &&
    record.scopes.every((scope) => value.scopes.includes(scope));
  if (existing) {
    if (!matches(existing))
      throw new ConflictError("Bootstrap token is revoked or has changed");
    // A token registered before token management has no createdAt and no org index
    // entry; rewriting it here is the idempotent backfill that makes it listable.
    // Re-read first so a revocation that just landed is never overwritten.
    if (!existing.createdAt) {
      const fresh = await options.store.projects.getTokenByHash(hash);
      if (matches(fresh) && fresh && !fresh.createdAt)
        await options.store.projects.putToken({
          ...fresh,
          label: fresh.label ?? record.label,
          createdAt: record.createdAt,
        });
    }
    return outcome(false);
  }
  const registered = await options.store.projects.createToken(record);
  if (!registered) {
    const current = await options.store.projects.getTokenByHash(hash);
    if (!matches(current))
      throw new ConflictError("Bootstrap token is revoked or has changed");
  }
  return outcome(registered);
}

/** Version of the remote bootstrap request and response documents. */
export const REMOTE_BOOTSTRAP_VERSION = 1;
/**
 * The only inputs a deployed bootstrap function accepts: all non-secret. The secret name,
 * retention policy and rate rejection limits come from the deployed function, never the caller.
 */
export interface RemoteBootstrapRequest {
  version: typeof REMOTE_BOOTSTRAP_VERSION;
  orgSlug: string;
  projectSlug: string;
  ingestUrl: string;
  rateLimits?: ProjectRateLimits;
}
export type RemoteBootstrapResponse =
  | ({ ok: true; version: typeof REMOTE_BOOTSTRAP_VERSION } & Omit<
      BootstrapOutcome,
      "secretId" | "secretCreated"
    > & { secret: { arn: string; created: boolean } })
  | {
      ok: false;
      version: typeof REMOTE_BOOTSTRAP_VERSION;
      error: { code: string; message: string };
    };
/** Raised for a request the function refuses; the message is written here, never provider text. */
export class RemoteBootstrapRequestError extends Error {
  override name = "RemoteBootstrapRequestError";
}
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RemoteBootstrapRequestError(`${what} must be an object`);
  return value as Record<string, unknown>;
}
function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  // Names only, never values: a misplaced secret must not be echoed back.
  if (extra.length)
    throw new RemoteBootstrapRequestError(
      `${what} has unsupported fields: ${extra.map((key) => JSON.stringify(key.slice(0, 40))).join(", ")}`,
    );
}
/** Validate an untrusted payload; unknown fields are refused so no secret can be passed in. */
export function parseRemoteBootstrapRequest(
  input: unknown,
): RemoteBootstrapRequest {
  const value = plainObject(input, "Bootstrap request");
  rejectUnknown(
    value,
    ["version", "orgSlug", "projectSlug", "ingestUrl", "rateLimits"],
    "Bootstrap request",
  );
  if (value.version !== REMOTE_BOOTSTRAP_VERSION)
    throw new RemoteBootstrapRequestError(
      `Unsupported bootstrap request version; expected ${REMOTE_BOOTSTRAP_VERSION}`,
    );
  for (const field of ["orgSlug", "projectSlug"] as const) {
    const slug = value[field];
    if (typeof slug !== "string" || !SLUG.test(slug))
      throw new RemoteBootstrapRequestError(
        `${field} must be 1-128 letters, digits, dots, underscores or hyphens`,
      );
  }
  if (typeof value.ingestUrl !== "string" || value.ingestUrl.length > 2048)
    throw new RemoteBootstrapRequestError("ingestUrl must be an HTTPS origin");
  let rateLimits: ProjectRateLimits | undefined;
  if (value.rateLimits !== undefined) {
    const limits = plainObject(value.rateLimits, "rateLimits");
    rejectUnknown(limits, ["issueEvents", "newIssues"], "rateLimits");
    rateLimits = {};
    for (const key of ["issueEvents", "newIssues"] as const) {
      const count = limits[key];
      if (count === undefined) continue;
      if (!Number.isSafeInteger(count) || (count as number) < 1)
        throw new RemoteBootstrapRequestError(
          `rateLimits.${key} must be a positive integer`,
        );
      rateLimits[key] = count as number;
    }
  }
  return {
    version: REMOTE_BOOTSTRAP_VERSION,
    orgSlug: value.orgSlug as string,
    projectSlug: value.projectSlug as string,
    ingestUrl: value.ingestUrl,
    ...(rateLimits ? { rateLimits } : {}),
  };
}
/** The stack's own bootstrap text; any other failure is reported by class only. */
const OWN_MESSAGES = [
  "Ingest URL must be an HTTPS origin",
  "Project retention of ",
  "Project already exists with different rate limits",
  "Project issue event limit ",
  "Project new issue limit ",
  "The stack does not enable a ",
  "Bootstrap token is revoked or has changed",
  "Bootstrap secret does not match this deployment",
  "Bootstrap secret has an invalid format",
  "Unable to create bootstrap secret",
  "Unable to read bootstrap secret",
];
function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof RemoteBootstrapRequestError)
    return { code: "InvalidRequest", message: error.message };
  if (error instanceof Error) {
    if (
      (error instanceof RangeError ||
        error instanceof ConflictError ||
        error.constructor === Error) &&
      OWN_MESSAGES.some((prefix) => error.message.startsWith(prefix))
    )
      return {
        code: error instanceof ConflictError ? "Conflict" : "Rejected",
        message: error.message,
      };
  }
  return {
    code: "BootstrapFailed",
    message:
      "Bootstrap failed; the function log names the error class (no details are returned)",
  };
}
/** Class name and a short machine code only: provider messages can carry connection details. */
function errorFields(error: unknown): Record<string, string> {
  const fields: Record<string, string> = {
    errorName: error instanceof Error ? error.name.slice(0, 64) : "unknown",
  };
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(code))
    fields.errorCode = code;
  return fields;
}
export interface RemoteBootstrapOptions {
  stackName: string;
  store: ActiveStore;
  kv: KV;
  vault: BootstrapVault;
  /** Fixed by the deployment; the request cannot choose it. */
  secretName: string;
  maxRetentionDays?: number;
  retentionDays?: number;
  rateRejection?: RateRejectionConfig;
  logger?: Pick<Logger, "info" | "error">;
}
/**
 * Run the idempotent bootstrap for an untrusted request and return a non-secret summary.
 * Never throws for a failed bootstrap: it returns a scrubbed error document instead, so the
 * invoker sees a reason without a provider message that could include a connection detail.
 */
export async function runRemoteBootstrap(
  request: unknown,
  options: RemoteBootstrapOptions,
): Promise<RemoteBootstrapResponse> {
  try {
    const parsed = parseRemoteBootstrapRequest(request);
    const outcome = await bootstrapDeployedDetailed({
      stackName: options.stackName,
      store: options.store,
      kv: options.kv,
      vault: options.vault,
      secretName: options.secretName,
      ingestUrl: parsed.ingestUrl,
      orgSlug: parsed.orgSlug,
      projectSlug: parsed.projectSlug,
      retentionDays: options.retentionDays,
      maxRetentionDays: options.maxRetentionDays,
      rateRejection: options.rateRejection,
      ...(parsed.rateLimits ? { rateLimits: parsed.rateLimits } : {}),
    });
    options.logger?.info("Remote bootstrap complete", {
      orgCreated: outcome.org.created,
      projectCreated: outcome.project.created,
      keyCreated: outcome.key.created,
      tokenCreated: outcome.token.created,
      secretCreated: outcome.secretCreated,
    });
    const { secretId, secretCreated, ...summary } = outcome;
    return {
      ok: true,
      version: REMOTE_BOOTSTRAP_VERSION,
      ...summary,
      secret: { arn: secretId, created: secretCreated },
    };
  } catch (error) {
    options.logger?.error("Remote bootstrap failed", errorFields(error));
    return {
      ok: false,
      version: REMOTE_BOOTSTRAP_VERSION,
      error: describeFailure(error),
    };
  }
}
/** Longest project retention a bootstrap may use and the default new projects get. */
export function bootstrapRetentionPolicy(stack: Pick<StackConfig, "blob">): {
  retentionDays?: number;
  maxRetentionDays?: number;
} {
  // blob-s3 expires orphaned overflow payloads after the configured longest retention plus a
  // margin, so no bootstrapped project may keep events longer than that.
  const blobConfig = (stack.blob.config ?? {}) as {
    maxEventRetentionDays?: number;
  };
  if (stack.blob.manifest.id !== "blob-s3") return {};
  const maxRetentionDays =
    blobConfig.maxEventRetentionDays ?? DEFAULT_PROJECT_RETENTION_DAYS;
  return {
    retentionDays: Math.min(DEFAULT_PROJECT_RETENTION_DAYS, maxRetentionDays),
    maxRetentionDays,
  };
}
