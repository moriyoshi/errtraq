import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const apiBase = process.env.VITE_ERRTRAQ_API_BASE ?? "";
/** Where the dev and preview servers proxy `/api/0` (same-origin deployments). */
const apiTarget = process.env.ERRTRAQ_API_TARGET ?? "http://127.0.0.1:8787";

/**
 * The CSP `<meta>` lives in index.html. A build fills in `connect-src` with the API base's origin;
 * the dev server removes the tag because HMR and the Solid refresh preamble need inline scripts.
 */
function csp(): Plugin {
  let serving = false;
  return {
    name: "errtraq-csp",
    configResolved(config) {
      serving = config.command === "serve";
    },
    transformIndexHtml(html) {
      if (serving)
        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
          "",
        );
      const origin = apiBase ? new URL(apiBase).origin : "";
      return html.replace("__ERRTRAQ_CONNECT_SRC__", origin).replace(" ;", ";");
    },
  };
}

const proxy = {
  "/api/0": { target: apiTarget, changeOrigin: false },
};

export default defineConfig({
  plugins: [solid(), csp()],
  server: { proxy },
  preview: { proxy },
  build: { target: "es2022", sourcemap: false },
});
