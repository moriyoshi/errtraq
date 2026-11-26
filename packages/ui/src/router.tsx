import { createRouter } from "@tanstack/solid-router";
import { parseSearch, stringifySearch } from "./lib/search";
import {
  issueEventRoute,
  issueEventsRoute,
  issueRoute,
  issueTagRoute,
} from "./routes/issue";
import { issuesRoute } from "./routes/issues";
import { loginRoute } from "./routes/login";
import { organizationsRoute, projectsRoute } from "./routes/organizations";
import { authedRoute, indexRoute, rootRoute } from "./routes/root";

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  authedRoute.addChildren([
    organizationsRoute,
    projectsRoute,
    issuesRoute,
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
