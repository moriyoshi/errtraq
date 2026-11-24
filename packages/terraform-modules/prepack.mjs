import { cp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// infra/modules stays canonical; the package ships a copy of each provider's modules without tests.
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../../infra/modules");
for (const provider of await readdir(source, { withFileTypes: true })) {
  if (!provider.isDirectory()) continue;
  const target = join(here, provider.name);
  await rm(target, { recursive: true, force: true });
  for (const module of await readdir(join(source, provider.name), {
    withFileTypes: true,
  }))
    if (module.isDirectory())
      await cp(
        join(source, provider.name, module.name),
        join(target, module.name),
        {
          recursive: true,
          filter: (path) => {
            const name = path.split(/[\\/]/).pop() ?? "";
            return (
              name !== "tests" &&
              !name.endsWith(".tftest.hcl") &&
              !name.startsWith(".terraform") &&
              !name.startsWith("terraform.tfstate")
            );
          },
        },
      );
}
