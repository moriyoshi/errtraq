import { Crc32c } from "./crc32c.js";

export interface FakeObject {
  bytes: Uint8Array;
  contentType: string;
}
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array;
}
/** In-memory subset of the GCS JSON API, enough for the adapter's wire behaviour. */
export class FakeGcs {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: FakeRequest[] = [];
  readonly sessions = new Map<
    string,
    { name: string; contentType: string; received: Uint8Array[]; size: number }
  >();
  /** Return a response to short-circuit a request (fault injection). */
  intercept?: (request: FakeRequest) => Response | undefined;
  /** Corrupt the advertised CRC32C of downloads. */
  corruptCrc = false;
  private nextSession = 1;
  constructor(readonly bucket = "test-bucket") {}
  private error(status: number, message: string, reason: string) {
    return new Response(
      JSON.stringify({
        error: { code: status, message, errors: [{ reason }] },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  }
  private json(value: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(value), {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body =
      init?.body === undefined || init?.body === null
        ? new Uint8Array()
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : (init.body as Uint8Array);
    const request: FakeRequest = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body,
    };
    this.requests.push(request);
    return this.handle(request);
  };
  private handle(request: FakeRequest): Response {
    const injected = this.intercept?.(request);
    if (injected) return injected;
    const { url, method } = request;
    const upload = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/);
    if (upload) return this.handleUpload(upload[1] as string, request);
    const objects = url.pathname.match(
      /^\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/,
    );
    if (!objects) return this.error(404, "Not found", "notFound");
    if (decodeURIComponent(objects[1] as string) !== this.bucket)
      return this.error(
        404,
        "The specified bucket does not exist.",
        "notFound",
      );
    const name =
      objects[2] === undefined ? undefined : decodeURIComponent(objects[2]);
    if (name === undefined) return this.list(url);
    const object = this.objects.get(name);
    if (method === "DELETE") {
      if (!object)
        return this.error(
          404,
          `No such object: ${this.bucket}/${name}`,
          "notFound",
        );
      this.objects.delete(name);
      return new Response(null, { status: 204 });
    }
    if (!object)
      return this.error(
        404,
        `No such object: ${this.bucket}/${name}`,
        "notFound",
      );
    if (url.searchParams.get("alt") !== "media")
      return this.json({
        name,
        size: String(object.bytes.length),
        contentType: object.contentType,
      });
    const crc = new Crc32c();
    crc.update(object.bytes);
    const hash = this.corruptCrc ? "AAAAAA==" : crc.digestBase64();
    const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range)
      return new Response(object.bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          "content-length": String(object.bytes.length),
          "x-goog-hash": `crc32c=${hash}`,
        },
      });
    const start = Number(range[1]);
    if (start >= object.bytes.length)
      return this.error(
        416,
        "Range Not Satisfiable",
        "requestedRangeNotSatisfiable",
      );
    const end = Math.min(
      range[2] ? Number(range[2]) : Number.POSITIVE_INFINITY,
      object.bytes.length - 1,
    );
    const part = object.bytes.slice(start, end + 1);
    return new Response(part, {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end}/${object.bytes.length}`,
        "content-length": String(part.length),
      },
    });
  }
  private list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const max = Number(url.searchParams.get("maxResults") ?? 1000);
    const token = url.searchParams.get("pageToken");
    const after = token ? atob(token.replace(/^t/, "")) : undefined;
    const encoder = new TextEncoder();
    const compare = (a: string, b: string) => {
      const x = encoder.encode(a),
        y = encoder.encode(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++)
        if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
      return x.length - y.length;
    };
    const names = [...this.objects.keys()]
      .filter((n) => n.startsWith(prefix))
      .sort(compare)
      .filter(
        (n) =>
          after === undefined ||
          compare(n, decodeURIComponent(escape(after))) > 0,
      );
    const page = names.slice(0, max);
    const more = names.length > max;
    const last = page.at(-1);
    return this.json({
      items: page.map((name) => ({ name })),
      ...(more && last !== undefined
        ? { nextPageToken: `t${btoa(unescape(encodeURIComponent(last)))}` }
        : {}),
    });
  }
  private handleUpload(bucket: string, request: FakeRequest): Response {
    const { url, method } = request;
    if (bucket !== this.bucket)
      return this.error(
        404,
        "The specified bucket does not exist.",
        "notFound",
      );
    const type = url.searchParams.get("uploadType");
    const id = url.searchParams.get("upload_id");
    if (type === "media") {
      const name = url.searchParams.get("name") as string;
      this.objects.set(name, {
        bytes: request.body.slice(),
        contentType:
          request.headers.get("content-type") ?? "application/octet-stream",
      });
      return this.json({ name, size: String(request.body.length) });
    }
    if (type === "resumable" && method === "POST") {
      const sid = `s${this.nextSession++}`;
      const meta = JSON.parse(new TextDecoder().decode(request.body));
      this.sessions.set(sid, {
        name: meta.name,
        contentType: request.headers.get("x-upload-content-type") ?? "",
        received: [],
        size: 0,
      });
      return new Response(null, {
        headers: {
          location: `${url.origin}/upload/storage/v1/b/${bucket}/o?uploadType=resumable&upload_id=${sid}`,
        },
      });
    }
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || !id)
      return this.error(404, "Invalid upload session", "notFound");
    if (method === "DELETE") {
      this.sessions.delete(id);
      return new Response(null, { status: 499 });
    }
    const range = request.headers.get("content-range") ?? "";
    const status = range.match(/^bytes \*\/(\*|\d+)$/);
    const data = range.match(/^bytes (\d+)-(\d+)\/(\*|\d+)$/);
    const persisted = () =>
      session.size === 0
        ? new Response(null, { status: 308 })
        : new Response(null, {
            status: 308,
            headers: { range: `bytes=0-${session.size - 1}` },
          });
    if (status && status[1] === "*") return persisted();
    if (status) return this.finish(session, id, Number(status[1]));
    if (!data) return this.error(400, "Bad Content-Range", "invalid");
    const start = Number(data[1]);
    if (start > session.size)
      return this.error(400, "Gap in upload", "invalid");
    const fresh = request.body.slice(session.size - start);
    session.received.push(fresh);
    session.size += fresh.length;
    if (data[3] === "*") return persisted();
    return this.finish(session, id, Number(data[3]));
  }
  private finish(
    session: {
      name: string;
      contentType: string;
      received: Uint8Array[];
      size: number;
    },
    id: string,
    total: number,
  ): Response {
    if (session.size !== total)
      return this.error(400, "Size mismatch", "invalid");
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of session.received) {
      bytes.set(part, at);
      at += part.length;
    }
    this.objects.set(session.name, {
      bytes,
      contentType: session.contentType || "application/octet-stream",
    });
    this.sessions.delete(id);
    return this.json({ name: session.name, size: String(total) });
  }
}
