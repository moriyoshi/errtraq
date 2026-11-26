import { createRoute, Link, useParams } from "@tanstack/solid-router";
import { For, Show } from "solid-js";
import { apiBase } from "../api/instance";
import { useDsnKeys, useProject } from "../api/project";
import { CopyButton } from "../components/CopyButton";
import { ErrorNotice, KeyValues, Loading, Section } from "../components/common";
import { ProjectTabs } from "../components/ProjectTabs";
import { cliSnippet, sdkSnippets } from "../lib/snippets";
import { authedRoute } from "./root";

function Snippet(props: { title: string; code: string }) {
  return (
    <div class="snippet">
      <div class="snippet-head">
        <h4>{props.title}</h4>
        <CopyButton
          text={props.code}
          label={`Copy the ${props.title} snippet`}
        />
      </div>
      <pre class="raw">{props.code}</pre>
    </div>
  );
}

function Settings() {
  const params = useParams({ from: "/authed/$org/$project/settings" });
  const org = () => params().org;
  const slug = () => params().project;
  const project = useProject(org, slug);
  const keys = useDsnKeys(org, slug);
  const withDsn = () =>
    (keys.data ?? []).filter((k) => k.isActive && k.dsn?.public);
  const dsn = () => withDsn()[0]?.dsn?.public ?? undefined;
  /** What `SENTRY_URL` should be: the API's origin, which is where this page was loaded from. */
  const serverUrl = () =>
    apiBase ? apiBase.replace(/\/+$/, "") : window.location.origin;
  const limits = (): [string, string][] => {
    const e = project.data?.errtraq;
    const rows: [string, string][] = [
      [
        "Retention",
        e?.retentionDays === undefined
          ? "not reported"
          : `${e.retentionDays} days`,
      ],
    ];
    const rate = e?.rateLimits;
    rows.push([
      "Events per issue per window",
      rate?.issueEvents === undefined
        ? "stack default"
        : String(rate.issueEvents),
    ]);
    rows.push([
      "New issues per window",
      rate?.newIssues === undefined ? "stack default" : String(rate.newIssues),
    ]);
    return rows;
  };
  return (
    <>
      <nav class="crumbs">
        <Link to="/organizations">Organizations</Link>
        <Link to="/organizations/$org/projects" params={{ org: org() }}>
          {org()}
        </Link>
        <span>{slug()}</span>
      </nav>
      <ProjectTabs org={org()} project={slug()} current="settings" />
      <h1>Project settings</h1>
      <p class="muted small">
        Read-only. Change limits in the stack configuration.
      </p>

      <Section title="DSN keys" id="keys">
        <Show when={keys.isError}>
          <ErrorNotice error={keys.error} retry={() => keys.refetch()} />
        </Show>
        <Show when={keys.isPending}>
          <Loading />
        </Show>
        <Show when={keys.isSuccess && (keys.data?.length ?? 0) === 0}>
          <p class="muted">This project has no keys.</p>
        </Show>
        <ul class="dsn-keys">
          <For each={keys.data}>
            {(key) => (
              <li class="dsn-key">
                <div>
                  <strong>{key.name ?? "Key"}</strong>{" "}
                  <span
                    class="status"
                    data-status={key.isActive ? "active" : "ignored"}
                  >
                    {key.isActive ? "active" : "revoked"}
                  </span>{" "}
                  <span class="muted small mono">{key.public}</span>
                </div>
                <Show
                  when={key.dsn?.public}
                  fallback={
                    <p class="notice" data-testid="no-dsn">
                      No DSN: the server has no public ingest URL configured, so
                      it cannot tell SDKs where to send events. Set{" "}
                      <code>publicUrl</code> (standalone) or{" "}
                      <code>publicIngestUrl</code> (AWS Lambda) in the platform
                      settings.
                    </p>
                  }
                >
                  {(value) => (
                    <div class="dsn-line">
                      <code class="dsn wrap" data-testid="dsn">
                        {value()}
                      </code>
                      <CopyButton text={value()} label="Copy the DSN" />
                    </div>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Section>

      <Section title="SDK setup" id="sdk">
        <Show
          when={dsn()}
          fallback={
            <p class="muted">
              Snippets appear once the project has an active key with a DSN.
            </p>
          }
        >
          {(value) => {
            const code = () => sdkSnippets(value());
            return (
              <>
                <Snippet title="JavaScript (browser)" code={code().browser} />
                <Snippet title="JavaScript (Node)" code={code().node} />
                <Snippet title="Python" code={code().python} />
              </>
            );
          }}
        </Show>
      </Section>

      <Section title="sentry-cli" id="cli">
        <Snippet
          title="Environment"
          code={cliSnippet({ url: serverUrl(), org: org(), project: slug() })}
        />
      </Section>

      <Section title="Retention and rate limits" id="limits">
        <Show when={project.isError}>
          <ErrorNotice error={project.error} retry={() => project.refetch()} />
        </Show>
        <Show when={project.isPending}>
          <Loading />
        </Show>
        <Show when={project.data}>
          <KeyValues rows={limits()} />
        </Show>
      </Section>
    </>
  );
}

export const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/$org/$project/settings",
  component: Settings,
});
