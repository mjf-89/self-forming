// Pinned VM assets remain fixed browser-deployment resources in vendor/v86
// with their existing PROVENANCE files/build scripts. They are intentionally NOT
// copied into plugin web/ or editable APK revisions (tens of MiB). This module
// resolves the same relative served layout without depending on the app route.
export function browserAssetURL(path) {
  // Source-only Node emulator tests; assembled Node tests use the served branch.
  const source = import.meta.url.startsWith('file:') && new URL(import.meta.url).pathname.endsWith('/plugins/exec-linux/web/browser/browser-assets.js');
  return new URL((source ? '../../../../apps/browser/vendor/' : '../../../../vendor/') + path, import.meta.url);
}
