/** A wildcard listen address is not a connectable DSN host. */
export function dsnHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]")
    return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Prefer an explicitly configured public origin; wildcard listeners otherwise use localhost. */
export function dsnOrigin(
  host: string,
  port: number,
  publicUrl?: string,
): { origin: string; fallback: boolean } {
  if (publicUrl) return { origin: new URL(publicUrl).origin, fallback: false };
  const displayHost = dsnHost(host);
  return {
    origin: `http://${displayHost}:${port}`,
    fallback: displayHost === "localhost" && host !== "localhost",
  };
}

export function buildSummary(
  name: string,
  directory: string,
  platform: string,
  artifactCount: number,
): string {
  return platform === "standalone"
    ? `Built ${name} in ${directory}: bundle ${directory}/shared/index.mjs and Dockerfile ${directory}/Dockerfile`
    : `Built ${name} in ${directory} (${artifactCount} deployable artifacts)`;
}
