import { currentBranch, readConfig, resolveRef } from "./project.js";
import { readStates, type StateList } from "./states.js";

export interface Overview extends StateList {
  project: string;
  /** Live and the branch, resolved from git refs on this call. */
  live: { ref: string; commit: string | null };
  branch: { name: string | null; commit: string | null };
}

/** What `flowmap states` and the `flowmap_states` tool report. */
export function overview(root: string): Overview {
  const config = readConfig(root);
  return {
    project: config.name,
    live: { ref: config.liveRef, commit: resolveRef(root, config.liveRef) },
    branch: { name: currentBranch(root), commit: resolveRef(root, "HEAD") },
    ...readStates(root)
  };
}
