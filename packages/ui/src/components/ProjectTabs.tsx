import { Link } from "@tanstack/solid-router";

/** Issues, releases and settings of one project. */
export function ProjectTabs(props: {
  org: string;
  project: string;
  current: "issues" | "releases" | "settings";
}) {
  const params = () => ({ org: props.org, project: props.project });
  const tab = (name: "issues" | "releases" | "settings") => ({
    role: "tab" as const,
    "aria-selected": props.current === name,
    classList: { active: props.current === name },
  });
  return (
    <div class="tabs project-tabs" role="tablist" aria-label="Project">
      <Link to="/$org/$project/issues" params={params()} {...tab("issues")}>
        Issues
      </Link>
      <Link to="/$org/$project/releases" params={params()} {...tab("releases")}>
        Releases
      </Link>
      <Link to="/$org/$project/settings" params={params()} {...tab("settings")}>
        Settings
      </Link>
    </div>
  );
}
