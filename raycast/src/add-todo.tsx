import { showHUD, LaunchProps } from "@raycast/api";
import { appendTodo, getActive, listProjects } from "./notes";

export default async function AddTodo(
  props: LaunchProps<{ arguments: { text: string; project?: string } }>,
) {
  const text = (props.arguments.text ?? "").trim();
  if (!text) {
    await showHUD("Nothing to add");
    return;
  }

  const target = (props.arguments.project ?? "").trim();
  let project = target || getActive();

  if (!project) {
    await showHUD("No project yet — make one in “Edit Pomo Todos”");
    return;
  }
  // if they named a target that doesn't exist, tell them instead of silently creating
  if (target && !listProjects().includes(target)) {
    await showHUD(`No project “${target}” — create it first`);
    return;
  }

  appendTodo(project, text);
  await showHUD(`🍅 ${project}: ${text}`);
}
