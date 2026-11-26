import { onCleanup } from "solid-js";
import { type Shortcut, shortcutFor } from "./shortcuts";

/**
 * Listen for the keyboard shortcuts while the calling component is mounted. The handler returns
 * `true` when it used the key, which cancels the browser's own action (typing `/` into a page
 * that has no search box, for example, is left alone by returning `false`). Nothing fires while
 * a modal dialog is open.
 */
export function useShortcuts(handler: (shortcut: Shortcut) => boolean) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (document.querySelector("dialog[open]")) return;
    const shortcut = shortcutFor(event);
    if (shortcut && handler(shortcut) === true) event.preventDefault();
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));
}
