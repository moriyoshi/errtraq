/** Origins the production CSP `connect-src` lists besides `'self'`. */
export function connectSources(options: {
  apiBase?: string;
  oidcIssuer?: string;
  /** Extra origins, space or comma separated (a Cognito domain, a token endpoint host). */
  oidcConnectSrc?: string;
}): string[] {
  const origins: string[] = [];
  const add = (value: string, label: string) => {
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new Error(`${label} is not a URL: ${value}`);
    }
    if (origin === "null") throw new Error(`${label} has no origin: ${value}`);
    if (!origins.includes(origin)) origins.push(origin);
  };
  if (options.apiBase) add(options.apiBase, "VITE_ERRTRAQ_API_BASE");
  if (options.oidcIssuer) add(options.oidcIssuer, "VITE_ERRTRAQ_OIDC_ISSUER");
  for (const extra of (options.oidcConnectSrc ?? "").split(/[\s,]+/))
    if (extra) add(extra, "VITE_ERRTRAQ_OIDC_CONNECT_SRC");
  return origins;
}
