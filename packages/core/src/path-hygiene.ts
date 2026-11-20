/** Detect unambiguous local path prefixes in free text. One-component roots such as /app,
 * /root and /src are deliberately ignored: they are common application paths and identifiers. */
export function containsLocalPath(text: string, root: string): boolean {
  const normalized = root.replace(/\\+/g, "/").replace(/\/+$/, "");
  if (!/^(?:\/|[A-Za-z]:\/)/.test(normalized)) return false;
  const components = normalized
    .replace(/^[A-Za-z]:/, "")
    .split("/")
    .filter(Boolean);
  if (components.length < 2) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|[\\s"'=:(\\[,])${escaped}(?=$|[/\\s"'\\])}:,])`,
  );
  return pattern.test(text.replace(/\\+/g, "/"));
}
