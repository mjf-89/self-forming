// core-self-update: app_update and app_install_apk (docs/plugins.md §9a A2). Essential
// Device test of the C5 handoff: 2026-10-15 (updates applied while helpers run; second run).
// built-in agent row, merged into the permanent extension "self-forming-native" (order
// 20). Also contributes the app's own self-rebuild skill (agent.skills; the workspace
// file self-forming/skills/self-rebuild/SKILL.md that SelfSource restores on every launch).
// Since C5 it also owns the app-update handoff (docs/plugins-providers-agent-core.md §C5):
// one createAppUpdateHandoff per session (keyed by its agent.harness@1 handle, so the
// bundled copy and the runtime copy share it), fed by app_update apply (staged), observing
// commits through host.harness.subscribeCommits, and calling host.appRevision.onStaged only
// for the exact successful tool result with the staged revision, deferred out of the
// commit observer. Stop clears it (host.harness.onStop), closing ends it (onClose). Never
// a Session API inside the observer, never an activation on a timeout.
// Consumed by core-agent-plugins.js. No library import at module evaluation.
import { createAppUpdateHandoff } from "../../../app-update-handoff.js";
import { recordStaged } from "../../../app-update-followup.js";

const NO_SHELL = "Offered only with the file and shell tools; this host has no execution environment.";
// Name and description equal the SKILL.md frontmatter.
export const SELF_REBUILD_SKILL = Object.freeze({ name: "self-rebuild", description: "Rebuild and reinstall Self Forming itself (native Kotlin + web) on this phone with the Android SDK", path: "self-forming/skills/self-rebuild/SKILL.md" });

const handoffs = new WeakMap(); // harness handle -> this session's staged(revision, call)
/**
 * The session's staged callback for app_update (self-update-tools.js selfUpdateTools), or
 * undefined without an app revision host or a harness handle (then nothing activates).
 * The commit subscription starts on the first staged call (app_update runs only while the
 * Harness is open; until a revision is staged the handoff ignores every commit anyway).
 */
export function appUpdateStaged(host) {
  const harness = host?.harness;
  if (!host?.appRevision || typeof harness?.subscribeCommits !== "function") return undefined;
  if (handoffs.has(harness)) return handoffs.get(harness);
  const appRevision = host.appRevision;
  const handoff = createAppUpdateHandoff((revision) => appRevision.onStaged?.(revision));
  let unsubscribe;
  let closed = false;
  const removeStop = harness.onStop?.(() => handoff.clear());
  harness.onClose?.(() => {
    closed = true;
    handoff.close();
    unsubscribe?.();
    unsubscribe = undefined;
    removeStop?.();
  });
  const staged = (revision, call) => {
    if (closed) return;
    recordStaged(revision, call); // survives the reload: the follow-up input after it (app-update-followup.js)
    if (!unsubscribe) unsubscribe = harness.subscribeCommits(handoff.committed);
    handoff.stage(revision, call);
  };
  handoffs.set(harness, staged);
  return staged;
}

export const row = Object.freeze({
  extension: "self-forming-native", order: 20,
  unavailable: (caps) => !caps.executionEnv ? NO_SHELL
    : caps.editableApp || caps.apkInstall ? undefined : "This host offers neither editable app revisions nor APK installation.",
  tools: (caps) => [...caps.editableApp ? ["app_update"] : [], ...caps.apkInstall ? ["app_install_apk"] : []],
  skills: (caps) => caps.editableApp || caps.apkInstall ? [SELF_REBUILD_SKILL] : [],
  load: () => import("./self-update-tools.js"),
  create: (builders, host) => host.env ? builders.selfUpdateTools({ appRevision: host.appRevision, staged: appUpdateStaged(host), apkInstaller: host.apkInstaller }) : null
});
