import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { sourceBranch, targetBranches } from "../lib/branch-metadata.ts"
import { loadShip } from "../lib/ship-settings.ts"
import { shipWorktree } from "../lib/ship.ts"
import type { Modal, ModalFocus } from "./modal-model.ts"
import type { TreeRow } from "./workspace.ts"

export function createShipWorkflow(options: {
  home: () => string
  mainPath: () => string | null
  selectedTree: () => TreeRow | null
  busy: Accessor<boolean>
  setBusy: Setter<boolean>
  setStatus: Setter<string>
  modal: Accessor<Modal | null>
  setModal: Setter<Modal | null>
  setModalFocus: Setter<ModalFocus>
  show: (modal: Modal) => void
  refresh: () => Promise<void>
}) {
  const [shipping, setShipping] = createSignal<{ path: string; text: string } | null>(null)
  let request: AbortController | undefined
  onCleanup(() => request?.abort())
  function openShip() {
    const tree = options.selectedTree()
    if (options.busy() || !tree?.branch) return
    try {
      const branches = targetBranches(tree.path, tree.branch)
      const source = sourceBranch(tree.path, tree.branch, branches)
      options.show({ kind: "ship", tree, branches, source: source?.branch ?? "", evidence: source?.evidence })
      options.setModalFocus("source")
    } catch (error) { options.setStatus(error instanceof Error ? error.message : String(error)) }
  }
  async function startShip() {
    const current = options.modal()
    if (options.busy() || current?.kind !== "ship") return
    if (!current.source || !current.branches.includes(current.source)) {
      options.setModal({ ...current, error: "Choose a target branch" })
      return
    }
    let settings
    try { settings = loadShip(options.home()) }
    catch (error) {
      options.setModal({ ...current, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const controller = new AbortController()
    request = controller
    options.setModal(null)
    options.setBusy(true)
    options.setStatus("")
    setShipping({ path: current.tree.path, text: "" })
    try {
      const pr = await shipWorktree({ tree: current.tree, mainPath: options.mainPath() ?? undefined, base: current.source, settings, signal: controller.signal,
        onProgress: (text) => { setShipping({ path: current.tree.path, text }) },
      })
      options.setStatus(`shipped ${current.tree.branch} · #${pr.number}`)
    } catch (error) {
      options.setStatus(controller.signal.aborted ? "Ship cancelled; completed commits and changes kept" : error instanceof Error ? error.message : String(error))
    } finally {
      request = undefined
      setShipping(null)
      await options.refresh()
      options.setBusy(false)
    }
  }
  return { shipping, openShip, startShip, abortShip: () => request?.abort() }
}
