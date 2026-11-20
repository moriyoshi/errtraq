import {
  activeStoreContract,
  archiveStoreContract,
  blobStoreContract,
  kvContract,
  queueContract,
} from "./contracts.js";
import { MemoryActiveStore } from "./memory-active.js";
import {
  MemoryArchiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "./memory-other.js";
import { FakeClock } from "./shared.js";

activeStoreContract(() => new MemoryActiveStore());
blobStoreContract(() => new MemoryBlobStore());
const clock = new FakeClock();
kvContract(() => new MemoryKV(clock), {
  clock,
  advance: (ms) => clock.advance(ms),
});
queueContract(() => new MemoryQueue(clock), {
  clock,
  advance: (ms) => clock.advance(ms),
  deliverPush: async (queue, handler) => {
    if (!(queue instanceof MemoryQueue))
      throw new Error("Expected memory queue");
    await queue.deliverPush(handler);
  },
});
archiveStoreContract(() => new MemoryArchiveStore(), {
  stage: async (store, key, events) => {
    if (!(store instanceof MemoryArchiveStore))
      throw new Error("Expected memory archive");
    await store.blobs.put(
      key,
      new TextEncoder().encode(JSON.stringify(events)),
    );
  },
});
