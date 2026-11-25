import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "errtraq", template: "%s | errtraq" },
  description:
    "A Sentry-compatible, serverless-first issue tracker with pluggable storage, queues and compute.",
};

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          search={{
            options: { type: "static", api: `${basePath}/api/search` },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
