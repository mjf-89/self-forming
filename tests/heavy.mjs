// Opt-in switch for tests too heavy for a phone (headless Chromium, v86 emulation, full browser builds,
// real Tor/network). `heavy` is a node:test skip reason, or false when SF_HEAVY_TESTS=1.
export const heavy = process.env.SF_HEAVY_TESTS === '1' ? false : 'heavy test: set SF_HEAVY_TESTS=1';
