# M3 blob cleanup: implementation constraints

Status: investigation for item 3 of `.agents-workspace/tmp/m3-remaining.md`; no cleanup is
currently enabled. These constraints must be settled in code and tests before scheduling it.

Legacy record claim keys contain a content digest and can be overwritten on a retry. New
publications use a fresh UUID and creation timestamp in their keys, so retries do not reuse a
key. `BlobStore.head` provides no modification time and `BlobStore.delete` is unconditional.
A sweeper that decides a legacy key is old, then deletes it, can race a producer that has
republished the same key. A finite source retention and DLQ retention do not bound repeated manual redrive.
The intended policy is an operator-configured maximum publication / redrive horizon; cleanup
must remain disabled when no finite horizon is configured. The implementation must enforce
the horizon on message handling and include a grace period for already-running handlers before
deleting. It must use only the new non-reused key format for automatic deletion. Existing keys and workers from
before the change must be drained or explicitly retained; their digest is not a creation time.

Overflow event payload keys can likewise be reused. Deleting an event before its blob can
leave a permanent orphan after a crash; deleting the blob first can leave a live event unreadable.
`EventRepo.deleteBatch` deletes by event ID only. A read followed by that deletion can remove a
new event that was reinserted with the same ID. Safe cleanup needs durable deletion intent,
conditional event deletion against the observed immutable identity, and immutable per-insertion
payload keys (including a safe treatment for legacy keys and old in-flight producers).

A candidate implementation writes a durable intent before conditional event deletion, verifies
whether the observed event was actually removed, deletes only the uniquely owned blob, and
removes the intent last. An interrupted run must enumerate and retry intents. Conditional store
operations must prevent an old intent deleting a replacement event; a replacement must never
reuse the old blob key. Retention must not delete unarchived events when archival is selected.
The exact protocol must also bound work per cron invocation and define ownership / concurrency
between concurrent sweepers. This is a design direction, not an implemented guarantee.

Required tests include a crash after every step, concurrent reinsertions, two sweepers, partial
store deletes, blob failures, retries, old keys, SQS source/DLQ/redrive boundaries, and both
standalone and Lambda cron wiring with least-privilege grants. Archive and subject-erasure hooks
remain M4 work.
