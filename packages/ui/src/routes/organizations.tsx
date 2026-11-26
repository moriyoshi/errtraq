import { createRoute, Link, Navigate, useParams } from "@tanstack/solid-router";
import { createEffect, createMemo, For, Show } from "solid-js";
import { flatten, useOrganizations, useProjects } from "../api/queries";
import { ErrorNotice, Loading } from "../components/common";
import { authedRoute } from "./root";

function Organizations() {
  const orgs = useOrganizations();
  // Exactly one organization: skip the picker. <Navigate> acts once on mount; an effect that
  // called navigate() would re-run while the router is still loading and restart the load forever.
  const only = () => (orgs.data?.length === 1 ? orgs.data[0] : undefined);
  return (
    <>
      <Show when={only()}>
        {(org) => (
          <Navigate
            to="/organizations/$org/projects"
            params={{ org: org().slug }}
            replace
          />
        )}
      </Show>
      <h1>Organizations</h1>
      <Show when={orgs.isError}>
        <ErrorNotice error={orgs.error} retry={() => orgs.refetch()} />
      </Show>
      <Show when={orgs.isPending}>
        <Loading />
      </Show>
      <Show when={orgs.data?.length === 0}>
        <p class="muted">This token does not see any organization.</p>
      </Show>
      <ul class="list">
        <For each={orgs.data}>
          {(org) => (
            <li>
              <Link
                to="/organizations/$org/projects"
                params={{ org: org.slug }}
              >
                {org.name}
              </Link>
              <span class="muted small"> {org.slug}</span>
            </li>
          )}
        </For>
      </ul>
    </>
  );
}

export const organizationsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/organizations",
  component: Organizations,
});

function Projects() {
  const params = useParams({ from: "/authed/organizations/$org/projects" });
  const org = createMemo(() => params().org);
  const projects = useProjects(org);
  const all = () => flatten(projects.data);
  // Pages can be short or empty with a next cursor: drain them, project lists are small.
  createEffect(() => {
    if (projects.hasNextPage && !projects.isFetching && !projects.isError)
      void projects.fetchNextPage();
  });
  const only = () =>
    all().length === 1 && !projects.hasNextPage && !projects.isFetching
      ? all()[0]
      : undefined;
  return (
    <>
      <nav class="crumbs">
        <Link to="/organizations">Organizations</Link>
        <span>{org()}</span>
      </nav>
      <Show when={only()}>
        {(project) => (
          <Navigate
            to="/$org/$project/issues"
            params={{ org: org(), project: project().slug }}
            replace
          />
        )}
      </Show>
      <h1>Projects</h1>
      <Show when={projects.isError}>
        <ErrorNotice error={projects.error} retry={() => projects.refetch()} />
      </Show>
      <Show when={projects.isPending}>
        <Loading />
      </Show>
      <Show
        when={projects.isSuccess && all().length === 0 && !projects.hasNextPage}
      >
        <p class="muted">No projects.</p>
      </Show>
      <ul class="list">
        <For each={all()}>
          {(project) => (
            <li>
              <Link
                to="/$org/$project/issues"
                params={{ org: org(), project: project.slug }}
              >
                {project.name}
              </Link>
              <span class="muted small"> {project.slug}</span>
            </li>
          )}
        </For>
      </ul>
    </>
  );
}

export const projectsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/organizations/$org/projects",
  component: Projects,
});
