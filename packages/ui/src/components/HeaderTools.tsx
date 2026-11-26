import { createSignal, For } from "solid-js";
import { SHORTCUT_HELP } from "../lib/shortcuts";
import {
  applyTheme,
  loadTheme,
  saveTheme,
  THEME_CHOICES,
  type ThemeChoice,
} from "../lib/theme";
import { useShortcuts } from "../lib/use-shortcuts";

const LABELS: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

// Applied when this module loads, before the first render, so a stored choice does not flash the
// system theme (the CSP forbids an inline script in index.html for the same purpose).
if (typeof document !== "undefined") applyTheme(loadTheme());

/** System / light / dark, remembered in localStorage (best effort). */
export function ThemeToggle() {
  const [choice, setChoice] = createSignal<ThemeChoice>(loadTheme());
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
    applyTheme(next);
  };
  return (
    <fieldset class="toggle theme-toggle">
      <legend class="sr-only">Colour theme</legend>
      <For each={THEME_CHOICES}>
        {(option) => (
          <button
            type="button"
            aria-pressed={choice() === option}
            onClick={() => pick(option)}
          >
            {LABELS[option]}
          </button>
        )}
      </For>
    </fieldset>
  );
}

/** The `?` dialog. A native modal `<dialog>`: focus is trapped, Escape closes, focus returns. */
export function ShortcutHelp() {
  let dialog: HTMLDialogElement | undefined;
  const open = () => {
    if (dialog && !dialog.open) dialog.showModal();
  };
  useShortcuts((shortcut) => {
    if (shortcut !== "help") return false;
    open();
    return true;
  });
  return (
    <>
      <button type="button" class="link" onClick={open} aria-haspopup="dialog">
        Shortcuts
      </button>
      <dialog ref={dialog} class="help" aria-labelledby="shortcut-help-title">
        <h2 id="shortcut-help-title">Keyboard shortcuts</h2>
        <p class="muted small">
          Shortcuts are off while you type in a field and when Ctrl, Alt or Cmd
          is held.
        </p>
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Keys</th>
              <th scope="col">Action</th>
              <th scope="col">Where</th>
            </tr>
          </thead>
          <tbody>
            <For each={SHORTCUT_HELP}>
              {(row) => (
                <tr>
                  <th scope="row">
                    <kbd>{row.keys}</kbd>
                  </th>
                  <td>{row.action}</td>
                  <td class="muted">{row.scope}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <form method="dialog">
          <button type="submit" class="primary">
            Close
          </button>
        </form>
      </dialog>
    </>
  );
}

/** What the header adds: shortcut help and the theme toggle. */
export function HeaderTools() {
  return (
    <div class="header-tools">
      <ShortcutHelp />
      <ThemeToggle />
    </div>
  );
}
