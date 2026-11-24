import {
  type ActiveStore,
  type ApiTokenId,
  type ApiTokenSummary,
  NotFoundError,
  type OrgId,
  type StackConfig,
  toTimestamp,
} from "@moriyoshi/errtraq-core";
import {
  type DeployedDependencies,
  openDeployedStack,
} from "./deployed-bootstrap.js";

async function organization(store: ActiveStore, slug: string): Promise<OrgId> {
  const org = await store.projects.getOrgBySlug(slug);
  if (!org) throw new NotFoundError(`Organization "${slug}" does not exist`);
  return org.id;
}
async function allTokens(
  store: ActiveStore,
  orgId: OrgId,
): Promise<ApiTokenSummary[]> {
  const tokens: ApiTokenSummary[] = [];
  let cursor: Parameters<ActiveStore["projects"]["listTokens"]>[1];
  do {
    const page = await store.projects.listTokens(orgId, cursor, 100);
    tokens.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return tokens;
}
/** Token metadata only: never the hash, never plaintext (which is not retained). */
export async function listTokens(
  store: ActiveStore,
  orgSlug: string,
): Promise<ApiTokenSummary[]> {
  return allTokens(store, await organization(store, orgSlug));
}
/**
 * Revoke one token. The operator has no "current request", so the guard is about the last
 * active token: revoking it would lock every API client out, so it needs `force`.
 * Revoking an already revoked token succeeds and changes nothing.
 */
export async function revokeToken(
  store: ActiveStore,
  options: { orgSlug: string; id: string; force?: boolean },
  now: () => Date = () => new Date(),
): Promise<ApiTokenSummary> {
  const orgId = await organization(store, options.orgSlug);
  const tokens = await allTokens(store, orgId);
  const target = tokens.find((token) => token.id === options.id);
  // A token that predates the org index is not listed but can still be revoked by ID.
  if (target?.revokedAt === undefined && !options.force) {
    const others = tokens.filter(
      (token) => token.id !== options.id && !token.revokedAt,
    );
    if (others.length === 0)
      throw new Error(
        "Refusing to revoke the last active API token; pass --force to lock out all API clients",
      );
  }
  const revoked = await store.projects.revokeToken(
    orgId,
    options.id as ApiTokenId,
    toTimestamp(now()),
  );
  if (!revoked) throw new NotFoundError(`Token "${options.id}" does not exist`);
  return revoked;
}
export function formatTokens(tokens: readonly ApiTokenSummary[]): string {
  if (!tokens.length) return "No API tokens";
  return tokens
    .map((token) =>
      [
        token.id,
        token.revokedAt ? `revoked ${token.revokedAt}` : "active",
        token.label ?? "-",
        token.scopes.join(",") || "-",
        token.createdAt ? `created ${token.createdAt}` : "created unknown",
      ].join("\t"),
    )
    .join("\n");
}
export async function withDeployedStore<T>(
  stack: StackConfig,
  environment: Readonly<Record<string, string | undefined>>,
  action: (store: ActiveStore) => Promise<T>,
  dependencies?: Pick<DeployedDependencies, "loadModule" | "secretSource">,
): Promise<T> {
  const opened = await openDeployedStack(stack, environment, dependencies);
  try {
    return await action(opened.store);
  } finally {
    await opened.close();
  }
}
