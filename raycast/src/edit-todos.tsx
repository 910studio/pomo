import {
  List,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  confirmAlert,
  Alert,
  useNavigation,
  open,
  closeMainWindow,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
  listProjects,
  readNote,
  deleteProject,
  renameProject,
  getActive,
  requestOpenInPomo,
  requestNewInPomo,
} from "./notes";

const POMO_APP = "/Applications/pomo.app";

// Pop a project open in the pomo widget itself (where the editing happens).
async function openProjectInPomo(project: string) {
  requestOpenInPomo(project);
  await open(POMO_APP);
  await closeMainWindow();
}

// Open pomo straight into "name a new project" mode.
async function newProjectInPomo() {
  requestNewInPomo();
  await open(POMO_APP);
  await closeMainWindow();
}

export default function PomoTodos() {
  const [projects, setProjects] = useState<string[]>([]);
  const [active, setActiveState] = useState("");

  function refresh() {
    setProjects(listProjects());
    setActiveState(getActive());
  }
  useEffect(refresh, []);

  const newAction = (
    <Action
      title="New Project in Pomo"
      icon={Icon.NewDocument}
      shortcut={{ modifiers: ["cmd"], key: "n" }}
      onAction={newProjectInPomo}
    />
  );

  return (
    <List searchBarPlaceholder="Pick a project to open in pomo…">
      <List.EmptyView
        title="No project notes yet"
        description="Create one — opens in the pomo widget"
        actions={<ActionPanel>{newAction}</ActionPanel>}
      />
      {projects.map((p) => {
        const isActive = p === active;
        const openCount = readNote(p)
          .split("\n")
          .filter((l) => /^\s*-\s*\[ \]/.test(l)).length;
        return (
          <List.Item
            key={p}
            icon={isActive ? { source: Icon.Eye, tintColor: Color.Magenta } : Icon.Circle}
            title={p}
            accessories={[
              { tag: { value: `${openCount} open`, color: openCount ? Color.Orange : Color.SecondaryText } },
              ...(isActive ? [{ text: "in widget" }] : []),
            ]}
            actions={
              <ActionPanel>
                <Action title="Open in Pomo" icon={Icon.Eye} onAction={() => openProjectInPomo(p)} />
                {newAction}
                <Action.Push
                  title="Rename…"
                  icon={Icon.Text}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  target={<RenameProject name={p} onDone={refresh} />}
                />
                <Action
                  title="Delete Project"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={async () => {
                    const ok = await confirmAlert({
                      title: `Delete "${p}"?`,
                      message: "Removes the project and its todos.",
                      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
                    });
                    if (ok) {
                      deleteProject(p);
                      refresh();
                    }
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

// Rename only needs a name — the one bit of typing that isn't a todo.
function RenameProject({ name, onDone }: { name: string; onDone: () => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Rename"
            icon={Icon.Check}
            onSubmit={(v: { project: string }) => {
              const next = v.project.trim();
              if (!next) {
                showToast({ style: Toast.Style.Failure, title: "Name required" });
                return;
              }
              renameProject(name, next);
              onDone();
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="project" title="Rename project" defaultValue={name} />
    </Form>
  );
}
