import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/solid-query";
import { RouterProvider } from "@tanstack/solid-router";
import { render } from "solid-js/web";
import { isApiError } from "./api/errors";
import { proxyUnauthorized } from "./auth/app";
import { authMode } from "./auth/config";
import { setUnauthorizedHandler } from "./auth/session";
import { router } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  queryCache: new QueryCache(),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Auth and lookup failures will not fix themselves; transient ones get one more try.
      retry: (count, error) =>
        count < 2 &&
        !(
          isApiError(error) &&
          [
            "unauthorized",
            "forbidden",
            "notFound",
            "badRequest",
            "parse",
          ].includes(error.kind)
        ),
    },
  },
});

// A 401 anywhere drops the token and every cached response, then returns to the login page
// (in proxy mode the page is reloaded instead, so the proxy can sign the user in again).
setUnauthorizedHandler(() => {
  queryClient.clear();
  if (authMode === "proxy") proxyUnauthorized();
  else void router.navigate({ to: "/login" });
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  ),
  root,
);
