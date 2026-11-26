import { useMutation, useQueryClient } from "@tanstack/solid-query";
import {
  createRoute,
  Link,
  Outlet,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";
import { createSignal, For, Show } from "solid-js";
import {
  createSentinel,
  flatten,
  invalidateIssues,
  keys,
  updateIssueStatus,
  useEvent,
  useEvents,
  useIssue,
  usePermissions,
  useTag,
  useTags,
  useTagValues,
} from "../api/queries";
import type { Issue, IssueStatus } from "../api/schemas";
import { IssueHistogram } from "../components/Charts";
import { ErrorNotice, Level, Loading, Time } from "../components/common";
import { EventView } from "../components/EventView";
import { TagsPanel } from "../components/TagsPanel";
import { percentLabel } from "../lib/series";
import { useShortcuts } from "../lib/use-shortcuts";
import { authedRoute } from "./root";

const ACTIONS: Record<string, { label: string; to: IssueStatus }[]> = {
  unresolved: [
    { label: "Resolve", to: "resolved" },
    { label: "Ignore", to: "ignored" },
  ],
  resolved: [{ label: "Unresolve", to: "unresolved" }],
  ignored: [{ label: "Unresolve", to: "unresolved" }],
};

function IssueHeader(props: { issue: Issue; org: string; project: string }) {
  const qc = useQueryClient();
  const permissions = usePermissions();
  const [failure, setFailure] = createSignal<string | null>(null);
  const mutation = useMutation(() => ({
    mutationFn: (status: IssueStatus) =>
      updateIssueStatus(props.issue.id, status),
    // Optimistic: show the new status at once, restore the snapshot if the server refuses.
    onMutate: async (status: IssueStatus) => {
      setFailure(null);
      const key = keys.issue(props.issue.id);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Issue>(key);
      qc.setQueryData<Issue>(key, (old) => (old ? { ...old, status } : old));
      return { previous };
    },
    onError: (error: Error, _status, context) => {
      if (context?.previous)
        qc.setQueryData(keys.issue(props.issue.id), context.previous);
      setFailure(`Could not update the issue: ${error.message}`);
    },
    onSettled: () => invalidateIssues(qc, props.issue.id),
  }));
  // r / i / u act on this issue, limited to the transitions its buttons offer.
  useShortcuts((shortcut) => {
    const to: IssueStatus | undefined =
      shortcut === "resolve"
        ? "resolved"
        : shortcut === "ignore"
          ? "ignored"
          : shortcut === "unresolve"
            ? "unresolved"
            : undefined;
    if (!to || !permissions.canWrite() || mutation.isPending) return false;
    if (!(ACTIONS[props.issue.status] ?? []).some((a) => a.to === to))
      return false;
    mutation.mutate(to);
    return true;
  });
  return (
    <header class="issue-head">
      <nav class="crumbs">
        <Link to="/organizations">Organizations</Link>
        <Link to="/organizations/$org/projects" params={{ org: props.org }}>
          {props.org}
        </Link>
        <Link
          to="/$org/$project/issues"
          params={{ org: props.org, project: props.project }}
        >
          {props.project}
        </Link>
        <span>Issue</span>
      </nav>
      <h1 class="issue-title-full">{props.issue.title}</h1>
      <p class="muted">{props.issue.culprit ?? ""}</p>
      <div class="issue-facts">
        <Level level={props.issue.level} />
        <span class="status" data-status={props.issue.status}>
          {props.issue.status}
        </span>
        <span>{props.issue.count} events</span>
        <span class="muted">
          first <Time value={props.issue.firstSeen} />, last{" "}
          <Time value={props.issue.lastSeen} />
        </span>
        <Show when={permissions.canWrite()}>
          <span class="actions">
            <For each={ACTIONS[props.issue.status] ?? []}>
              {(action) => (
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(action.to)}
                >
                  {action.label}
                </button>
              )}
            </For>
          </span>
        </Show>
      </div>
      <Show when={failure()}>
        <p class="notice error" role="alert">
          {failure()}
        </p>
      </Show>
    </header>
  );
}

/** The histogram and tag facets, each shown only when the store serves them. */
function IssueOverview(props: { issue: Issue; org: string; project: string }) {
  const permissions = usePermissions();
  const tags = useTags(
    () => props.issue.id,
    () => permissions.capabilities().tagFacets,
  );
  return (
    <div class="issue-overview">
      <Show when={props.issue.stats}>
        {(stats) => <IssueHistogram stats={stats()} />}
      </Show>
      <Show when={permissions.capabilities().tagFacets}>
        <Show when={tags.isError}>
          <ErrorNotice error={tags.error} retry={() => tags.refetch()} />
        </Show>
        <Show when={tags.data}>
          {(data) => (
            <TagsPanel
              tags={data()}
              base={{
                org: props.org,
                project: props.project,
                id: props.issue.id,
              }}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

function IssueLayout() {
  const params = useParams({ from: "/authed/$org/$project/issues/$id" });
  const issue = useIssue(() => params().id);
  return (
    <>
      <Show when={issue.isError}>
        <ErrorNotice error={issue.error} retry={() => issue.refetch()} />
      </Show>
      <Show when={issue.isPending}>
        <Loading />
      </Show>
      <Show when={issue.data}>
        {(data) => (
          <>
            <IssueHeader
              issue={data()}
              org={params().org}
              project={params().project}
            />
            <IssueOverview
              issue={data()}
              org={params().org}
              project={params().project}
            />
            <div class="tabs" role="tablist" aria-label="Issue sections">
              <Link
                to="/$org/$project/issues/$id"
                params={params()}
                activeOptions={{ exact: true, includeSearch: false }}
                role="tab"
                activeProps={{ class: "active" }}
              >
                Details
              </Link>
              <Link
                to="/$org/$project/issues/$id/events"
                params={params()}
                role="tab"
                activeProps={{ class: "active" }}
              >
                Events
              </Link>
            </div>
            <Outlet />
          </>
        )}
      </Show>
    </>
  );
}

export const issueRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/$org/$project/issues/$id",
  component: IssueLayout,
});

function EventNav(props: {
  base: { org: string; project: string; id: string };
  previous: string | null | undefined;
  next: string | null | undefined;
  oldest: string | undefined;
  latest: string | undefined;
  current: string;
}) {
  const link = (
    label: string,
    event: string | null | undefined,
    rel: string,
  ) => (
    <Show
      when={event && event !== props.current}
      fallback={
        <span class="btn disabled" aria-disabled="true">
          {label}
        </span>
      }
    >
      <Link
        to="/$org/$project/issues/$id"
        params={props.base}
        search={{ event: event ?? undefined }}
        class="btn"
        rel={rel}
      >
        {label}
      </Link>
    </Show>
  );
  return (
    <nav class="event-nav" aria-label="Event navigation">
      {link("Oldest", props.oldest, "first")}
      {link("Older", props.previous, "prev")}
      {link("Newer", props.next, "next")}
      {link("Latest", props.latest, "last")}
    </nav>
  );
}

function IssueEvent() {
  const params = useParams({ from: "/authed/$org/$project/issues/$id/" });
  const search = useSearch({ from: "/authed/$org/$project/issues/$id/" });
  const which = () => search().event ?? "latest";
  const event = useEvent(() => params().id, which);
  const oldest = useEvent(
    () => params().id,
    () => "oldest",
  );
  const latest = useEvent(
    () => params().id,
    () => "latest",
  );
  const navigate = useNavigate();
  // [ and ] go to the older and newer event, as the Older / Newer buttons do.
  useShortcuts((shortcut) => {
    if (shortcut !== "previousEvent" && shortcut !== "nextEvent") return false;
    const target =
      shortcut === "previousEvent"
        ? event.data?.previousEventID
        : event.data?.nextEventID;
    if (!target || target === event.data?.eventID) return false;
    void navigate({
      to: "/$org/$project/issues/$id",
      params: params(),
      search: { event: target },
    });
    return true;
  });
  return (
    <>
      <Show when={event.isError}>
        <ErrorNotice error={event.error} retry={() => event.refetch()} />
      </Show>
      <Show when={event.isPending}>
        <Loading />
      </Show>
      <Show when={event.data}>
        {(data) => (
          <>
            <EventNav
              base={params()}
              previous={data().previousEventID}
              next={data().nextEventID}
              oldest={oldest.data?.eventID}
              latest={latest.data?.eventID}
              current={data().eventID}
            />
            <EventView event={data()} />
          </>
        )}
      </Show>
    </>
  );
}

export const issueEventRoute = createRoute({
  getParentRoute: () => issueRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): { event?: string } =>
    typeof search.event === "string" && search.event
      ? { event: search.event }
      : {},
  component: IssueEvent,
});

function IssueEvents() {
  const params = useParams({ from: "/authed/$org/$project/issues/$id/events" });
  const events = useEvents(() => params().id);
  const rows = () => flatten(events.data);
  const sentinel = createSentinel(events);
  return (
    <>
      <Show when={events.isError}>
        <ErrorNotice error={events.error} retry={() => events.refetch()} />
      </Show>
      <Show when={events.isPending}>
        <Loading />
      </Show>
      <Show
        when={
          events.isSuccess &&
          rows().length === 0 &&
          !events.hasNextPage &&
          !events.isFetching
        }
      >
        <p class="muted empty">No events.</p>
      </Show>
      <div class="scroll-x">
        <table class="table events-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Message</th>
              <th>Environment</th>
              <th>Release</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(event) => (
                <tr>
                  <td class="mono">
                    <Link
                      to="/$org/$project/issues/$id"
                      params={{
                        org: params().org,
                        project: params().project,
                        id: params().id,
                      }}
                      search={{ event: event.eventID }}
                    >
                      {event.eventID.slice(0, 12)}
                    </Link>
                  </td>
                  <td class="wrap">{event.title ?? event.message ?? ""}</td>
                  <td>{event.environment ?? ""}</td>
                  <td>{event.release ?? ""}</td>
                  <td>
                    <Time value={event.dateCreated} />
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div ref={sentinel} class="sentinel" aria-hidden="true" />
      <Show when={events.isFetchingNextPage}>
        <Loading label="Loading more…" />
      </Show>
      <Show when={events.hasNextPage && !events.isFetching}>
        <button
          type="button"
          class="link"
          onClick={() => events.fetchNextPage()}
        >
          Load more
        </button>
      </Show>
    </>
  );
}

export const issueEventsRoute = createRoute({
  getParentRoute: () => issueRoute,
  path: "/events",
  component: IssueEvents,
});

function TagValues() {
  const params = useParams({
    from: "/authed/$org/$project/issues/$id/tags/$key",
  });
  const tag = useTag(
    () => params().id,
    () => params().key,
  );
  const values = useTagValues(
    () => params().id,
    () => params().key,
  );
  const rows = () => flatten(values.data);
  const sentinel = createSentinel(values);
  return (
    <>
      <p>
        <Link
          to="/$org/$project/issues/$id"
          params={{
            org: params().org,
            project: params().project,
            id: params().id,
          }}
        >
          Back to the issue
        </Link>
      </p>
      <h2>{tag.data?.name ?? params().key} values</h2>
      <Show when={values.isError}>
        <ErrorNotice error={values.error} retry={() => values.refetch()} />
      </Show>
      <Show when={values.isPending}>
        <Loading />
      </Show>
      <Show
        when={
          values.isSuccess &&
          rows().length === 0 &&
          !values.hasNextPage &&
          !values.isFetching
        }
      >
        <p class="muted empty">No values counted.</p>
      </Show>
      <div class="scroll-x">
        <table class="table tag-values-table">
          <thead>
            <tr>
              <th>Value</th>
              <th class="num">Events</th>
              <th class="num">Share</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row) => (
                <tr>
                  <td class="wrap mono">{row.value}</td>
                  <td class="num">{row.count}</td>
                  <td class="num">
                    {percentLabel(row.count, tag.data?.totalValues ?? 0)}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div ref={sentinel} class="sentinel" aria-hidden="true" />
      <Show when={values.isFetchingNextPage}>
        <Loading label="Loading more…" />
      </Show>
      <Show when={values.hasNextPage && !values.isFetching}>
        <button
          type="button"
          class="link"
          onClick={() => values.fetchNextPage()}
        >
          Load more
        </button>
      </Show>
    </>
  );
}

export const issueTagRoute = createRoute({
  getParentRoute: () => issueRoute,
  path: "/tags/$key",
  component: TagValues,
});
