import { serve } from "@hono/node-server";

export interface ServerOptions {
  /** Cloud Run sets `PORT`; the default is only for running a bundle by hand. */
  port?: number;
  hostname?: string;
}
/** Start the HTTP server of a Cloud Run container (all interfaces: the container network). */
export function createServer(
  fetchHandler: (request: Request) => Response | Promise<Response>,
  environment: Readonly<Record<string, string | undefined>>,
  options: ServerOptions = {},
): { close(): Promise<void>; port: number } {
  const raw = options.port ?? Number(environment.PORT ?? 8080);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535)
    throw new Error("Invalid PORT");
  const server = serve({
    fetch: fetchHandler,
    port: raw,
    hostname: options.hostname ?? "0.0.0.0",
  });
  return {
    port: raw,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
