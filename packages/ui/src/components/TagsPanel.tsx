import { Link } from "@tanstack/solid-router";
import { For, Show } from "solid-js";
import type { Tag } from "../api/schemas";
import { percent, percentLabel } from "../lib/series";

/** Each key's top values as proportion bars with counts, linking to the full list. */
export function TagsPanel(props: {
  tags: readonly Tag[];
  base: { org: string; project: string; id: string };
}) {
  return (
    <section
      class="panel tags-panel"
      aria-label="Tags"
      data-testid="tags-panel"
    >
      <header class="panel-head">
        <h3>Tags</h3>
      </header>
      <div class="panel-body">
        <Show
          when={props.tags.length}
          fallback={<p class="muted small">No tags counted yet.</p>}
        >
          <For each={props.tags}>
            {(tag) => (
              <div class="tag-group">
                <h4>
                  <Link
                    to="/$org/$project/issues/$id/tags/$key"
                    params={{ ...props.base, key: tag.key }}
                  >
                    {tag.name}
                  </Link>{" "}
                  <span class="muted small">
                    {tag.totalValues} events
                    <Show when={tag.uniqueValues !== undefined}>
                      , {tag.uniqueValues} values
                    </Show>
                  </span>
                </h4>
                <ul class="tag-values">
                  <For each={tag.topValues}>
                    {(value) => (
                      <li>
                        <div class="tag-row">
                          <span class="tag-value ellipsis" title={value.value}>
                            {value.value}
                          </span>
                          <span class="tag-count">
                            {value.count}{" "}
                            <span class="muted">
                              ({percentLabel(value.count, tag.totalValues)})
                            </span>
                          </span>
                        </div>
                        <div class="tag-bar" aria-hidden="true">
                          <span
                            style={{
                              width: `${percent(value.count, tag.totalValues)}%`,
                            }}
                          />
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
                <Show
                  when={
                    tag.uniqueValues !== undefined
                      ? tag.uniqueValues > tag.topValues.length
                      : false
                  }
                >
                  <Link
                    class="small"
                    to="/$org/$project/issues/$id/tags/$key"
                    params={{ ...props.base, key: tag.key }}
                  >
                    All {tag.uniqueValues} values
                  </Link>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </section>
  );
}
