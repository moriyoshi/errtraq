import { createRoute, Link, useParams } from "@tanstack/solid-router";
import { For, Show } from "solid-js";
import {
  useBundles,
  useDeploys,
  useRelease,
  useReleases,
} from "../api/project";
import { createSentinel, flatten } from "../api/queries";
import { ErrorNotice, Loading, Section, Time } from "../components/common";
import { ProjectTabs } from "../components/ProjectTabs";
import { authedRoute } from "./root";

function Releases() {
  const params = useParams({ from: "/authed/$org/$project/releases" });
  const releases = useReleases(
    () => params().org,
    () => params().project,
  );
  const rows = () => flatten(releases.data);
  const sentinel = createSentinel(releases);
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
        current="releases"
      />
      <h1>Releases</h1>
      <Show when={releases.isError}>
        <ErrorNotice error={releases.error} retry={() => releases.refetch()} />
      </Show>
      <Show when={releases.isPending}>
        <Loading />
      </Show>
      <Show
        when={
          releases.isSuccess &&
          rows().length === 0 &&
          !releases.hasNextPage &&
          !releases.isFetching
        }
      >
        <p class="muted empty">
          No releases yet. Create one with <code>sentry-cli releases new</code>.
        </p>
      </Show>
      <Show when={rows().length > 0}>
        <div class="scroll-x">
          <table class="table releases-table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Created</th>
                <th scope="col">Released</th>
                <th scope="col" class="num">
                  New issues
                </th>
                <th scope="col" class="num">
                  Deploys
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(release) => (
                  <tr>
                    <th scope="row" class="mono wrap">
                      <Link
                        to="/$org/$project/releases/$version"
                        params={{ ...params(), version: release.version }}
                      >
                        {release.version}
                      </Link>
                    </th>
                    <td>
                      <Time value={release.dateCreated} />
                    </td>
                    <td>
                      <Show
                        when={release.dateReleased}
                        fallback={<span class="muted">open</span>}
                      >
                        <Time value={release.dateReleased} />
                      </Show>
                    </td>
                    <td class="num" title="Not tracked by errtraq">
                      {release.newGroups ?? 0}
                    </td>
                    <td class="num">{release.deployCount ?? 0}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <p class="muted small">
          New issues is always 0 here: errtraq does not attribute issues to
          releases.
        </p>
      </Show>
      <div ref={sentinel} class="sentinel" aria-hidden="true" />
      <Show when={releases.isFetchingNextPage}>
        <Loading label="Loading more…" />
      </Show>
      <Show when={releases.hasNextPage && !releases.isFetching}>
        <button
          type="button"
          class="link"
          onClick={() => releases.fetchNextPage()}
        >
          Load more
        </button>
      </Show>
    </>
  );
}

export const releasesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/$org/$project/releases",
  component: Releases,
});

function ReleaseDetail() {
  const params = useParams({ from: "/authed/$org/$project/releases/$version" });
  const org = () => params().org;
  const project = () => params().project;
  const version = () => params().version;
  const release = useRelease(org, project, version);
  const deploys = useDeploys(org, project, version);
  const bundles = useBundles(org, project, version);
  const bundleRows = () => flatten(bundles.data);
  return (
    <>
      <nav class="crumbs">
        <Link to="/organizations">Organizations</Link>
        <Link to="/organizations/$org/projects" params={{ org: org() }}>
          {org()}
        </Link>
        <Link
          to="/$org/$project/releases"
          params={{ org: org(), project: project() }}
        >
          Releases
        </Link>
        <span>Release</span>
      </nav>
      <h1 class="mono wrap">{version()}</h1>
      <Show when={release.isError}>
        <ErrorNotice error={release.error} retry={() => release.refetch()} />
      </Show>
      <Show when={release.isPending}>
        <Loading />
      </Show>
      <Show when={release.data}>
        {(data) => (
          <dl class="meta">
            <div>
              <dt>Created</dt>
              <dd>
                <Time value={data().dateCreated} />
              </dd>
            </div>
            <div>
              <dt>Released</dt>
              <dd>
                <Show
                  when={data().dateReleased}
                  fallback={<span class="muted">open</span>}
                >
                  <Time value={data().dateReleased} />
                </Show>
              </dd>
            </div>
            <div>
              <dt>Deploys</dt>
              <dd>{data().deployCount ?? 0}</dd>
            </div>
          </dl>
        )}
      </Show>
      <Section title="Deploys">
        <Show when={deploys.isError}>
          <ErrorNotice error={deploys.error} retry={() => deploys.refetch()} />
        </Show>
        <Show when={deploys.isPending}>
          <Loading />
        </Show>
        <Show when={deploys.isSuccess && (deploys.data?.length ?? 0) === 0}>
          <p class="muted small">No deploys recorded for this release.</p>
        </Show>
        <Show when={(deploys.data?.length ?? 0) > 0}>
          <div class="scroll-x">
            <table class="table deploys-table">
              <thead>
                <tr>
                  <th scope="col">Environment</th>
                  <th scope="col">Name</th>
                  <th scope="col">Started</th>
                  <th scope="col">Finished</th>
                </tr>
              </thead>
              <tbody>
                <For each={deploys.data}>
                  {(deploy) => (
                    <tr>
                      <th scope="row">{deploy.environment}</th>
                      <td class="wrap">{deploy.name ?? ""}</td>
                      <td>
                        <Time value={deploy.dateStarted} />
                      </td>
                      <td>
                        <Time value={deploy.dateFinished} />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>
      <Section title="Artifact bundles">
        <Show when={bundles.isError}>
          <p class="muted small">
            This server does not list artifact bundles for a release.
          </p>
        </Show>
        <Show when={bundles.isPending}>
          <Loading />
        </Show>
        <Show when={bundles.isSuccess && bundleRows().length === 0}>
          <p class="muted small">
            No source map bundles uploaded. Use{" "}
            <code>sentry-cli sourcemaps upload</code>.
          </p>
        </Show>
        <Show when={bundleRows().length > 0}>
          <div class="scroll-x">
            <table class="table bundles-table">
              <thead>
                <tr>
                  <th scope="col">Bundle</th>
                  <th scope="col" class="num">
                    Debug IDs
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={bundleRows()}>
                  {(bundle) => (
                    <tr>
                      <th scope="row" class="mono wrap">
                        {bundle.bundleId}
                      </th>
                      <td class="num">{bundle.errtraq?.debugIdCount ?? ""}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
        <Show when={bundles.hasNextPage && !bundles.isFetching}>
          <button
            type="button"
            class="link"
            onClick={() => bundles.fetchNextPage()}
          >
            Load more
          </button>
        </Show>
      </Section>
    </>
  );
}

export const releaseRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/$org/$project/releases/$version",
  component: ReleaseDetail,
});
