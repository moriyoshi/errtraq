import { createSignal, For, Show } from "solid-js";
import { bars, type Point, peak, sparklinePoints, total } from "../lib/series";

const dayFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const hourFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
/** UTC label of a bucket start: the hour for hourly series, the day otherwise. */
export function bucketLabel(seconds: number, step: number): string {
  const date = new Date(seconds * 1000);
  return step < 86_400
    ? `${hourFormat.format(date)} UTC`
    : `${dayFormat.format(date)} UTC`;
}

/**
 * A small inline line chart for an issue row. The text alternative states the total and the
 * peak, and the total is also printed, so the information never depends on colour or shape.
 */
export function Sparkline(props: {
  points: readonly Point[];
  /** Human period, such as "24 hours". */
  period: string;
}) {
  const width = 96;
  const height = 24;
  const sum = () => total(props.points);
  const label = () =>
    `${sum()} events in the last ${props.period}, up to ${peak(props.points)} in one interval`;
  return (
    <div class="spark" data-testid="sparkline">
      <svg
        role="img"
        aria-label={label()}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        preserveAspectRatio="none"
      >
        <title>{label()}</title>
        <line
          class="spark-base"
          x1="0"
          y1={height - 0.5}
          x2={width}
          y2={height - 0.5}
        />
        <polyline
          class="spark-line"
          fill="none"
          points={sparklinePoints(props.points, width, height)}
        />
      </svg>
      <span class="spark-total small muted">
        {sum()} / {props.period}
      </span>
    </div>
  );
}

/** A bar chart with first/last labels and the peak printed, one `<title>` per bar. */
export function BarChart(props: {
  points: readonly Point[];
  step: number;
  label: string;
}) {
  const width = 640;
  const height = 96;
  const rects = () => bars(props.points, width, height, { gap: 2 });
  const first = () => props.points[0]?.[0];
  const last = () => props.points.at(-1)?.[0];
  return (
    <figure class="bar-chart" data-testid="bar-chart">
      <svg
        role="img"
        aria-label={`${props.label}: ${total(props.points)} events, peak ${peak(props.points)}`}
        viewBox={`0 0 ${width} ${height + 18}`}
        preserveAspectRatio="none"
      >
        <title>{`${props.label}: ${total(props.points)} events`}</title>
        <line class="bar-axis" x1="0" y1={height} x2={width} y2={height} />
        <For each={rects()}>
          {(bar) => (
            <rect
              class="bar"
              classList={{ "bar-empty": bar.count === 0 }}
              x={bar.x}
              y={bar.count === 0 ? height - 1 : bar.y}
              width={bar.width}
              height={bar.count === 0 ? 1 : bar.height}
            >
              <title>
                {bucketLabel(bar.time, props.step)}: {bar.count}
              </title>
            </rect>
          )}
        </For>
        <Show when={first() !== undefined}>
          <text class="bar-label" x="0" y={height + 14}>
            {bucketLabel(first() as number, props.step)}
          </text>
          <text class="bar-label" x={width} y={height + 14} text-anchor="end">
            {bucketLabel(last() as number, props.step)}
          </text>
        </Show>
      </svg>
      <figcaption class="small muted">
        {total(props.points)} events, peak {peak(props.points)} per{" "}
        {props.step < 86_400 ? "hour" : "day"} (by time received)
      </figcaption>
    </figure>
  );
}

const PERIODS = [
  { id: "24h", label: "24h", name: "Last 24 hours", step: 3600 },
  { id: "30d", label: "30d", name: "Last 30 days", step: 86_400 },
] as const;

/** The issue histogram with a 24h / 30d toggle. */
export function IssueHistogram(props: {
  stats: Record<string, Array<[number, number]>>;
}) {
  const available = () => PERIODS.filter((p) => props.stats[p.id]);
  const [chosen, setChosen] = createSignal<string>("24h");
  const current = () =>
    available().find((p) => p.id === chosen()) ?? available()[0];
  return (
    <Show when={current()}>
      {(period) => (
        <section class="panel histogram" aria-label="Event histogram">
          <header class="panel-head">
            <h3>Events</h3>
            <fieldset class="toggle">
              <legend class="sr-only">Period</legend>
              <For each={available()}>
                {(p) => (
                  <button
                    type="button"
                    aria-pressed={period().id === p.id}
                    classList={{ active: period().id === p.id }}
                    onClick={() => setChosen(p.id)}
                  >
                    {p.label}
                  </button>
                )}
              </For>
            </fieldset>
          </header>
          <div class="panel-body">
            <BarChart
              points={props.stats[period().id] ?? []}
              step={period().step}
              label={period().name}
            />
          </div>
        </section>
      )}
    </Show>
  );
}
