import { type JSX, Show } from "solid-js";
import { isApiError } from "../api/errors";
import { absoluteTime, relativeTime } from "../lib/time";

export function Time(props: { value: string | null | undefined }) {
  return (
    <time datetime={props.value ?? undefined} title={absoluteTime(props.value)}>
      {relativeTime(props.value)}
    </time>
  );
}

export function Level(props: { level: string | null | undefined }) {
  return (
    <span class="level" data-level={props.level ?? "unknown"}>
      {props.level ?? "unknown"}
    </span>
  );
}

export function Loading(props: { label?: string }) {
  return (
    <p class="muted" role="status">
      {props.label ?? "Loading…"}
    </p>
  );
}

export function ErrorNotice(props: { error: unknown; retry?: () => void }) {
  const text = () => {
    const e = props.error;
    if (isApiError(e, "notFound")) return "Not found.";
    if (isApiError(e, "forbidden"))
      return "This token is not allowed to see this.";
    if (e instanceof Error) return e.message;
    return "Something went wrong.";
  };
  return (
    <div class="notice error" role="alert">
      <span>{text()}</span>
      <Show when={props.retry}>
        <button type="button" class="link" onClick={() => props.retry?.()}>
          Retry
        </button>
      </Show>
    </div>
  );
}

export function Section(props: {
  title: string;
  id?: string;
  children: JSX.Element;
  aside?: JSX.Element;
}) {
  return (
    <section class="panel" id={props.id}>
      <header class="panel-head">
        <h3>{props.title}</h3>
        {props.aside}
      </header>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}

/** A key/value table. Values are always rendered as text. */
export function KeyValues(props: { rows: [string, string][] }) {
  return (
    <table class="kv">
      <tbody>
        {props.rows.map(([k, v]) => (
          <tr>
            <th scope="row">{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
