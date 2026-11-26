import { z } from "zod";

/**
 * Response shapes. They are deliberately lenient: every field outside the identifying ones is
 * optional, unknown keys are kept out, and event payload sections are parsed separately at render
 * time (see `entries.ts`) so one malformed section never blanks the page. The same schemas must
 * accept Sentry and GlitchTip responses, which carry more fields than errtraq's.
 */

const optionalString = z.string().nullish();

export const organizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const projectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  organization: organizationSchema.optional(),
});
export type Project = z.infer<typeof projectSchema>;

export const capabilitiesSchema = z.object({
  textSearch: z.boolean().default(false),
  lastSeenRangeOnOtherSort: z.boolean().default(false),
  archive: z.boolean().default(false),
  issueStats: z.boolean().default(false),
  tagFacets: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** `GET /api/0/`: the token's scopes plus errtraq's capability extension (absent elsewhere). */
export const whoamiSchema = z.object({
  auth: z.object({ scopes: z.array(z.string()).optional() }).nullish(),
  errtraq: z
    .object({ capabilities: capabilitiesSchema.partial().optional() })
    .optional(),
});

export const issueStatusSchema = z.enum(["unresolved", "resolved", "ignored"]);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

export const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  culprit: optionalString,
  level: optionalString,
  type: optionalString,
  // Other servers know more statuses (muted, reprocessing); keep them as text.
  status: z.string(),
  count: z.union([z.string(), z.number()]).transform(String),
  firstSeen: optionalString,
  lastSeen: optionalString,
  platform: optionalString,
  project: z
    .object({ id: z.string(), name: z.string(), slug: z.string() })
    .optional(),
});
export type Issue = z.infer<typeof issueSchema>;

const releaseSchema = z.union([
  z.string(),
  z.object({ version: z.string() }).transform((r) => r.version),
]);

export const eventSchema = z.object({
  id: z.string(),
  eventID: z.string(),
  groupID: optionalString,
  title: optionalString,
  message: optionalString,
  culprit: optionalString,
  platform: optionalString,
  dateCreated: optionalString,
  dateReceived: optionalString,
  // `data` is validated per entry type when rendered.
  entries: z
    .array(z.object({ type: z.string(), data: z.unknown() }))
    .default([]),
  tags: z
    .array(
      z.object({
        key: z.string(),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .transform((v) => (v === null ? "" : String(v))),
      }),
    )
    .default([]),
  user: z
    .object({
      id: optionalString,
      email: optionalString,
      username: optionalString,
      ip_address: optionalString,
    })
    .loose()
    .nullish(),
  release: releaseSchema.nullish(),
  environment: optionalString,
  contexts: z.record(z.string(), z.unknown()).nullish(),
  sdk: z.record(z.string(), z.unknown()).nullish(),
  extra: z.record(z.string(), z.unknown()).nullish(),
  previousEventID: optionalString,
  nextEventID: optionalString,
});
export type ErrtraqEvent = z.infer<typeof eventSchema>;

export const organizationsSchema = z.array(organizationSchema);
export const projectsSchema = z.array(projectSchema);
export const issuesSchema = z.array(issueSchema);
export const eventsSchema = z.array(eventSchema);
