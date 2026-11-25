/** An id that is a 64-bit integer on the wire; numbers only when exactly representable. */
export type LongId = string | number | bigint;
export type Namespace = readonly string[];
export type Properties = Record<string, string>;

export interface CatalogConfig {
  defaults: Properties;
  overrides: Properties;
  endpoints?: string[];
}

export interface IcebergSnapshot {
  "snapshot-id": string | number;
  "parent-snapshot-id"?: string | number | null;
  "sequence-number"?: number;
  "timestamp-ms": number;
  "manifest-list"?: string;
  summary?: Record<string, string>;
  [key: string]: unknown;
}
export interface IcebergSnapshotRef {
  "snapshot-id": string | number;
  type: "branch" | "tag";
  "min-snapshots-to-keep"?: number;
  "max-snapshot-age-ms"?: number;
  "max-ref-age-ms"?: number;
}
/** The fields errtraq reads; the rest of the metadata is passed through untouched. */
export interface TableMetadata {
  "format-version": number;
  "table-uuid": string;
  location?: string;
  "current-snapshot-id"?: string | number | null;
  snapshots?: IcebergSnapshot[];
  refs?: Record<string, IcebergSnapshotRef>;
  properties?: Properties;
  [key: string]: unknown;
}
export interface LoadTableResult {
  "metadata-location"?: string;
  metadata: TableMetadata;
  config?: Properties;
}

export type TableRequirement =
  | { type: "assert-create" }
  | { type: "assert-table-uuid"; uuid: string }
  | {
      type: "assert-ref-snapshot-id";
      ref: string;
      "snapshot-id": LongId | null;
    }
  | { type: "assert-last-assigned-field-id"; "last-assigned-field-id": number }
  | { type: "assert-current-schema-id"; "current-schema-id": number }
  | {
      type: "assert-last-assigned-partition-id";
      "last-assigned-partition-id": number;
    }
  | { type: "assert-default-spec-id"; "default-spec-id": number }
  | { type: "assert-default-sort-order-id"; "default-sort-order-id": number };

/** The only table updates errtraq itself issues; the engine writes data on its own. */
export type TableUpdate =
  | { action: "set-properties"; updates: Properties }
  | { action: "remove-snapshots"; "snapshot-ids": readonly LongId[] }
  | {
      action: "set-snapshot-ref";
      "ref-name": string;
      type: "branch" | "tag";
      "snapshot-id": LongId;
      "min-snapshots-to-keep"?: number;
      "max-snapshot-age-ms"?: number;
      "max-ref-age-ms"?: number;
    };

export interface CommitTableRequest {
  requirements: readonly TableRequirement[];
  updates: readonly TableUpdate[];
}
export interface CommitTableResult {
  "metadata-location": string;
  metadata: TableMetadata;
}

export interface CreateTableRequest {
  name: string;
  /** An Iceberg schema object (`{ type: "struct", fields: [...] }`). */
  schema: Record<string, unknown>;
  location?: string;
  "partition-spec"?: Record<string, unknown>;
  "write-order"?: Record<string, unknown>;
  "stage-create"?: boolean;
  properties?: Properties;
}
