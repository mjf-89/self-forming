// apps/on-device/attachment-composer.js
import { createAttachmentCard } from "./attachment-view.js";
function initAttachmentComposer({ onPick, onFiles, onRemove, onError = () => {
} }) {
  const element = (id) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing attachment control: ${id}`);
    return found;
  };
  const composer = element("composer");
  const list = element("composer-attachments");
  const controls = [
    { kind: "files", button: element("attach-files"), input: element("attachment-files-input") },
    { kind: "images", button: element("attach-images"), input: element("attachment-images-input") }
  ];
  let disabled = true;
  let previous;
  const reportError = (error) => onError(error instanceof Error ? error : new Error(String(error)));
  for (const { kind, button, input } of controls) {
    button.addEventListener("click", () => {
      if (disabled) return;
      try {
        if (onPick?.(kind) === false) return;
        input.click();
      } catch (error) {
        reportError(error);
      }
    });
    input.addEventListener("change", () => {
      const files = [...input.files ?? []];
      input.value = "";
      if (!files.length) return;
      Promise.resolve().then(() => onFiles(files, kind)).catch(reportError);
    });
  }
  return {
    update(attachments = [], { disabled: unavailable = false, busy = false } = {}) {
      disabled = Boolean(unavailable || busy);
      for (const { button } of controls) button.disabled = disabled;
      list.setAttribute("aria-busy", String(Boolean(busy)));
      const current = attachments.filter((attachment) => attachment && typeof attachment === "object");
      const equal = previous?.length === current.length && current.every((attachment, index) => {
        const old = previous[index];
        return ["id", "name", "mimeType", "size", "kind", "path", "data"].every((key) => old[key] === attachment[key]);
      });
      if (!equal) {
        list.replaceChildren(...current.map((attachment) => createAttachmentCard(document, attachment, {
          compact: true,
          disabled,
          onRemove: (id) => Promise.resolve().then(() => onRemove(id)).catch(reportError)
        })));
        previous = current.map((attachment) => ({ ...attachment }));
      } else for (const button of list.querySelectorAll(".attachment-remove")) button.disabled = disabled;
      list.hidden = !current.length;
      composer.classList.toggle("has-attachments", current.length > 0);
    },
    clearInputs() {
      for (const { input } of controls) input.value = "";
    }
  };
}
export {
  initAttachmentComposer
};
