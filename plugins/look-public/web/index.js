// look-public: the original light look (paper #f6f6f3, ink #282826, Courier New stack, small radii, round Send and
// jump-to-latest) as an ordinary built-in plugin: it PROVIDES look@1 ({name, styles: [hrefs relative to this web folder]})
// and contributes web/look.css (plugin.json "styles", order 100). plugin-styles.js applies those styles only while it is the
// resolved provider of look@1. It is the default look only when it is the last look present (the public export has no
// look-private); otherwise it is one more choice in Settings → Providers. Every look defines the same tokens.
export function create() {
  return { name: "Look: light", setup(ctx) { ctx.provide("look", 1, Object.freeze({ name: "Look: light", styles: Object.freeze(["look.css"]) })); } };
}
