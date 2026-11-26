import { createSignal, For, Show } from "solid-js";
import { display, type ExceptionValue, type Frame } from "../api/entries";
import {
  contextLines,
  type FrameItem,
  frameLocation,
  prepareFrames,
} from "../lib/frames";

function FrameRow(props: { frame: Frame }) {
  const [open, setOpen] = createSignal(props.frame.in_app === true);
  const lines = () => contextLines(props.frame);
  const hasDetails = () =>
    lines().length > 0 || Object.keys(props.frame.vars ?? {}).length > 0;
  return (
    <li class="frame" classList={{ "in-app": props.frame.in_app === true }}>
      <button
        type="button"
        class="frame-head"
        aria-expanded={open()}
        disabled={!hasDetails()}
        onClick={() => setOpen(!open())}
      >
        <span class="frame-file">{frameLocation(props.frame)}</span>
        <Show when={props.frame.function}>
          <span class="frame-fn"> in {props.frame.function}</span>
        </Show>
        <Show when={props.frame.in_app === true}>
          <span class="chip">in app</span>
        </Show>
      </button>
      <Show when={open() && lines().length > 0}>
        <ol class="code">
          <For each={lines()}>
            {(line) => (
              <li classList={{ current: line.current }}>
                <span class="lineno">{line.lineno ?? ""}</span>
                <code>{line.text}</code>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={open() && Object.keys(props.frame.vars ?? {}).length > 0}>
        <table class="kv vars">
          <tbody>
            <For each={Object.entries(props.frame.vars ?? {})}>
              {([k, v]) => (
                <tr>
                  <th scope="row">{k}</th>
                  <td>{display(v)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </li>
  );
}

function Collapsed(props: { frames: { frame: Frame }[] }) {
  const [open, setOpen] = createSignal(false);
  return (
    <li class="frame collapsed">
      <button
        type="button"
        class="link"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        {open() ? "Hide" : "Show"} {props.frames.length} frames from libraries
      </button>
      <Show when={open()}>
        <ul class="frames nested">
          <For each={props.frames}>{(f) => <FrameRow frame={f.frame} />}</For>
        </ul>
      </Show>
    </li>
  );
}

function Frames(props: { frames: readonly Frame[] }) {
  const [all, setAll] = createSignal(false);
  const items = (): FrameItem[] => prepareFrames(props.frames, all());
  const hasLibraryFrames = () =>
    props.frames.some((f) => f.in_app !== true) &&
    props.frames.some((f) => f.in_app === true);
  return (
    <div>
      <Show when={hasLibraryFrames()}>
        <label class="toggle">
          <input
            type="checkbox"
            checked={all()}
            onChange={(e) => setAll(e.currentTarget.checked)}
          />{" "}
          Show all frames
        </label>
      </Show>
      <ul class="frames">
        <For each={items()}>
          {(item) =>
            item.kind === "frame" ? (
              <FrameRow frame={item.frame} />
            ) : (
              <Collapsed frames={item.frames} />
            )
          }
        </For>
      </ul>
    </div>
  );
}

/** The exception chain, most recently raised exception first. */
export function ExceptionChain(props: { values: readonly ExceptionValue[] }) {
  const ordered = () => [...props.values].reverse();
  return (
    <For each={ordered()}>
      {(value, i) => (
        <div class="exception">
          <h4>
            <Show when={i() > 0}>
              <span class="muted">caused by </span>
            </Show>
            <span class="exc-type">{value.type ?? "Error"}</span>
            <Show when={value.module}>
              <span class="muted"> ({value.module})</span>
            </Show>
          </h4>
          <Show when={value.value}>
            <p class="exc-value">{value.value}</p>
          </Show>
          <Show when={value.mechanism}>
            {(m) => (
              <p class="muted small">
                mechanism: {m().type ?? "unknown"}
                <Show when={m().handled !== null && m().handled !== undefined}>
                  {m().handled ? ", handled" : ", unhandled"}
                </Show>
              </p>
            )}
          </Show>
          <Show
            when={(value.stacktrace?.frames ?? []).length > 0}
            fallback={<p class="muted small">No stack trace.</p>}
          >
            <Frames frames={value.stacktrace?.frames ?? []} />
          </Show>
        </div>
      )}
    </For>
  );
}
