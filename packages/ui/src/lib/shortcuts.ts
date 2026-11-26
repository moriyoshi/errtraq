/**
 * Keyboard shortcuts of the issue list and issue page, as pure functions so the rules can be
 * tested without a DOM. `shortcutFor` decides whether a key event is a shortcut at all; the
 * pages decide what each one does.
 */
export type Shortcut =
  | "next"
  | "previous"
  | "open"
  | "toggleSelect"
  | "resolve"
  | "ignore"
  | "unresolve"
  | "search"
  | "previousEvent"
  | "nextEvent"
  | "help";

const KEYS: Record<string, Shortcut> = {
  j: "next",
  k: "previous",
  Enter: "open",
  o: "open",
  x: "toggleSelect",
  r: "resolve",
  i: "ignore",
  u: "unresolve",
  "/": "search",
  "[": "previousEvent",
  "]": "nextEvent",
  "?": "help",
};

/** What the help dialog lists: keys as typed, and what they do, in display order. */
export const SHORTCUT_HELP: readonly {
  keys: string;
  action: string;
  scope: "list" | "issue" | "everywhere";
}[] = [
  { keys: "j / k", action: "Move to the next / previous issue", scope: "list" },
  { keys: "Enter or o", action: "Open the focused issue", scope: "list" },
  { keys: "x", action: "Select or deselect the focused issue", scope: "list" },
  {
    keys: "r / i / u",
    action:
      "Resolve / ignore / unresolve the selection (the focused issue when nothing is selected), or the open issue",
    scope: "list",
  },
  { keys: "/", action: "Focus the search box", scope: "list" },
  {
    keys: "[ / ]",
    action: "Older / newer event of the open issue",
    scope: "issue",
  },
  { keys: "?", action: "Show this list", scope: "everywhere" },
];

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  /** An `EventTarget` in the browser; only `tagName` and `isContentEditable` are read. */
  target: object | null;
}

/** Elements that take typed text or arrow keys of their own. */
const TEXT_TARGETS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** Elements whose own Enter activation must not be hijacked. */
const ACTIVATABLE = new Set(["A", "BUTTON", "SUMMARY"]);

/**
 * The shortcut a key event stands for, or `null` when it is not one: focus in an input,
 * textarea, select or contenteditable element, a Ctrl / Meta / Alt modifier (Shift is part of
 * the key itself, as in `?`), an event already handled, or IME composition. `Enter` is also left
 * alone on a link, button or summary, where it already activates the focused element.
 */
export function shortcutFor(event: KeyEventLike): Shortcut | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return null;
  const target = event.target as TargetLike | null;
  const tag = target?.tagName?.toUpperCase();
  if (tag && TEXT_TARGETS.has(tag)) return null;
  if (target?.isContentEditable) return null;
  if (event.key === "Enter" && tag && ACTIVATABLE.has(tag)) return null;
  return Object.hasOwn(KEYS, event.key) ? (KEYS[event.key] ?? null) : null;
}

/** The index to focus after `j` or `k`: clamped, and the first row when nothing is focused. */
export function moveFocus(
  current: number,
  length: number,
  direction: "next" | "previous",
): number {
  if (length === 0) return -1;
  if (current < 0 || current >= length) return 0;
  const next = direction === "next" ? current + 1 : current - 1;
  return Math.min(length - 1, Math.max(0, next));
}
