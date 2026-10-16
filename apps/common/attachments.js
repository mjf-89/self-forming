// apps/common/attachments.js
var MAX_ATTACHMENTS = 4;
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var MAX_IMAGE_BYTES = 512 * 1024;
var MAX_BROWSER_TEXT_BYTES = 256 * 1024;
var IMAGE_TYPES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
var MANIFEST = "Self Forming attached files (names and workspace paths):\n";
function imageType(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
}
function base64(bytes) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(value);
}
async function normalizedImage(bytes, mimeType) {
  if (bytes.length <= MAX_IMAGE_BYTES && mimeType !== "image/gif") return { bytes, mimeType };
  if (typeof createImageBitmap !== "function" || typeof document === "undefined")
    throw new Error("Choose a smaller PNG, JPEG or WebP image (up to 512 KiB) on this device.");
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 5e7)
      throw new Error("This image is too large to prepare. Choose an image under 50 megapixels.");
    const canvas = document.createElement("canvas");
    const outputType = mimeType === "image/gif" ? "image/png" : mimeType;
    let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const drawing = canvas.getContext("2d");
      if (!drawing) throw new Error("This device could not prepare the image.");
      drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, outputType, 0.82));
      if (!blob) throw new Error("This device could not prepare the image.");
      if (blob.size <= MAX_IMAGE_BYTES) return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type };
      scale *= 0.75;
    }
    throw new Error("The image could not be reduced enough. Choose a smaller image.");
  } finally {
    bitmap.close();
  }
}
function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error?.message ?? "The attachment could not be saved.");
  return result.value;
}
async function prepareAttachment(file, { env, workspace, context }) {
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isSafeInteger(file.size) || file.size < 0)
    throw new TypeError("Choose a file to attach.");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Each attachment must be 10 MiB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("The selected file changed while it was being read.");
  const name = (String(file.name || "attachment").replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "attachment").slice(0, 200);
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 96) || "attachment";
  const id = crypto.randomUUID();
  const directory = `attachments/${id}`;
  const path = `${directory}/${safeName}`;
  const detected = imageType(bytes);
  const declared = typeof file.type === "string" ? file.type.toLowerCase() : "";
  if (declared.startsWith("image/") && !detected)
    throw new Error("Choose a PNG, JPEG, WebP or GIF image. Other image formats are not supported yet.");
  const image = detected ? await normalizedImage(bytes, detected) : void 0;
  let text;
  if (!env && !image) {
    const textType = declared.startsWith("text/") || /^(?:application\/(?:json|xml|javascript|x-yaml))$/.test(declared) || /\.(?:txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|log|html|css|js|mjs|ts|tsx|jsx|kt|java|py|sh|sql|toml|ini)$/i.test(name);
    if (!textType || bytes.length > MAX_BROWSER_TEXT_BYTES)
      throw new Error("Attach this file in the Android app. This browser development app supports images and text files up to 256 KiB.");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("This browser development app supports UTF-8 text files. Attach other files in the Android app.");
    }
    if (text.includes("\0")) throw new Error("This file is not plain text. Attach it in the Android app.");
  }
  if (env) {
    unwrap(await env.createDir(directory, { recursive: true }, context));
    unwrap(await env.writeFile(path, bytes, context));
    unwrap(await env.flushFile(path, context));
  } else if (text !== void 0) {
    await workspace.write(path, text);
  }
  const mimeType = image?.mimeType ?? (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declared) ? declared : "application/octet-stream");
  return {
    attachment: {
      id,
      name,
      mimeType,
      size: bytes.length,
      kind: image ? "image" : "file",
      ...env || text !== void 0 ? { path } : {},
      ...image ? { data: base64(image.bytes) } : {}
    },
    ...text !== void 0 ? { text } : {}
  };
}
function descriptor(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    ...attachment.path ? { path: attachment.path } : {}
  };
}
function attachmentUserContent(text, attachments) {
  if (!attachments.length) return text;
  return [
    { type: "text", text },
    { type: "text", text: MANIFEST + JSON.stringify({ version: 1, attachments: attachments.map(descriptor) }) },
    ...attachments.filter((item) => item.kind === "image").map((item) => ({ type: "image", mimeType: item.mimeType, data: item.data }))
  ];
}
function attachedUserPresentation(message) {
  if (message.role !== "user" || !Array.isArray(message.content)) return;
  const [prompt, manifest, ...images] = message.content;
  if (prompt?.type !== "text" || manifest?.type !== "text" || !manifest.text.startsWith(MANIFEST)) return;
  try {
    const parsed = JSON.parse(manifest.text.slice(MANIFEST.length));
    if (parsed.version !== 1 || !Array.isArray(parsed.attachments) || parsed.attachments.length < 1 || parsed.attachments.length > MAX_ATTACHMENTS) return;
    let index = 0;
    const attachments = [];
    for (const item of parsed.attachments) {
      if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(item.id) || typeof item.name !== "string" || item.name.length > 200 || typeof item.mimeType !== "string" || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_ATTACHMENT_BYTES || !["image", "file"].includes(item.kind)) return;
      if (item.path !== void 0 && (typeof item.path !== "string" || !item.path.startsWith(`attachments/${item.id}/`) || !/^[a-zA-Z0-9/._-]+$/.test(item.path) || item.path.split("/").includes(".."))) return;
      const image = item.kind === "image" ? images[index++] : void 0;
      if (item.kind === "image" && (!image || image.type !== "image" || image.mimeType !== item.mimeType || !IMAGE_TYPES.has(image.mimeType) || typeof image.data !== "string" || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))) return;
      attachments.push({ ...descriptor(item), ...image ? { data: image.data } : {} });
    }
    if (index !== images.length) return;
    return { text: prompt.text, attachments };
  } catch {
    return;
  }
}
export {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_BROWSER_TEXT_BYTES,
  MAX_IMAGE_BYTES,
  attachedUserPresentation,
  attachmentUserContent,
  prepareAttachment
};
