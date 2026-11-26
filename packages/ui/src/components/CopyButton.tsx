import { createSignal } from "solid-js";
import { copyText } from "../lib/clipboard";

/** Copies `text`; the outcome is announced in a live region next to the button. */
export function CopyButton(props: { text: string; label: string }) {
  const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const copy = async () => {
    setState((await copyText(props.text)) ? "copied" : "failed");
    clearTimeout(timer);
    timer = setTimeout(() => setState("idle"), 4000);
  };
  return (
    <span class="copy">
      <button
        type="button"
        aria-label={props.label}
        onClick={() => void copy()}
      >
        Copy
      </button>
      <span class="small muted" role="status">
        {state() === "copied"
          ? "Copied"
          : state() === "failed"
            ? "Copy failed: select the text and copy it yourself"
            : ""}
      </span>
    </span>
  );
}
