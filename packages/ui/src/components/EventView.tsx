import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import {
  type Breadcrumb,
  breadcrumbsSchema,
  display,
  exceptionSchema,
  headerPairs,
  messageSchema,
  requestSchema,
} from "../api/entries";
import type { ErrtraqEvent } from "../api/schemas";
import { breadcrumbTime } from "../lib/time";
import { KeyValues, Section, Time } from "./common";
import { ExceptionChain } from "./StackTrace";

/** Rows for a free-form object; nested values become compact JSON text. */
function rowsOf(
  object: Record<string, unknown> | null | undefined,
): [string, string][] {
  return Object.entries(object ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, display(v)]);
}

const PRIMARY_CONTEXTS = ["os", "browser", "runtime", "device"];

function contextSummary(value: unknown): string {
  if (!value || typeof value !== "object") return display(value);
  const v = value as Record<string, unknown>;
  const name = display(v.name);
  const version = display(v.version);
  return [name, version].filter(Boolean).join(" ");
}

function Contexts(props: { contexts: Record<string, unknown> }) {
  const names = () => {
    const all = Object.keys(props.contexts);
    return [
      ...PRIMARY_CONTEXTS.filter((n) => all.includes(n)),
      ...all.filter((n) => !PRIMARY_CONTEXTS.includes(n)).sort(),
    ];
  };
  return (
    <div class="contexts">
      <For each={names()}>
        {(name) => {
          const value = () => props.contexts[name];
          const object = () =>
            value() && typeof value() === "object" && !Array.isArray(value())
              ? (value() as Record<string, unknown>)
              : null;
          return (
            <div class="context">
              <h4>
                {name}
                <Show
                  when={
                    PRIMARY_CONTEXTS.includes(name) && contextSummary(value())
                  }
                >
                  <span class="muted"> {contextSummary(value())}</span>
                </Show>
              </h4>
              <KeyValues
                rows={
                  object() ? rowsOf(object()) : [["value", display(value())]]
                }
              />
            </div>
          );
        }}
      </For>
    </div>
  );
}

function Breadcrumbs(props: { values: Breadcrumb[] }) {
  return (
    <div class="scroll-x">
      <table class="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Category</th>
            <th>Level</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.values}>
            {(crumb) => (
              <tr>
                <td class="nowrap">{breadcrumbTime(crumb.timestamp)}</td>
                <td>{crumb.type ?? ""}</td>
                <td>{crumb.category ?? ""}</td>
                <td>{crumb.level ?? ""}</td>
                <td class="wrap">
                  {crumb.message ?? ""}
                  <Show when={crumb.data !== undefined && crumb.data !== null}>
                    <div class="muted small mono">{display(crumb.data)}</div>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function Raw(props: { event: ErrtraqEvent }) {
  const [open, setOpen] = createSignal(false);
  const json = createMemo(() =>
    open() ? JSON.stringify(props.event, null, 2) : "",
  );
  return (
    <Section
      title="Raw JSON"
      aside={
        <button type="button" class="link" onClick={() => setOpen(!open())}>
          {open() ? "Hide" : "Show"}
        </button>
      }
    >
      <Show when={open()} fallback={<p class="muted small">Hidden.</p>}>
        <pre class="raw">{json()}</pre>
      </Show>
    </Section>
  );
}

/** One stored event. Every payload field is optional and rendered as text only. */
export function EventView(props: { event: ErrtraqEvent }) {
  const sections = createMemo(() => {
    const out: JSX.Element[] = [];
    for (const entry of props.event.entries) {
      if (entry.type === "exception") {
        const parsed = exceptionSchema.safeParse(entry.data);
        const values = parsed.success ? parsed.data : [];
        if (values.length)
          out.push(
            <Section title="Exception">
              <ExceptionChain values={values} />
            </Section>,
          );
      } else if (entry.type === "message") {
        const parsed = messageSchema.safeParse(entry.data);
        const text = parsed.success
          ? (parsed.data.formatted ?? parsed.data.message)
          : null;
        if (text)
          out.push(
            <Section title="Message">
              <p class="exc-value">{text}</p>
            </Section>,
          );
      } else if (entry.type === "breadcrumbs") {
        const parsed = breadcrumbsSchema.safeParse(entry.data);
        const values = parsed.success ? parsed.data : [];
        if (values.length)
          out.push(
            <Section title={`Breadcrumbs (${values.length})`}>
              <Breadcrumbs values={values} />
            </Section>,
          );
      } else if (entry.type === "request") {
        const parsed = requestSchema.safeParse(entry.data);
        if (parsed.success) {
          const r = parsed.data;
          const rows: [string, string][] = [
            ...(r.method ? ([["method", r.method]] as [string, string][]) : []),
            ...(r.url ? ([["url", r.url]] as [string, string][]) : []),
            ...(r.query_string
              ? ([["query", display(r.query_string)]] as [string, string][])
              : []),
            ...headerPairs(r.headers),
            ...(r.data !== undefined && r.data !== null
              ? ([["body", display(r.data)]] as [string, string][])
              : []),
          ];
          if (rows.length)
            out.push(
              <Section title="Request">
                <KeyValues rows={rows} />
              </Section>,
            );
        }
      }
    }
    return out;
  });
  const user = () => {
    const u = props.event.user;
    return u ? rowsOf(u as Record<string, unknown>) : [];
  };
  const contexts = () => props.event.contexts ?? {};
  return (
    <div class="event">
      <dl class="meta">
        <div>
          <dt>Event ID</dt>
          <dd class="mono">{props.event.eventID}</dd>
        </div>
        <div>
          <dt>Occurred</dt>
          <dd>
            <Time value={props.event.dateCreated} />
          </dd>
        </div>
        <Show when={props.event.environment}>
          <div>
            <dt>Environment</dt>
            <dd>{props.event.environment}</dd>
          </div>
        </Show>
        <Show when={props.event.release}>
          <div>
            <dt>Release</dt>
            <dd>{props.event.release}</dd>
          </div>
        </Show>
        <Show when={props.event.platform}>
          <div>
            <dt>Platform</dt>
            <dd>{props.event.platform}</dd>
          </div>
        </Show>
      </dl>
      {sections()}
      <Show when={props.event.tags.length > 0}>
        <Section title="Tags">
          <ul class="tags">
            <For each={props.event.tags}>
              {(tag) => (
                <li>
                  <span class="tag-key">{tag.key}</span>
                  <span class="tag-value">{tag.value}</span>
                </li>
              )}
            </For>
          </ul>
        </Section>
      </Show>
      <Show when={user().length > 0}>
        <Section title="User">
          <KeyValues rows={user()} />
        </Section>
      </Show>
      <Show when={Object.keys(contexts()).length > 0}>
        <Section title="Contexts">
          <Contexts contexts={contexts()} />
        </Section>
      </Show>
      <Show when={props.event.sdk}>
        {(sdk) => (
          <Show when={rowsOf(sdk()).length > 0}>
            <Section title="SDK">
              <KeyValues rows={rowsOf(sdk())} />
            </Section>
          </Show>
        )}
      </Show>
      <Show when={props.event.extra && rowsOf(props.event.extra).length > 0}>
        <Section title="Additional data">
          <KeyValues rows={rowsOf(props.event.extra)} />
        </Section>
      </Show>
      <Raw event={props.event} />
    </div>
  );
}
