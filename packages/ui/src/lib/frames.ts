import type { Frame } from "../api/entries";

export type FrameItem =
  | { kind: "frame"; frame: Frame; index: number }
  | { kind: "collapsed"; frames: { frame: Frame; index: number }[] };

/**
 * Order frames most recent call first (SDKs send them oldest first) and, unless `expandAll`,
 * fold every run of consecutive non-in-app frames into one collapsed item. Nothing is folded
 * when no frame is in-app (a trace without in-app information is shown whole), and a lone
 * non-in-app frame is kept as is because folding it would hide as much as it shows.
 */
export function prepareFrames(
  frames: readonly Frame[],
  expandAll = false,
): FrameItem[] {
  const ordered = frames.map((frame, index) => ({ frame, index })).reverse();
  const anyInApp = ordered.some((f) => f.frame.in_app === true);
  if (expandAll || !anyInApp)
    return ordered.map((f) => ({ kind: "frame", ...f }));
  const items: FrameItem[] = [];
  let run: { frame: Frame; index: number }[] = [];
  const flush = () => {
    if (run.length === 1 && run[0]) items.push({ kind: "frame", ...run[0] });
    else if (run.length > 1) items.push({ kind: "collapsed", frames: run });
    run = [];
  };
  for (const entry of ordered) {
    if (entry.frame.in_app === true) {
      flush();
      items.push({ kind: "frame", ...entry });
    } else run.push(entry);
  }
  flush();
  return items;
}

export interface ContextLine {
  lineno: number | null;
  text: string;
  current: boolean;
}

/** Source context around the failing line, numbered when the frame has a line number. */
export function contextLines(frame: Frame): ContextLine[] {
  if (frame.context_line === null || frame.context_line === undefined)
    return [];
  const pre = frame.pre_context ?? [];
  const post = frame.post_context ?? [];
  const at = typeof frame.lineno === "number" ? frame.lineno : null;
  const number = (offset: number) => (at === null ? null : at + offset);
  return [
    ...pre.map((text, i) => ({
      lineno: number(i - pre.length),
      text,
      current: false,
    })),
    { lineno: at, text: frame.context_line, current: true },
    ...post.map((text, i) => ({
      lineno: number(i + 1),
      text,
      current: false,
    })),
  ];
}

export function frameLocation(frame: Frame): string {
  const file = frame.filename ?? frame.abs_path ?? frame.module ?? "(unknown)";
  const line = typeof frame.lineno === "number" ? `:${frame.lineno}` : "";
  const col =
    typeof frame.lineno === "number" && typeof frame.colno === "number"
      ? `:${frame.colno}`
      : "";
  return `${file}${line}${col}`;
}
