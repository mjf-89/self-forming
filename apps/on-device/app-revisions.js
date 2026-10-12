// apps/on-device/app-revisions.js
function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing app editing control: ${id}`);
  return found;
}
function createSessionCloser(saveDraft) {
  let failedClose;
  return {
    close(current, previous = Promise.resolve()) {
      const work = (async () => {
        let draftFailure;
        try { await saveDraft(current); } catch (cause) { draftFailure = { cause }; }
        try { await current.close(); } catch (cause) { failedClose = { cause }; throw cause; }
        if (draftFailure) throw draftFailure.cause;
      })();
      // A rejected earlier transition must not release the queue while storage is still closing.
      const result = Promise.allSettled([previous, work]).then((outcomes) => {
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure) throw failure.reason;
      });
      // Keep failure visible to the caller without poisoning the next lifecycle transition.
      return { result, settled: result.catch(() => {}) };
    },
    assertCanOpen() {
      // An unsuccessful close may still own SQLite. Only a fresh page can safely recover that owner.
      if (failedClose) throw failedClose.cause;
    }
  };
}
function createAppRevisions(options) {
  const panel = element("app-editing");
  const status = element("app-revision-status");
  const source = element("app-source-path");
  const apply = element("app-apply");
  const previous = element("app-previous");
  const original = element("app-original");
  let info;
  let reading = 0;
  let applying = false;
  let queued;
  panel.hidden = false;
  const readInfo = () => options.bridge.call("app.info");
  const stage = () => options.bridge.call("app.stage");
  function controls() {
    const disabled = applying || options.unavailable() || !options.getSession() || Boolean(options.getSession()?.snapshot.busy);
    apply.disabled = disabled || !info;
    previous.disabled = disabled || !info?.previousRevision;
    original.disabled = disabled || !info || info.revision === "bundled";
  }
  async function sessionOpened(current) {
    const id = ++reading;
    try {
      const result = await readInfo();
      if (id !== reading || options.getSession() !== current || applying) return;
      info = result;
      source.textContent = result.sourcePath;
      status.textContent = `${result.revision === "bundled" ? "Original app" : `Revision ${result.revision}`} \xB7 host ${result.hostVersion}${result.notice ? `
${result.notice}` : ""}`;
      await options.bridge.call("app.ready", { revision: result.revision });
    } catch (cause) {
      if (id === reading && options.getSession() === current) status.textContent = `App editing unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      controls();
    }
  }
  async function activate(action, revision, expected, committed = false) {
    const current = options.getSession();
    if (!current || expected && current !== expected || applying || options.unavailable() || !committed && current.snapshot.busy) return;
    applying = true;
    options.setApplying(true);
    controls();
    panel.open = true;
    status.textContent = action === "apply" ? "Saving an app revision\u2026" : "Restoring the selected app\u2026";
    try {
      const candidate = action === "apply" ? revision ?? (await stage()).revision : void 0;
      if (options.getSession() !== current) throw new Error("The app was backgrounded before changes could be applied. Return and apply again.");
      status.textContent = "Closing the saved conversation, then reloading\u2026";
      // Closing checkpoints interrupted work and releases storage; activation must wait for that to finish.
      await options.closeSession(current);
      if (candidate) await options.bridge.call("app.activate", { revision: candidate });
      else await options.bridge.call("app.restore", { target: action });
      status.textContent = "Reloading the app\u2026";
      window.location.reload();
    } catch (cause) {
      applying = false;
      options.setApplying(false);
      status.textContent = "Changes were not applied. Your editable files are still available.";
      options.reportError(cause);
      options.reopen();
      controls();
    }
  }
  apply.addEventListener("click", () => {
    void activate("apply");
  });
  previous.addEventListener("click", () => {
    void activate("previous");
  });
  original.addEventListener("click", () => {
    void activate("original");
  });
  controls();
  return {
    info: readInfo,
    stage,
    controls,
    sessionOpened,
    sessionClosed() {
      reading++;
      // Keep a staged revision queued across session close/reopen (backgrounding); it applies on the next session.
      controls();
    },
    pending: () => Boolean(queued),
    queue(current, revision) {
      // The session emits this only after the updating tool's result is durably committed.
      if (options.getSession() === current) queued = { revision };
    },
    async applyQueued(current) {
      if (!queued || !current || options.getSession() !== current) return;
      // Other replies, including the one being viewed, resume from their saved checkpoints after reload.
      // Foreground, sign-in and UI-operation guards still apply to this committed update.
      if (applying || options.unavailable()) return;
      const revision = queued.revision;
      queued = void 0;
      await activate("apply", revision, current, true);
    }
  };
}
export {
  createAppRevisions,
  createSessionCloser
};
