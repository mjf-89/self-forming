// apps/on-device/chat-renderer.js
import { createAttachmentCard } from "./attachment-view.js";
var toolNames = {
  workspace_write: "Save file",
  workspace_read: "Read file",
  workspace_list: "Browse files",
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  bash: "Bash",
  app_update: "Update this app"
};
function node(document, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== void 0) element.textContent = text;
  return element;
}
function safeLink(value) {
  if (!/^(https?:\/\/|mailto:)/i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return void 0;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) return void 0;
    return url.href;
  } catch {
    return void 0;
  }
}
function linkEnd(text, from) {
  let depth = 1;
  for (let index = from; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "(") depth++;
    if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}
function inline(parent, text, depth = 0, links = true) {
  const document = parent.ownerDocument;
  if (depth >= 8) {
    parent.append(document.createTextNode(text));
    return;
  }
  let plain = "";
  const flush = () => {
    if (plain) {
      parent.append(document.createTextNode(plain));
      plain = "";
    }
  };
  for (let index = 0; index < text.length; ) {
    const character = text[index];
    if (character === "\\" && /[\\`*_{}\[\]()#+.!>-]/.test(text[index + 1] ?? "")) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (character === "`") {
      let width = 1;
      while (text[index + width] === "`") width++;
      const marker = "`".repeat(width);
      const end = text.indexOf(marker, index + width);
      if (end >= 0) {
        flush();
        parent.append(node(document, "code", "", text.slice(index + width, end).replace(/\n/g, " ")));
        index = end + width;
        continue;
      }
      plain += marker;
      index += width;
      continue;
    }
    if (text.startsWith("![", index) || character === "[") {
      const image = character === "!";
      const labelStart = index + (image ? 2 : 1);
      const labelEnd = text.indexOf("](", labelStart);
      const end = labelEnd >= 0 ? linkEnd(text, labelEnd + 2) : -1;
      if (end >= 0) {
        const href = !image && links ? safeLink(text.slice(labelEnd + 2, end).trim()) : void 0;
        if (href) {
          flush();
          const anchor = node(document, "a");
          anchor.href = href;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          inline(anchor, text.slice(labelStart, labelEnd), depth + 1, false);
          parent.append(anchor);
        } else plain += text.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      const marker = text.slice(index, index + 2);
      const end = text.indexOf(marker, index + 2);
      if (end > index + 2) {
        flush();
        const strong = node(document, "strong");
        inline(strong, text.slice(index + 2, end), depth + 1, links);
        parent.append(strong);
        index = end + 2;
        continue;
      }
    }
    plain += character;
    index++;
  }
  flush();
}
var fence = (line) => /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
var heading = (line) => /^ {0,3}(#{1,6})[\t ]+(.+)$/.exec(line);
var listItem = (line) => /^ {0,3}([-+*]|\d+[.)])[\t ]+(.*)$/.exec(line);
function blocks(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const result = [];
  for (let index = 0; index < lines.length; ) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    const code = fence(lines[index]);
    if (code) {
      const content = [];
      index++;
      const close = new RegExp(`^ {0,3}${code[1][0]}{${code[1].length},}[\\t ]*$`);
      while (index < lines.length && !close.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      result.push({ type: "code", text: content.join("\n"), language: code[2].trim().split(/\s+/)[0] });
      continue;
    }
    const title = heading(lines[index]);
    if (title) {
      result.push({ type: "heading", level: title[1].length, text: title[2].replace(/[\t ]+#+[\t ]*$/, "") });
      index++;
      continue;
    }
    const first = listItem(lines[index]);
    if (first) {
      const ordered = /^\d/.test(first[1]);
      const items = [];
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(item[2]);
        index++;
      }
      result.push({ type: "list", ordered, start: ordered ? Number.parseInt(first[1], 10) : 1, items });
      continue;
    }
    const paragraph = [lines[index++]];
    while (index < lines.length && lines[index].trim() && !fence(lines[index]) && !heading(lines[index]) && !listItem(lines[index]))
      paragraph.push(lines[index++]);
    result.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return result;
}
function blockNode(document, block) {
  if (block.type === "code") {
    const pre = node(document, "pre");
    const code = node(document, "code", "", block.text);
    if (/^[\w+-]{1,32}$/.test(block.language)) code.dataset.language = block.language;
    pre.append(code);
    return pre;
  }
  if (block.type === "list") {
    const list = node(document, block.ordered ? "ol" : "ul");
    if (block.ordered && Number.isSafeInteger(block.start) && block.start !== 1) list.start = block.start;
    for (const text of block.items) {
      const item = node(document, "li");
      inline(item, text);
      list.append(item);
    }
    return list;
  }
  const element = node(document, block.type === "heading" ? `h${block.level}` : "p");
  inline(element, block.text);
  return element;
}
function markdown(record, text) {
  const previous = record.blocks ?? [];
  const next = blocks(text).map((block, index) => {
    const signature = JSON.stringify(block);
    const old = previous[index];
    return old?.signature === signature ? old : { signature, element: blockNode(record.body.ownerDocument, block) };
  });
  const keep = new Set(next.map((item) => item.element));
  for (const child of [...record.body.children]) if (!keep.has(child)) child.remove();
  for (let index = 0; index < next.length; index++) {
    const existing = record.body.children[index];
    if (existing !== next[index].element) record.body.insertBefore(next[index].element, existing ?? null);
  }
  record.blocks = next;
}
function copyIcon(document, copied = false) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", copied ? "m5 12 4 4L19 6" : "M9 9h11v11H9zM5 15H4V4h11v1");
  svg.append(path);
  return svg;
}
function addCopy(record) {
  const document = record.card.ownerDocument;
  const clipboard = document.defaultView?.navigator.clipboard;
  if (typeof clipboard?.writeText !== "function") return;
  const actions = node(document, "div", "message-actions");
  const button = node(document, "button", "message-copy");
  button.type = "button";
  const feedback = node(document, "span", "message-copy-status");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  record.resetCopy = () => {
    record.copyVersion = (record.copyVersion ?? 0) + 1;
    clearTimeout(record.copyTimer);
    button.setAttribute("aria-label", "Copy message");
    button.title = "Copy message";
    button.replaceChildren(copyIcon(document));
    feedback.textContent = "";
  };
  record.resetCopy();
  button.addEventListener("click", async () => {
    const version = ++record.copyVersion;
    clearTimeout(record.copyTimer);
    try {
      await clipboard.writeText(record.text);
      if (!record.card.isConnected || version !== record.copyVersion) return;
      button.setAttribute("aria-label", "Copied");
      button.title = "Copied";
      button.replaceChildren(copyIcon(document, true));
      feedback.textContent = "Message copied";
    } catch {
      if (!record.card.isConnected || version !== record.copyVersion) return;
      button.setAttribute("aria-label", "Could not copy message");
      button.title = "Could not copy message";
      feedback.textContent = "Could not copy. Select the message text to copy it.";
    }
    record.copyTimer = setTimeout(record.resetCopy, 2e3);
  });
  actions.append(button, feedback);
  record.card.append(actions);
  record.actions = actions;
}
function subagentSenderName(message) {
  return message.role === "user" && message.sender?.kind === "subagent" && typeof message.sender.name === "string" ? message.sender.name : void 0;
}
function createMessage(document, message) {
  const tool = message.role === "tool";
  const card = node(document, tool ? "details" : "article");
  card.dataset.messageId = message.id;
  const record = { card, role: message.role, text: "", signature: void 0 };
  if (tool) {
    const summary = node(document, "summary", "tool-summary");
    record.name = node(document, "span", "tool-name");
    record.preview = node(document, "span", "tool-preview");
    record.state = node(document, "span", "tool-state");
    summary.append(record.name, record.preview, record.state);
    card.append(summary);
    record.body = node(document, "pre", "message-text tool-output");
  } else {
    if (message.role === "user") {
      record.label = node(document, "div", "message-label");
      card.append(record.label);
    } else card.setAttribute("aria-label", "Assistant message");
    record.body = node(document, "div", `message-text${message.role === "assistant" ? " message-markdown" : ""}`);
  }
  card.append(record.body);
  if (message.role !== "user") addCopy(record);
  return record;
}
var attachmentFields = ["id", "name", "mimeType", "size", "kind", "path", "data"];
function sameAttachments(previous, current) {
  return (previous?.length ?? 0) === current.length && current.every((attachment, index) => attachmentFields.every((key) => previous[index][key] === attachment[key]));
}
function updateMessage(record, message, attachments) {
  const { card, body } = record;
  const text = String(message.text ?? "");
  const thinking = message.role === "assistant" && typeof message.thinking === "string" ? message.thinking : "";
  record.senderName = subagentSenderName(message);
  if (record.role === "user") {
    const label = record.senderName ?? "You";
    const ariaLabel = record.senderName === void 0 ? "Your message" : `Message from subagent ${record.senderName}`;
    if (record.label.textContent !== label) record.label.textContent = label;
    if (card.getAttribute("aria-label") !== ariaLabel) card.setAttribute("aria-label", ariaLabel);
  }
  card.className = `message message-${record.role}${message.error ? " message-error" : ""}${message.pending && message.role === "assistant" && /^Thinking\u2026$/.test(text.trim()) ? " message-pending" : ""}${attachments.length ? " message-has-attachments" : ""}`;
  card.setAttribute("aria-busy", String(Boolean(message.pending)));
  if (record.role === "tool") {
    record.name.textContent = `Acted ${message.toolName ?? "tool"}`;
    record.preview.textContent = "";
    record.preview.hidden = true;
    record.state.textContent = message.error ? "Failed" : message.pending ? (/^writing\u2026$/i.test(text.trim()) ? "writing\u2026" : "Running") : "Done";
    record.state.dataset.state = message.error ? "failed" : message.pending ? "running" : "done";
  }
  if (record.text !== text || record.signature === void 0) {
    record.text = text;
    if (record.role === "assistant") markdown(record, text);
    else body.textContent = text;
    record.resetCopy?.();
  }
  if (record.actions) record.actions.hidden = !text || (Boolean(message.pending) && /^(Thinking|writing)\u2026$/.test(text.trim()));
  if (!sameAttachments(record.attachmentState, attachments)) {
    if (attachments.length) {
      if (!record.attachments) {
        record.attachments = node(card.ownerDocument, "div", "message-attachments");
        record.attachments.setAttribute("aria-label", "Attached files");
        card.insertBefore(record.attachments, record.actions ?? null);
      }
      record.attachments.replaceChildren(...attachments.map((attachment) => createAttachmentCard(card.ownerDocument, attachment)));
    } else {
      record.attachments?.remove();
      record.attachments = void 0;
    }
    record.attachmentState = attachments.map((attachment) => Object.fromEntries(attachmentFields.map((key) => [key, attachment[key]])));
  }
  if (thinking) {
    if (!record.thinking) {
      const disclosure = node(card.ownerDocument, "details", "message-thinking");
      const summary = node(card.ownerDocument, "summary", "thinking-summary", "Thought");
      const content = node(card.ownerDocument, "div", "thinking-text");
      disclosure.append(summary, content);
      card.insertBefore(disclosure, body);
      record.thinking = { disclosure, content };
    }
    if (record.thinking.content.textContent !== thinking) record.thinking.content.textContent = thinking;
  } else if (record.thinking) {
    record.thinking.disclosure.remove();
    record.thinking = void 0;
  }
}
function createChatRenderer({ messages, scroll }) {
  const document = messages.ownerDocument;
  const records = /* @__PURE__ */ new Map();
  return {
    render(messageArray) {
      const initialTop = scroll?.scrollTop ?? 0;
      const follow = scroll && initialTop + scroll.clientHeight >= scroll.scrollHeight - 160;
      const selection = document.getSelection();
      const selecting = selection && !selection.isCollapsed && messages.contains(selection.anchorNode);
      const keep = /* @__PURE__ */ new Set();
      const next = messageArray.filter((message) => {
        if (!message || typeof message.id !== "string" || !["user", "assistant", "tool"].includes(message.role) || keep.has(message.id)) return false;
        keep.add(message.id);
        return true;
      });
      // Anchor of the viewport: the current first card. If older messages get inserted above it (it stays but is no
      // longer first), its position on screen is restored after the render, so the visible content does not jump.
      const first = scroll ? messages.firstElementChild : null;
      const anchor = first && keep.has(first.dataset.messageId) && next[0]?.id !== first.dataset.messageId ? first : null;
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
      let changed = false;
      let position = 0;
      for (const [id, record] of records) if (!keep.has(id)) {
        clearTimeout(record.copyTimer);
        record.copyVersion++;
        record.card.remove();
        records.delete(id);
        changed = true;
      }
      for (const message of next) {
        let record = records.get(message.id);
        if (record && record.role !== message.role) {
          clearTimeout(record.copyTimer);
          record.card.remove();
          records.delete(message.id);
          record = void 0;
        }
        if (!record) {
          record = createMessage(document, message);
          records.set(message.id, record);
        }
        // Cached (older) messages keep their object identity; sender attribution can arrive separately.
        const senderName = subagentSenderName(message);
        if (record.source !== message || record.senderName !== senderName) {
          const attachments = Array.isArray(message.attachments) ? message.attachments.filter((attachment) => attachment && typeof attachment === "object") : [];
          const signature = JSON.stringify([message.role, message.text, message.pending, message.error, message.toolName, message.toolPreview, message.thinking, senderName]);
          if (record.signature !== signature || !sameAttachments(record.attachmentState, attachments)) {
            updateMessage(record, message, attachments);
            record.signature = signature;
            changed = true;
          }
          record.source = message;
        }
        const existing = messages.children[position++];
        if (existing !== record.card) {
          messages.insertBefore(record.card, existing ?? null);
          changed = true;
        }
      }
      // Messages were added before the first card (older history arrived): keep what the user sees where it was.
      if (anchor?.isConnected && messages.firstElementChild !== anchor) {
        const shift = anchor.getBoundingClientRect().top - anchorTop;
        if (Math.abs(shift) >= 1) scroll.scrollTo({ top: scroll.scrollTop + shift, behavior: "instant" });
      }
      if (changed && follow && !selecting) document.defaultView.requestAnimationFrame(() => {
        if (scroll.scrollTop >= initialTop - 2) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
      });
    }
  };
}
export {
  createChatRenderer
};
