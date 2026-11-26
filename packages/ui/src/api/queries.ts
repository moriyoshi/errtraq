import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/solid-query";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { token } from "../auth/session";
import { api } from "./instance";
import {
  type Capabilities,
  capabilitiesSchema,
  eventSchema,
  eventsSchema,
  type IssueStatus,
  issueSchema,
  issuesSchema,
  organizationsSchema,
  projectsSchema,
  tagSchema,
  tagsSchema,
  tagValuesSchema,
  whoamiSchema,
} from "./schemas";

export const PAGE_SIZE = 25;

export const keys = {
  whoami: ["whoami"] as const,
  orgs: ["organizations"] as const,
  projects: (org: string) => ["projects", org] as const,
  issues: (
    org: string,
    project: string,
    filter: IssueFilter,
    statsPeriod?: string,
  ) => ["issues", org, project, filter, statsPeriod ?? ""] as const,
  issue: (id: string) => ["issue", id] as const,
  event: (issueId: string, which: string) => ["event", issueId, which] as const,
  events: (issueId: string) => ["events", issueId] as const,
  tags: (issueId: string) => ["tags", issueId] as const,
  tagValues: (issueId: string, key: string) =>
    ["tag-values", issueId, key] as const,
};

export interface IssueFilter {
  status: IssueStatus;
  sort: "date" | "new" | "freq";
  q: string;
}

const enc = encodeURIComponent;

export function useWhoami() {
  return useQuery(() => ({
    queryKey: [...keys.whoami, token()],
    queryFn: ({ signal }) => api.get("/api/0/", whoamiSchema, { signal }),
    staleTime: 5 * 60_000,
  }));
}

const NO_CAPABILITIES: Capabilities = capabilitiesSchema.parse({});

/** What the token may do and what the store can serve, defaulting to the most restrictive. */
export function usePermissions() {
  const whoami = useWhoami();
  return {
    /** Unknown scopes (servers that do not report them) allow the action; the server decides. */
    canWrite: (): boolean => {
      const scopes = whoami.data?.auth?.scopes;
      return scopes === undefined ? true : scopes.includes("event:write");
    },
    capabilities: (): Capabilities => ({
      ...NO_CAPABILITIES,
      ...whoami.data?.errtraq?.capabilities,
    }),
  };
}

export function useOrganizations() {
  return useQuery(() => ({
    queryKey: keys.orgs,
    queryFn: ({ signal }) =>
      api.get("/api/0/organizations/", organizationsSchema, { signal }),
  }));
}

export function useProjects(org: Accessor<string>) {
  return useInfiniteQuery(() => ({
    queryKey: keys.projects(org()),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.page(`/api/0/organizations/${enc(org())}/projects/`, projectsSchema, {
        query: { cursor: pageParam, per_page: 100 },
        signal,
      }),
    getNextPageParam: (last) => last.next,
  }));
}

export function useIssues(
  org: Accessor<string>,
  project: Accessor<string>,
  filter: Accessor<IssueFilter>,
  /** `"24h"` asks for hourly sparkline points; only for stores that report `issueStats`. */
  statsPeriod: Accessor<"24h" | undefined> = () => undefined,
) {
  return useInfiniteQuery(() => ({
    queryKey: keys.issues(org(), project(), filter(), statsPeriod()),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => {
      const f = filter();
      return api.page(
        `/api/0/projects/${enc(org())}/${enc(project())}/issues/`,
        issuesSchema,
        {
          query: {
            query: `is:${f.status}${f.q ? ` ${f.q}` : ""}`,
            sort: f.sort,
            limit: PAGE_SIZE,
            cursor: pageParam,
            statsPeriod: statsPeriod(),
          },
          signal,
        },
      );
    },
    getNextPageParam: (last) => last.next,
  }));
}

export function useIssue(id: Accessor<string>) {
  return useQuery(() => ({
    queryKey: keys.issue(id()),
    queryFn: ({ signal }) =>
      api.get(`/api/0/issues/${enc(id())}/`, issueSchema, { signal }),
  }));
}

/** Tag facets of one issue (top values per allow-listed key). */
export function useTags(issueId: Accessor<string>, enabled: Accessor<boolean>) {
  return useQuery(() => ({
    queryKey: keys.tags(issueId()),
    enabled: enabled(),
    queryFn: ({ signal }) =>
      api.get(`/api/0/issues/${enc(issueId())}/tags/`, tagsSchema, { signal }),
  }));
}

export function useTag(issueId: Accessor<string>, key: Accessor<string>) {
  return useQuery(() => ({
    queryKey: [...keys.tags(issueId()), key()] as const,
    queryFn: ({ signal }) =>
      api.get(
        `/api/0/issues/${enc(issueId())}/tags/${enc(key())}/`,
        tagSchema,
        { signal },
      ),
  }));
}

/** All values of one tag key, paged by cursor. */
export function useTagValues(issueId: Accessor<string>, key: Accessor<string>) {
  return useInfiniteQuery(() => ({
    queryKey: keys.tagValues(issueId(), key()),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.page(
        `/api/0/issues/${enc(issueId())}/tags/${enc(key())}/values/`,
        tagValuesSchema,
        { query: { limit: PAGE_SIZE, cursor: pageParam }, signal },
      ),
    getNextPageParam: (last) => last.next,
  }));
}

/** `which` is an event id, `"latest"` or `"oldest"`. */
export function useEvent(issueId: Accessor<string>, which: Accessor<string>) {
  return useQuery(() => ({
    queryKey: keys.event(issueId(), which()),
    queryFn: ({ signal }) =>
      api.get(
        `/api/0/issues/${enc(issueId())}/events/${enc(which())}/`,
        // Loose: fields this UI does not know stay in the object, so the raw view and the JSON
        // download show what the server sent (entry payloads are never stripped either way).
        eventSchema.loose(),
        { signal },
      ),
  }));
}

export function useEvents(issueId: Accessor<string>) {
  return useInfiniteQuery(() => ({
    queryKey: keys.events(issueId()),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.page(`/api/0/issues/${enc(issueId())}/events/`, eventsSchema, {
        query: { limit: PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.next,
  }));
}

export function updateIssueStatus(id: string, status: IssueStatus) {
  return api.get(`/api/0/issues/${encodeURIComponent(id)}/`, issueSchema, {
    method: "PUT",
    body: { status },
  });
}

/** Flatten the pages of an infinite query. */
export function flatten<T>(
  data: InfiniteData<{ items: T[] }> | undefined,
): T[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

interface Pager {
  hasNextPage: boolean;
  isFetching: boolean;
  isError: boolean;
  fetchNextPage: () => unknown;
  data: unknown;
}

/**
 * Infinite scroll on cursors. Returns a ref for the sentinel element below the list. A page can
 * be short or empty and still carry a next cursor, so the sentinel is re-evaluated after every
 * fetch (the effect depends on `data`), not only when it scrolls into view.
 */
export function createSentinel(query: Pager) {
  const [visible, setVisible] = createSignal(false);
  let observer: IntersectionObserver | undefined;
  createEffect(() => {
    void query.data;
    if (visible() && query.hasNextPage && !query.isFetching && !query.isError)
      void query.fetchNextPage();
  });
  onCleanup(() => observer?.disconnect());
  return (element: HTMLElement) => {
    if (typeof IntersectionObserver === "undefined") return;
    observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: "200px" },
    );
    observer.observe(element);
  };
}

export function invalidateIssues(qc: QueryClient, id?: string) {
  void qc.invalidateQueries({ queryKey: ["issues"] });
  if (id) void qc.invalidateQueries({ queryKey: keys.issue(id) });
}
