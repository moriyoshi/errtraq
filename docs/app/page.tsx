import Link from "next/link";

// Static export cannot issue a server redirect, so render a plain landing link plus a
// relative meta refresh that works under any basePath.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <meta httpEquiv="refresh" content="0; url=docs/" />
      <h1 className="text-3xl font-bold">errtraq</h1>
      <p>A Sentry-compatible, serverless-first issue tracker.</p>
      <Link className="underline" href="/docs">
        Read the documentation
      </Link>
    </main>
  );
}
