import { createRouter } from "@tanstack/solid-router";
import { parseSearch, stringifySearch } from "./lib/search";
import { callbackRoute } from "./routes/callback";
import {
  issueEventRoute,
  issueEventsRoute,
  issueRoute,
  issueTagRoute,
} from "./routes/issue";
import { issuesRoute } from "./routes/issues";
import { loginRoute } from "./routes/login";
import { organizationsRoute, projectsRoute } from "./routes/organizations";
import { releaseRoute, releasesRoute } from "./routes/releases";
import { authedRoute, indexRoute, rootRoute } from "./routes/root";
import { settingsRoute } from "./routes/settings";

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  callbackRoute,
  authedRoute.addChildren([
    organizationsRoute,
    projectsRoute,
    issuesRoute,
    releasesRoute,
    releaseRoute,
    settingsRoute,
    issueRoute.addChildren([issueEventRoute, issueEventsRoute, issueTagRoute]),
  ]),
]);

export const router = createRouter({
  routeTree,
  parseSearch,
  stringifySearch,
  defaultPreload: "intent",
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
