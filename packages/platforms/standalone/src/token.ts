import type { ActiveStore, IdGen, OrgId } from "@errtraq/core";

/** Storage policy supplied by the local runner for a development token. */
export type DevTokenManager = (
  store: ActiveStore,
  ids: IdGen,
  orgId: OrgId,
  directory: string,
  rotate?: boolean,
) => Promise<string>;
