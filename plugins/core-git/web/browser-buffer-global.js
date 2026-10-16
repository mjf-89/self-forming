// isomorphic-git's browser bundle calls a global Buffer (Buffer.from/alloc/concat).
// Browsers have none; provide the vendored one before isomorphic-git is evaluated.
import { Buffer } from "../../../apps/browser/vendor/buffer/buffer.js";

if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
