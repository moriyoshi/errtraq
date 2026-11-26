/**
 * Copy text to the clipboard: the asynchronous Clipboard API when the page may use it (secure
 * context, permission), otherwise a hidden textarea and `execCommand("copy")`. Resolves to
 * whether anything was copied, never throws.
 */
export async function copyText(
  text: string,
  env: {
    clipboard?: { writeText(text: string): Promise<void> } | undefined;
    fallback?: (text: string) => boolean;
  } = {
    clipboard:
      typeof navigator === "undefined" ? undefined : navigator.clipboard,
    fallback: copyWithSelection,
  },
): Promise<boolean> {
  try {
    if (env.clipboard) {
      await env.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable: fall through to the selection method.
  }
  try {
    return env.fallback?.(text) ?? false;
  } catch {
    return false;
  }
}

function copyWithSelection(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.className = "sr-only";
  document.body.append(area);
  try {
    area.select();
    return document.execCommand("copy");
  } finally {
    area.remove();
  }
}
