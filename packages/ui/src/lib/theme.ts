export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "errtraq.theme";
export const THEME_CHOICES: readonly ThemeChoice[] = [
  "system",
  "light",
  "dark",
];

export function parseTheme(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

/** The theme actually shown for a choice, given the system preference. */
export function resolveTheme(
  choice: ThemeChoice,
  systemDark: boolean,
): "light" | "dark" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function localStore(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // blocked by the browser (private window, disabled storage)
  }
}

/** The stored choice; `system` when nothing is stored or storage is unavailable. */
export function loadTheme(storage: StorageLike | undefined = localStore()) {
  try {
    return parseTheme(storage?.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** Remember a choice. Best effort: a private window just forgets it on reload. */
export function saveTheme(
  choice: ThemeChoice,
  storage: StorageLike | undefined = localStore(),
): void {
  try {
    storage?.setItem(THEME_KEY, choice);
  } catch {
    // not persisted
  }
}

/** `data-theme` is absent for `system`, so the `prefers-color-scheme` rules apply. */
export function applyTheme(
  choice: ThemeChoice,
  root: {
    setAttribute(n: string, v: string): void;
    removeAttribute(n: string): void;
  } = document.documentElement,
): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}
