import { bootstrapProject } from "./bootstrap.js";
import { type ApiTokenId, toTimestamp } from "./domain.js";
import { ConflictError } from "./errors.js";
import { generateApiToken, hashApiToken, WebCryptoIdGen } from "./ids.js";
import type { ActiveStore, KV } from "./ports.js";

/** The vault's create-or-read operation returns the same value to concurrent callers. */
export interface BootstrapVault {
  claim(
    name: string,
    candidate: string,
  ): Promise<{ identifier: string; value: string }>;
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
}
export async function bootstrapDeployed(
  options: BootstrapOptions,
): Promise<string> {
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
    return result.identifier;
  }
  if (!(await options.store.projects.createToken(record))) {
    const current = await options.store.projects.getTokenByHash(hash);
    if (!matches(current))
      throw new ConflictError("Bootstrap token is revoked or has changed");
  }
  return result.identifier;
}
