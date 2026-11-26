import {
  createRoute,
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";
import { createSignal, For, Show } from "solid-js";
import {
  createSentinel,
  flatten,
  type IssueFilter,
  useIssues,
  usePermissions,
} from "../api/queries";
import { ErrorNotice, Level, Loading, Time } from "../components/common";
import {
  type IssueSearch,
  SORTS,
  STATUSES,
  validateIssueSearch,
} from "../lib/search";
import { authedRoute } from "./root";

function Issues() {
  const params = useParams({ from: "/authed/$org/$project/issues" });
  const search = useSearch({ from: "/authed/$org/$project/issues" });
  const navigate = useNavigate();
  const permissions = usePermissions();
  const filter = (): IssueFilter => ({
    status: search().status ?? "unresolved",
    sort: search().sort ?? "date",
    q: search().q ?? "",
  });
  const issues = useIssues(
    () => params().org,
    () => params().project,
    filter,
  );
  const rows = () => flatten(issues.data);
  const sentinel = createSentinel(issues);
  const [draft, setDraft] = createSignal(search().q ?? "");
  const setSearch = (next: IssueSearch) =>
    void navigate({
      to: "/$org/$project/issues",
      params: params(),
      search: validateIssueSearch({ ...search(), ...next }),
    });
  return (
    <>
      <nav class="crumbs">
        <Link to="/organizations">Organizations</Link>
        <Link to="/organizations/$org/projects" params={{ org: params().org }}>
          {params().org}
        </Link>
        <span>{params().project}</span>
      </nav>
      <h1>Issues</h1>
      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="Status">
          <For each={STATUSES}>
            {(status) => (
              <Link
                to="/$org/$project/issues"
                params={params()}
                search={validateIssueSearch({ ...search(), status })}
                role="tab"
                aria-selected={filter().status === status}
                classList={{ active: filter().status === status }}
              >
                {status}
              </Link>
            )}
          </For>
        </div>
        <label class="sort">
          Sort
          <select
            value={filter().sort}
            onChange={(e) =>
              setSearch({ sort: e.currentTarget.value as IssueFilter["sort"] })
            }
          >
            <For each={SORTS}>
              {(s) => <option value={s.value}>{s.label}</option>}
            </For>
          </select>
        </label>
        {/* TODO(UI-f): bulk selection and actions plug in beside the sort control. */}
        <Show when={permissions.capabilities().textSearch}>
          <form
            class="search"
            aria-label="Search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch({ q: draft() });
            }}
          >
            <input
              type="search"
              aria-label="Search issues"
              placeholder="Search issues"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
          </form>
        </Show>
      </div>
      <Show when={issues.isError}>
        <ErrorNotice error={issues.error} retry={() => issues.refetch()} />
      </Show>
      <Show when={issues.isPending}>
        <Loading />
      </Show>
      <Show
        when={
          issues.isSuccess &&
          rows().length === 0 &&
          !issues.hasNextPage &&
          !issues.isFetching
        }
      >
        <p class="muted empty">No {filter().status} issues.</p>
      </Show>
      <ul class="issues">
        <For each={rows()}>
          {(issue) => (
            <li class="issue-row">
              {/* TODO(UI-d): count sparkline goes in this row once the API serves bucketed counts. */}
              <div class="issue-main">
                <Link
                  to="/$org/$project/issues/$id"
                  params={{ ...params(), id: issue.id }}
                  class="issue-title"
                >
                  {issue.title}
                </Link>
                <div class="muted small ellipsis">{issue.culprit ?? ""}</div>
              </div>
              <Level level={issue.level} />
              <div class="num" title="Events">
                {issue.count}
              </div>
              <div class="when small muted">
                <div>
                  first <Time value={issue.firstSeen} />
                </div>
                <div>
                  last <Time value={issue.lastSeen} />
                </div>
              </div>
            </li>
          )}
        </For>
      </ul>
      <div ref={sentinel} class="sentinel" aria-hidden="true" />
      <Show when={issues.isFetchingNextPage}>
        <Loading label="Loading more…" />
      </Show>
      <Show when={issues.hasNextPage && !issues.isFetching}>
        <button
          type="button"
          class="link"
          onClick={() => issues.fetchNextPage()}
        >
          Load more
        </button>
      </Show>
    </>
  );
}

export const issuesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/$org/$project/issues",
  validateSearch: validateIssueSearch,
  component: Issues,
});
