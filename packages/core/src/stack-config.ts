import { z } from "zod";
import {
  type EnvRef,
  isEnvRef,
  isVariableRef,
  type VariableRef,
} from "./stack-model.js";

/** Config references resolve from the runtime environment, or from TF_VAR values at runtime. */
export function configReference<T extends z.ZodType>(schema: T) {
  return z.union([
    z.custom<EnvRef | VariableRef>(
      (value) =>
        isVariableRef(value) || (isEnvRef(value) && value.phase === "runtime"),
    ),
    schema,
  ]);
}
