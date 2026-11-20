import {
  isProjectId,
  type Org,
  type OrgId,
  type Project,
  type ProjectId,
  type ProjectKey,
  type ProjectKeyId,
} from "./domain.js";
import { ConflictError } from "./errors.js";
import { generatePublicKey } from "./ids.js";
import type { ActiveStore, IdGen, KV } from "./ports.js";
/** Allocate decimal project IDs through the atomic KV counter and create an org, project and key. */
export async function bootstrapProject(options: {
  store: ActiveStore;
  kv: KV;
  ids: IdGen;
  orgSlug: string;
  projectSlug: string;
  retentionDays?: number;
}): Promise<{ org: Org; project: Project; key: ProjectKey }> {
  const { store, kv, ids } = options;
  let org = await store.projects.getOrgBySlug(options.orgSlug);
  if (!org) {
    org = {
      id: ids.next() as OrgId,
      slug: options.orgSlug,
      name: options.orgSlug,
    };
    try {
      await store.projects.putOrg(org);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const existing = await store.projects.getOrgBySlug(options.orgSlug);
      if (!existing) throw error;
      org = existing;
    }
  }
  let project = await store.projects.getProjectBySlug(
    org.id,
    options.projectSlug,
  );
  if (!project) {
    let id: string;
    do {
      id = String(await kv.increment("bootstrap:project-id", 1));
    } while (await store.projects.get(id as ProjectId));
    if (!isProjectId(id)) throw new Error("Invalid allocated project ID");
    project = {
      id,
      orgId: org.id,
      slug: options.projectSlug,
      name: options.projectSlug,
      retentionDays: options.retentionDays ?? 30,
    };
    try {
      await store.projects.put(project);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const existing = await store.projects.getProjectBySlug(
        org.id,
        options.projectSlug,
      );
      if (!existing) throw error;
      project = existing;
    }
  }
  let key = (await store.projects.listKeys(project.id)).find(
    (item) => !item.revokedAt,
  );
  if (!key) {
    key = {
      id: ids.next() as ProjectKeyId,
      projectId: project.id,
      publicKey: generatePublicKey(),
    };
    key = await store.projects.getOrCreateActiveKey(key);
  }
  return { org, project, key };
}
