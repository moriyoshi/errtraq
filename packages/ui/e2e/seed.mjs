import * as Sentry from "@sentry/node";

// Plain .mjs on purpose: the SDK reads source context lines from the file the frames name, so
// the stack traces the UI renders carry real context.
function checkoutFailure(index) {
  throw new TypeError(`checkout failed ${index}`);
}
function inventoryFailure() {
  throw new RangeError("inventory out of range");
}

function capture(make) {
  try {
    make();
  } catch (error) {
    Sentry.captureException(error);
  }
}

/** Send three occurrences of one error and one of another with the real Sentry SDK. */
export async function seed(dsn) {
  Sentry.init({
    dsn,
    release: "ui-e2e@1.0.0",
    environment: "e2e",
    sendDefaultPii: false,
  });
  Sentry.setTag("suite", "ui-e2e");
  Sentry.addBreadcrumb({
    category: "ui",
    message: "clicked checkout",
    level: "info",
  });
  for (let i = 0; i < 3; i++) capture(() => checkoutFailure(i));
  capture(() => inventoryFailure());
  if (!(await Sentry.flush(15000))) throw new Error("Sentry flush timed out");
  await Sentry.close(2000);
}
