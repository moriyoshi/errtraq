import { createMDX } from "fumadocs-mdx/next";

// GitHub Pages serves a project site under /<repo>; set DOCS_BASE_PATH=/errtraq for that.
const basePath = process.env.DOCS_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default createMDX()(config);
