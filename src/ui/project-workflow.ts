import type { Accessor, Setter } from "solid-js"
import { addProject, removeProject } from "../lib/config.ts"
import type { Project } from "../lib/types.ts"
import type { Modal } from "./modal-model.ts"

export function createProjectWorkflow(options: {
  home: () => string
  workspace: {
    selectedProject: () => Project | null
    setSelectedProjectId: Setter<string | null>
    refresh: () => Promise<void>
  }
  dialog: {
    setModal: Setter<Modal | null>
    show: (next: Modal) => void
  }
  operation: {
    busy: Accessor<boolean>
    setStatus: Setter<string>
    run: (label: string, fn: () => string | void | Promise<string | void>) => Promise<void>
  }
}) {
  const { workspace, dialog, operation } = options

  function openAddProject() {
    if (operation.busy()) return
    dialog.show({ kind: "add-project", value: "" })
  }

  function openUnregister() {
    if (operation.busy()) return
    if (!workspace.selectedProject()) {
      operation.setStatus("no project selected")
      return
    }
    dialog.show({ kind: "unregister" })
  }

  function submitAddProject(value: string) {
    if (!value) throw new Error("path required")
    const project = addProject(options.home(), value)
    workspace.setSelectedProjectId(project.id)
    dialog.setModal(null)
    void workspace.refresh()
    operation.setStatus(`added ${project.name}`)
  }

  function unregister() {
    const project = workspace.selectedProject()
    if (!project) return
    void operation.run("unregistering", () => {
      removeProject(options.home(), project.id)
      return `unregistered ${project.name}`
    })
    dialog.setModal(null)
  }

  return { openAddProject, openUnregister, submitAddProject, unregister }
}
