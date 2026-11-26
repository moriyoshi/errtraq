import { useInfiniteQuery, useQuery } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { z } from "zod";
import { api } from "./instance";
import { PAGE_SIZE } from "./queries";
import { projectSchema } from "./schemas";

/** Release, deploy, artifact bundle, project and DSN key shapes (lenient, like `schemas.ts`). */
const optionalString = z.string().nullish();

export const deploySchema = z.object({
  id: z.string(),
  environment: z.string(),
  name: optionalString,
  url: optionalString,
  dateStarted: optionalString,
  dateFinished: optionalString,
});
export type Deploy = z.infer<typeof deploySchema>;

export const releaseSchema = z.object({
  version: z.string(),
  shortVersion: optionalString,
  dateCreated: optionalString,
  dateReleased: optionalString,
  /** Always 0 on errtraq (no per-release issue attribution); kept for Sentry and GlitchTip. */
  newGroups: z.number().nullish(),
  deployCount: z.number().nullish(),
  lastDeploy: deploySchema.nullish(),
  projects: z
    .array(z.object({ id: z.string(), slug: z.string(), name: z.string() }))
    .default([]),
});
export type Release = z.infer<typeof releaseSchema>;

export const bundleSchema = z.object({
  bundleId: z.string(),
  fileCount: z.number().nullish(),
  date: optionalString,
  errtraq: z.object({ debugIdCount: z.number().optional() }).optional(),
});
export type Bundle = z.infer<typeof bundleSchema>;

export const keySchema = z.object({
  id: z.string(),
  name: optionalString,
  public: optionalString,
  isActive: z.boolean().default(true),
  dsn: z.object({ public: optionalString }).nullish(),
});
export type ProjectKey = z.infer<typeof keySchema>;

export const projectDetailSchema = projectSchema.extend({
  errtraq: z
    .object({
      retentionDays: z.number().optional(),
      rateLimits: z
        .object({
          issueEvents: z.number().optional(),
          newIssues: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

const enc = encodeURIComponent;
const base = (org: string, project: string) =>
  `/api/0/projects/${enc(org)}/${enc(project)}`;

export const projectKeys = {
  releases: (org: string, project: string) =>
    ["releases", org, project] as const,
  release: (org: string, project: string, version: string) =>
    ["release", org, project, version] as const,
  deploys: (org: string, project: string, version: string) =>
    ["deploys", org, project, version] as const,
  bundles: (org: string, project: string, version: string) =>
    ["bundles", org, project, version] as const,
  project: (org: string, project: string) => ["project", org, project] as const,
  dsnKeys: (org: string, project: string) =>
    ["dsn-keys", org, project] as const,
};

export function useReleases(org: Accessor<string>, project: Accessor<string>) {
  return useInfiniteQuery(() => ({
    queryKey: projectKeys.releases(org(), project()),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.page(`${base(org(), project())}/releases/`, z.array(releaseSchema), {
        query: { per_page: PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.next,
  }));
}

export function useRelease(
  org: Accessor<string>,
  project: Accessor<string>,
  version: Accessor<string>,
) {
  return useQuery(() => ({
    queryKey: projectKeys.release(org(), project(), version()),
    queryFn: ({ signal }) =>
      api.get(
        `${base(org(), project())}/releases/${enc(version())}/`,
        releaseSchema,
        { signal },
      ),
  }));
}

export function useDeploys(
  org: Accessor<string>,
  project: Accessor<string>,
  version: Accessor<string>,
) {
  return useQuery(() => ({
    queryKey: projectKeys.deploys(org(), project(), version()),
    queryFn: ({ signal }) =>
      api.get(
        `${base(org(), project())}/releases/${enc(version())}/deploys/`,
        z.array(deploySchema),
        { signal },
      ),
  }));
}

/** Artifact bundles of one release; servers without the route answer 404 or 400. */
export function useBundles(
  org: Accessor<string>,
  project: Accessor<string>,
  version: Accessor<string>,
) {
  return useInfiniteQuery(() => ({
    queryKey: projectKeys.bundles(org(), project(), version()),
    initialPageParam: "",
    retry: false,
    queryFn: ({ pageParam, signal }) =>
      api.page(
        `${base(org(), project())}/artifact-bundles/`,
        z.array(bundleSchema),
        {
          query: { query: version(), per_page: PAGE_SIZE, cursor: pageParam },
          signal,
        },
      ),
    getNextPageParam: (last) => last.next,
  }));
}

export function useProject(org: Accessor<string>, project: Accessor<string>) {
  return useQuery(() => ({
    queryKey: projectKeys.project(org(), project()),
    queryFn: ({ signal }) =>
      api.get(`${base(org(), project())}/`, projectDetailSchema, { signal }),
  }));
}

export function useDsnKeys(org: Accessor<string>, project: Accessor<string>) {
  return useQuery(() => ({
    queryKey: projectKeys.dsnKeys(org(), project()),
    queryFn: ({ signal }) =>
      api.get(`${base(org(), project())}/keys/`, z.array(keySchema), {
        signal,
      }),
  }));
}
