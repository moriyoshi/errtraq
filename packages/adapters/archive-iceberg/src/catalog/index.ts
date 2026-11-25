export type {
  AwsCredentialsValue,
  CatalogAuth,
  SecretValue,
} from "./auth.js";
export {
  encodeNamespace,
  IcebergRestCatalog,
  type IcebergRestCatalogOptions,
} from "./client.js";
export * from "./errors.js";
export { longString, parseJsonPreservingLongs } from "./json.js";
export type * from "./types.js";
