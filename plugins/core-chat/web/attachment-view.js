// plugins/core-chat/web/attachment-view.js
var rasterTypes = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function attachmentImageSource(attachment) {
  if (attachment?.kind !== "image" || !rasterTypes.has(attachment.mimeType) || typeof attachment.data !== "string" || !attachment.data.length || attachment.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) return void 0;
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}
function attachmentSize(size) {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function icon(document, path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const drawing = document.createElementNS(svg.namespaceURI, "path");
  drawing.setAttribute("d", path);
  svg.append(drawing);
  return svg;
}
function createAttachmentCard(document, attachment, { compact = false, onRemove, disabled = false } = {}) {
  const card = document.createElement("div");
  card.className = `attachment-card ${compact ? "attachment-draft" : "attachment-sent"}`;
  card.dataset.attachmentId = String(attachment.id ?? "");
  const name = typeof attachment.name === "string" && attachment.name ? attachment.name : "Attached file";
  const source = attachmentImageSource(attachment);
  if (source) card.classList.add("attachment-image");
  const preview = document.createElement("div");
  preview.className = "attachment-preview";
  if (source) {
    const image = document.createElement("img");
    image.alt = name;
    image.decoding = "async";
    image.src = source;
    image.addEventListener("error", () => {
      image.remove();
      preview.append(icon(document, "M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M8 8h.01"));
    }, { once: true });
    preview.append(image);
  } else preview.append(icon(document, "M13 3H6v18h12V8zM13 3v5h5M9 12h6M9 16h6"));
  const copy = document.createElement("div");
  copy.className = "attachment-copy";
  const title = document.createElement("span");
  title.className = "attachment-name";
  title.textContent = name;
  title.title = name;
  const detail = document.createElement("span");
  detail.className = "attachment-detail";
  detail.textContent = [source ? "Image" : "File", attachmentSize(attachment.size)].filter(Boolean).join(" \xB7 ");
  if (typeof attachment.path === "string") card.title = `${name}
${attachment.path}`;
  copy.append(title, detail);
  card.append(preview, copy);
  if (onRemove) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "attachment-remove";
    button.disabled = disabled;
    button.setAttribute("aria-label", `Remove ${name}`);
    button.title = `Remove ${name}`;
    button.append(icon(document, "m7 7 10 10M17 7 7 17"));
    button.addEventListener("click", () => {
      if (!button.disabled) onRemove(attachment.id);
    });
    card.append(button);
  }
  return card;
}
export {
  attachmentImageSource,
  attachmentSize,
  createAttachmentCard
};
