import type { Timestamp } from "./domain.js";
import type { Logger, ProjectRepo, QueueProducer } from "./ports.js";

/** Queue topic of the per-project archival worker. */
export const ARCHIVE_PROJECT_TOPIC = "archive.project";

export interface ArchiveProjectMessage {
  projectId: string;
  /** True when a worker re-enqueued itself after using its time budget. */
  continuation?: boolean;
}

const PLANNER_PAGE = 100;

/**
 * The `archive-planner` cron job: page through all projects and send one `archive.project` message
 * per project. The message key is `<tick>/<projectId>`, so a redelivered or re-run tick produces the
 * same keys; the worker is idempotent regardless (a busy lease just acknowledges).
 * Cross-project parallelism is the queue consumer concurrency.
 */
export async function runArchivePlanner(
  options: {
    projects: Pick<ProjectRepo, "list">;
    queue: QueueProducer;
    logger: Pick<Logger, "info">;
  },
  firedAt: Timestamp,
  pageSize = PLANNER_PAGE,
): Promise<{ projects: number }> {
  let cursor: Parameters<ProjectRepo["list"]>[0];
  let projects = 0;
  do {
    const page = await options.projects.list(cursor, pageSize);
    if (page.items.length) {
      await options.queue.send(
        ARCHIVE_PROJECT_TOPIC,
        page.items.map((project) => ({
          key: `archive-planner/${firedAt}/${project.id}`,
          body: { projectId: project.id } satisfies ArchiveProjectMessage,
        })),
      );
      projects += page.items.length;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  options.logger.info("Archive planner finished", { projects });
  return { projects };
}
