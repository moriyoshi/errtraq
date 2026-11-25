import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const revalidate = false;

// Exported at build time as a static JSON index; the browser searches it locally.
export const { staticGET: GET } = createFromSource(source);
