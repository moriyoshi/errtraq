/**
 * The GCP example stacks take the project and the region from the environment, with no default
 * (GCP_PLAN D7, D8): an unset value stops the generator instead of picking a place for you.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Set ${name}: the GCP example stacks have no default project or region`,
    );
  return value;
}
/** Stack variable that carries the container image reference (`name@sha256:...`). */
export const IMAGE_VARIABLE = "CLOUD_RUN_IMAGE";
