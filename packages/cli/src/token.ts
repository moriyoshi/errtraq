import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActiveStore,
  type ApiToken,
  type ApiTokenId,
  generateApiToken,
  hashApiToken,
  type IdGen,
  type OrgId,
  toTimestamp,
} from "@errtraq/core";

/** Dev-only token file: plaintext is protected locally; the store holds only its hash. */
export async function devToken(
  store: ActiveStore,
  ids: IdGen,
  orgId: OrgId,
  directory: string,
  rotate = false,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "api-token");
  let previous: string | undefined;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      previous = (await file.readFile("utf8")).trim();
    } finally {
      await file.close();
    }
    await chmod(path, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const old = previous
    ? await store.projects.getTokenByHash(await hashApiToken(previous))
    : null;
  if (!rotate && previous && old && !old.revokedAt && old.orgId === orgId)
    return previous;
  const token = generateApiToken();
  const record: ApiToken = {
    id: ids.next() as ApiTokenId,
    orgId,
    tokenHash: await hashApiToken(token),
    scopes: ["event:read", "event:write"],
  };
  const temporary = join(directory, `.api-token-${crypto.randomUUID()}`);
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${token}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await store.projects.putToken(record);
    if (old && !old.revokedAt && old.orgId === orgId)
      await store.projects.putToken({
        ...old,
        revokedAt: toTimestamp(new Date()),
      });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return token;
}
