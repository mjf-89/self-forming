// Browser-only Claude bridge policy. The verified controller/PKCE/token logic is unchanged.
// Preserve the existing HTTPS-only policy and JSON parsing/error behavior; no host allowlist
// or alternative networking is introduced by the ownership extraction.
export function loadClaudeBrowserRecord(storage, key) {
  return JSON.parse(storage.getItem(key) ?? "null");
}

export function openClaudeBrowserSignIn(url, openExternal) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw Object.assign(new Error("Only HTTPS sign-in pages can be opened"), { code: "AUTH_ERROR" });
  }
  return openExternal(parsed.href);
}
