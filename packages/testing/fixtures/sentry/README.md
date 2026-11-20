# Sentry SDK envelope fixtures

These are scrubbed captures from `@sentry/node` 11.15, obtained with a custom transport and
serialized with byte lengths. They include exceptions with stacks and causes, a message,
context, an attachment containing binary newlines, a session, a client report, a transaction,
and a large gzip envelope. The mixed envelope combines SDK-produced event, session and
client-report items. The large gzip body exceeds 32 KiB.

To prepare new captures, run the scrubber from the repository root, using a directory of raw
`.envelope` captures as input and this fixture directory as output:

```sh
node packages/testing/scripts/scrub-sentry-fixtures.mjs <raw-captures> packages/testing/fixtures/sentry
```

The script replaces machine-specific contexts and local identifiers with stable fixture values,
recalculates item byte lengths, and regenerates `large.envelope.gz` from `large.envelope` when
that capture is present. Keep raw captures outside the checked-in fixture directory.
