/** Secrets Manager secret names; the same rule the bootstrap secret handling enforces. */
export const BOOTSTRAP_SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
/** Delivered to the bootstrap function by the module; no other function receives it. */
export const BOOTSTRAP_SECRET_ENV = "ERRTRAQ_BOOTSTRAP_SECRET_NAME";
