import { useQueryClient } from "@tanstack/solid-query";
import {
  createRoute,
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/solid-router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { bulkUpdateStatus } from "../api/bulk-update";
import {
  createSentinel,
  flatten,
  type IssueFilter,
  useIssues,
  usePermissions,
} from "../api/queries";
import type { IssueStatus } from "../api/schemas";
import { Sparkline } from "../components/Charts";
import { ErrorNotice, Level, Loading, Time } from "../components/common";
import { ProjectTabs } from "../components/ProjectTabs";
import {
  type IssueSearch,
  SORTS,
  STATUSES,
  validateIssueSearch,
} from "../lib/search";
import { moveFocus } from "../lib/shortcuts";
import { useShortcuts } from "../lib/use-shortcuts";
import { authedRoute } from "./root";

const rowId = (id: string) => `issue-row-${id}`;

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
    // Hourly sparkline points only when the store can serve them (never learned from a 400).
    () => (permissions.capabilities().issueStats ? "24h" : undefined),
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
  const qc = useQueryClient();
  const canWrite = () => permissions.canWrite();
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const ids = createMemo(() => rows().map((issue) => issue.id));
  // Selection follows the loaded rows: an issue that left the list (status change, refetch) is
  // no longer selected, so a bulk action never reaches an issue the user cannot see.
  createEffect(() => {
    const visible = new Set(ids());
    const current = selected();
    if ([...current].some((id) => !visible.has(id)))
      setSelected(new Set([...current].filter((id) => visible.has(id))));
  });
  const toggle = (id: string) => {
    const next = new Set(selected());
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };
  const allSelected = () =>
    ids().length > 0 && ids().every((id) => selected().has(id));
  const someSelected = () => selected().size > 0 && !allSelected();
  const toggleAll = () =>
    setSelected(allSelected() ? new Set<string>() : new Set(ids()));
  /** The selection, or the focused row when nothing is selected. */
  const targets = (): string[] => {
    if (selected().size > 0) return [...selected()];
    const id = focused();
    return id && ids().includes(id) ? [id] : [];
  };
  async function apply(status: IssueStatus) {
    const list = targets();
    if (busy() || !canWrite() || list.length === 0) return;
    setBusy(true);
    setFailure("");
    try {
      const summary = await bulkUpdateStatus(
        qc,
        params().org,
        params().project,
        list,
        status,
      );
      setFailure(summary.message);
      // Failed issues stay selected so the action can be retried.
      setSelected(new Set(summary.failed.filter((id) => selected().has(id))));
    } finally {
      setBusy(false);
    }
  }
  function focusRow(id: string | undefined) {
    setFocused(id);
    if (id) document.getElementById(rowId(id))?.focus();
  }
  useShortcuts((shortcut) => {
    const list = ids();
    switch (shortcut) {
      case "next":
      case "previous": {
        const at = moveFocus(
          list.indexOf(focused() ?? ""),
          list.length,
          shortcut,
        );
        focusRow(list[at]);
        return at >= 0;
      }
      case "open": {
        const id = focused();
        if (!id || !list.includes(id)) return false;
        void navigate({
          to: "/$org/$project/issues/$id",
          params: { ...params(), id },
        });
        return true;
      }
      case "toggleSelect": {
        const id = focused();
        if (!canWrite() || !id || !list.includes(id)) return false;
        toggle(id);
        return true;
      }
      case "resolve":
      case "ignore":
      case "unresolve": {
        if (!canWrite() || targets().length === 0) return false;
        void apply(
          shortcut === "resolve"
            ? "resolved"
            : shortcut === "ignore"
              ? "ignored"
              : "unresolved",
        );
        return true;
      }
      case "search": {
        const input = document.getElementById("issue-search");
        input?.focus();
        return !!input;
      }
      default:
        return false;
    }
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
      <ProjectTabs
        org={params().org}
        project={params().project}
        current="issues"
      />
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
              id="issue-search"
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
      <Show when={canWrite() && rows().length > 0}>
        <fieldset class="bulk-bar" aria-busy={busy()}>
          <legend class="sr-only">Bulk actions</legend>
          <label class="select-all">
            <input
              type="checkbox"
              checked={allSelected()}
              ref={(el) =>
                createEffect(() => (el.indeterminate = someSelected()))
              }
              onChange={toggleAll}
            />
            Select all {rows().length} loaded
          </label>
          <span class="muted" role="status">
            {selected().size > 0 ? `${selected().size} selected` : ""}
          </span>
          <Show when={selected().size > 0}>
            <span class="actions">
              <Show when={filter().status !== "resolved"}>
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void apply("resolved")}
                >
                  Resolve
                </button>
              </Show>
              <Show when={filter().status !== "ignored"}>
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void apply("ignored")}
                >
                  Ignore
                </button>
              </Show>
              <Show when={filter().status !== "unresolved"}>
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void apply("unresolved")}
                >
                  Unresolve
                </button>
              </Show>
              <button
                type="button"
                class="link"
                onClick={() => setSelected(new Set<string>())}
              >
                Clear
              </button>
            </span>
          </Show>
        </fieldset>
      </Show>
      <Show when={failure()}>
        <p class="notice error" role="alert">
          {failure()}
        </p>
      </Show>
      <ul class="issues">
        <For each={rows()}>
          {(issue) => (
            <li
              class="issue-row"
              id={rowId(issue.id)}
              tabindex="-1"
              aria-current={focused() === issue.id ? "true" : undefined}
              onFocusIn={() => setFocused(issue.id)}
              classList={{
                "has-select": canWrite(),
                selected: selected().has(issue.id),
              }}
            >
              <Show when={canWrite()}>
                <input
                  type="checkbox"
                  class="row-check"
                  aria-label={`Select ${issue.title}`}
                  checked={selected().has(issue.id)}
                  onChange={() => toggle(issue.id)}
                />
              </Show>
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
              <div class="spark-cell">
                <Show when={issue.stats?.["24h"]}>
                  {(points) => (
                    <Sparkline points={points()} period="24 hours" />
                  )}
                </Show>
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
