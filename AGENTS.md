# App design and implementation guidelines

> This file is loaded into the main agent's instructions every time the app starts (`session.js`, section `agentsGuide`; subagents get it when given the `agentsGuide` context section). Keep it accurate and reasonably short: everything here costs context on every reply.

## Product intent

This is a self-forming personal app: people describe what they need and shape the app through conversation. The audience is not necessarily technical. Do not present it as primarily an IDE, terminal, or developer dashboard.

- Use plain, friendly language. Describe outcomes rather than implementation details.
- Self Forming has one main surface: the chat (it opens directly, no Home screen), plus Settings and the conversation tree. There is no file explorer, terminal, voice mode, developer screen or activity view; do not add them back unless the user explicitly asks.
- Keep the agent's thoughts and tool calls visible in the chat as quiet, collapsible rows. Sign-in and model choice live in the in-chat Settings. App recovery lives only in Android Settings (gear in App info).
- Use examples as possibilities, not claims that unimplemented features already exist.
- Never submit a message, replace a draft, or make destructive changes just because someone selects a suggestion or opens a view.

## Visual direction

Quiet, neutral and text-first: one flat paper colour, dark ink, monospace type, hairlines and no animations on screen changes. The welcome view is a masthead (SELF FORMING), one invitation line and the credit ("Powered by" + a dotted-underlined pi-durable link). All views must belong to the same app. `app.css` is the source of truth; when it changes on purpose, update this section.

- Flat paper background (`--paper`, `--paper-bg: none`) on the page, the chats drawer and the settings dialog alike; other surfaces are transparent over it or a light card (`--surface`).
- Fonts: system monospace only (`--serif` and `--garamond` both resolve to "Courier New", "Liberation Mono", "Droid Sans Mono", monospace; `--mono` for code). Nothing is loaded from the network. The bundled Baskervville/EB Garamond files in `fonts/` are currently unused.
- Palette (tokens in `:root` of `app.css`; do not invent per-view colours): paper `#f6f6f3` · light/surface `#fbfbf9` · ink `#282826` · brand (masthead) `#4a4a45` · muted `#676761` · accent `#30302e` · border `#bdbdb6` · error `#9e3b2c`. No shadows (`--shadow-*: none`).
- Shapes: small radii for cards, menus and the composer (4–12 px); the Send button and the jump-to-latest button are the only round controls (same size `--send`, same 25 px arrow, stroke 1.8, round caps). Send is filled `#30302e` with a light arrow; jump-to-latest is `--surface` with a hairline border and `--accent` arrow.
- Composer text: `clamp(15px, 4.2vw, 17px)`; message text 17 px.
- Do not use a grayscale filter over the app: it would alter user content as well as UI.
- Distinguish error/warning/selected states through wording, weight, underline and contrast—not colour alone.

## Navigation and headers

- Views occupy the full WebView viewport. No floating-card layouts.
- Header: no rule or border; the conversations (drawer) icon at the left (36 px target, `var(--muted)`). Settings opens from the model name in the footer (`#composer-model`, which clicks the hidden `#chat-settings`); keep `#chat-settings` because several modules listen to it.
- Attachments: the `+` in the composer opens a small row of two icon buttons (paperclip = files, picture = photos/images), each with an accessible label.
- Back is a flat chevron at the top LEFT (`.app-icon-button`, 36 × 36 target, no circle or border), inline SVG `viewBox="0 0 24 24"`, path `m14 6-6 6 6 6`.
- Title follows the back button: 24 px, weight 400, in the app font. Keep it short; explanations go in the view or a disclosure.
- Use accurate accessible labels and tooltips, e.g. “Back to chat”.
- Closing Settings or the conversation tree must not cancel an agent reply or reset a chat draft.

## Icons and controls

- Minimal inline SVG line icons, `currentColor`, rounded caps/joins, stroke 1.7–2.1. No emoji, raster icons or icon fonts.
- Icon-only buttons need an accessible name; decorative SVGs use `aria-hidden="true"`.
- **Secondary actions** (`.quiet-button`): transparent fill, 1 px `--border` hairline, 4 px radius, ink text at 16 px, 40 px tall; inside menus (`.chat-menu`) the border is hidden. Never pills.
- **Primary action** (at most one per view: Send, Save, Sign in): the dark accent fill (`--accent` / `#30302e`) with light text or icon. Disabled = reduced opacity, label kept.
- **Mostly square geometry.** Buttons, inputs, selects and the composer box use small radii (4–5 px); menus and cards up to 12 px. Round shapes are reserved for Send and jump-to-latest. No pill buttons.
- Settings shows controls, not essays: no long explanatory `settings-note` paragraphs; keep only live status lines (ids with `role="status"`) and errors. Empty notes are hidden by CSS.
- Form rows: muted label (15 px) above a full-width, regular-weight control (40 px tall). Focus = brighter border, not a double ring. Status chips are plain muted text.
- Toggle state uses `aria-pressed="true"` → underline, never a filled chip.
- Lists are flush rows: 40–44 px tall, icon/badge left, name, right-aligned muted metadata (size, count, chevron). No per-row cards or rounded row backgrounds; hover/selection uses the Surface colour.
- Minimum touch target 40 px for dense toolbars/lists, 44 px elsewhere.
- Inputs and selects: Surface fill, hairline border, 4 px corners, at least 16 px text on mobile.
- Show a visible focus outline and respect reduced-motion preferences.

## Layout and content

- Spacing scale: 4, 8, 12, 16, 24 px. Prefer 8/12 inside toolbars and lists.
- Monospace everywhere (`--serif`/`--garamond` for prose and controls, `--mono` for code, paths and sizes). Code blocks are bordered `--surface` cards (10 px radius) that scroll horizontally.
- Status/help text appears only when it carries information (errors, empty states). Don't permanently explain the obvious.
- Preserve room for actual content. Technical explanations belong in disclosures.
- Keep narrow screens, landscape, the Android keyboard, long filenames, empty and error states usable.
- Do not add extra safe-area/keyboard offsets when the host already sizes the WebView.

## Source and styling architecture

- Inspect the current editable source path with `app_update(info)` before editing the app. Do not assume a version-specific directory will remain current.
- The current app uses plain browser JavaScript modules, HTML and CSS. No framework, npm dependency, compiler, or build step is needed for app changes.
- Bundled upstream Pi/native modules are fixed. Use their existing APIs; do not invent host capabilities.
- There is exactly one stylesheet, `apps/on-device/app.css`: tokens, base, layout, components, then views (chat, settings, drawer). Edit or delete rules in place; do not add override layers or extra stylesheet files. No dark theme.
- Reuse and extend shared classes instead of copying styles into each view. Check specificity so feature selectors cannot accidentally override common controls.
- Preserve existing IDs, listeners, authentication, drafts, storage keys, and file safeguards when changing markup.

## Self-modification (read this before changing the app)

The app is meant to be reshaped. The original plain monospace look is deliberately plain: a neutral starting point that invites the user to bend the design language as they please, not a brand to protect.

- When the user repurposes the app (a recipe book, a trip planner, a shop counter…), change its visual identity and design style with it: palette, typography, shapes, density, iconography, masthead, invitation and wording should fit the new purpose. Do this in `app.css` tokens first, then components, and update the “Visual direction” section of this file so later agents follow the new style instead of restoring the old one.
- Small requests (“darker title”, “round buttons”) are just that: change what was asked and keep the rest consistent.

Work as an orchestrator:
- The main agent always orchestrates: it talks with the user, splits the work, decides, integrates and verifies. It does not need to do every step itself.
- Use the `subagent` tool to offload work and to run independent parts in parallel to speed up development: e.g. `spawn` one subagent for research or a dependency setup, another for a separate module or a build, while the main agent keeps editing or talking with the user. Use `run` for focused one-shot steps. Pick a cheaper model for simple work, give each subagent only the tools and context sections it needs, and a precise, self-contained goal with clear “done” criteria.
- Give parallel subagents separate files or folders so they do not overwrite each other; the main agent merges and reviews their results, checks them, and is the only one that calls `app_update apply` or `app_install_apk`.

Two layers, two paths:

| Change | How | Survives a new APK? |
|---|---|---|
| Web layer (JS/HTML/CSS) | edit `sourcePath`, then `app_update apply` | only if copied to `apps/on-device` before the APK is built |
| Native (Kotlin, permissions, host modules, `library/`) | follow `skills/self-rebuild/SKILL.md`, build, `app_install_apk` | yes |

Web-layer loop:
1. `app_update info` → `sourcePath` (today `<workspace>/.self-forming/app/<hostVersion>`). Edit there. New files are fine: every file in the folder goes into the revision and is served (only `native-host.js`, `library/`, `app-manifest.json`, `app-source-README.md` and the fixed fonts are refused).
2. Check the edits (there is no Node/Bun: read diffs carefully, grep for leftovers, keep `[hidden] { display: none !important; }` in mind when giving elements a `display`). Then call `app_update apply` alone as the last tool call. Once its successful tool result is durably saved, the session queues the revision, closes the harness and reloads the page. Other conversations and subagents can still be busy; their unfinished durable work resumes after reload. The user never has to background the app; if they do, that is a bug (see below).
3. Report what changed and what was not verified on screen.

Keep the repository in step (this is how descendants inherit changes):
- The live `sourcePath` and `apps/on-device` are separate copies. After changes the user wants to keep, copy them: `cp <sourcePath>/*.js <sourcePath>/*.css <sourcePath>/*.html <workspace>/self-forming/apps/on-device/` (remove files there that were deleted from `sourcePath`). The APK and its embedded `source.zip` are built from `apps/on-device`; anything left only in `sourcePath` is lost for every rebuilt or descendant app.
- Commit with the user's own name and email (ask; never invent an identity).

Version masking:
- An applied revision wins over the APK's bundled web files for as long as the host version (`package.json` `version` = `versionName`) is unchanged. A new APK with the same version therefore keeps showing the old applied revision and hides its own web changes. Fix: merge the APK's changes into `sourcePath` and apply again, or bump the version when building.

How activation works (for debugging): `native-tools.js` `app_update apply` stages a revision and records its tool task, conversation and call IDs → `session.js` observes commits through `app-update-handoff.js`, matching the exact successful tool result and revision → a deferred `appRevision.onStaged` call → `app-revisions.js` `queue` → `app.js` `render` calls `applyQueued` → `activate` awaits actual session closure → `app.activate` → `location.reload()`. Neither global activity nor the selected conversation's busy state blocks a committed update. Closing interrupts active effects and preserves unfinished durable tasks; it does not wait for every agent to finish. Never call Session APIs directly inside a commit observer, and never activate on a timeout before storage has closed. Foreground, sign-in and UI-operation guards still apply. A race used to leave the revision queued until the next app reopen: `render` skipped it while an earlier empty `applyQueued` check was still in flight. Now the finishing check re-renders, and a 1.5 s retry runs while a revision is pending; keep both. If activation misbehaves again, add a temporary trace (e.g. append lines through the bridge method `workspace.write`) rather than guessing, and remove it afterwards.

Related tools:
- `manage_server` needs tmux and installs it with apt on first use (`servers.js` `ensureTmux`). Ports may already be taken by other apps on the phone: check with curl before choosing one.
- Subagents: `run` helpers are one-shot; only `spawn`ed agents can receive later messages, and only by the name given at spawn (a title the user sets in the drawer is not that name). Tool names in the `tools` option are lowercase (`read`, `write`, `edit`, `bash`, …). Finished subagent chats are listed under “Finished” in the drawer.

## Safety and checks

- Never display credentials or persist command input history to disk without an explicit requirement.
- Service secrets are configured only through Settings → Secrets. The native `SecretStore.kt` encrypts values with AES-256-GCM using non-exportable Android Keystore keys (some secrets need a fingerprint); app code never receives stored values, only commands get them through the execution environment.
- Never read or print the real key or stored credential values using agent tools. Never include them in app source, tests, console logs, transcripts, or error messages. Test only with generated temporary keys and clearly dummy values.
- Inject enabled secrets through execution `env` options, not command strings. Scope agent Bash and server access separately and default both to off. Existing processes retain inherited values; restart servers after changing credentials.
- Do not remove scope controls, damage checks, or explicit deletion confirmations.
- Check syntax, unique HTML IDs and stylesheet ordering before applying (no Node/Bun on the phone: review diffs and grep carefully).
- Static checks and mocked DOM tests are NOT visual verification. Say when on-device appearance or behavior remains unverified.
- Call `app_update(apply)` alone as the final tool step after checking edits. Staging a revision is not proof it booted successfully.

## Rebuilding and updating the app on the phone

- The APK carries this repository (with `skills/` and its dedicated `.signing/`, but no Git history) as `assets/self-source/source.zip`. On first launch `SelfSource` unpacks it to `<workspace>/self-forming/` (never overwriting existing work; a missing `.signing/` or `skills/` is restored on every launch) and refreshes `dist/` (prebuilt web app, runtime payload, `source.zip`) from every newly installed APK.
- `./build-all.sh` uses the full Bun build when Bun and `node_modules` exist; otherwise `scripts/web-lite.sh` overlays `apps/on-device` onto the prebuilt `dist/app` (fixed modules such as `native-host.js` are reused, so `packages/native-host` changes need the full build). `scripts/pack-source.sh` then packs the source, and `build-apk.sh` signs with `.signing/` (the dedicated Self Forming key, v3, Android 9+; a rotation `lineage.bin` is used only if present, this fresh app has none).
- Install in place with the `app_install_apk` tool (only this package; Android asks the user). Bump `version` in `package.json` and `versionName` in `apps/android/app/build.gradle.kts` together, or editable-app revisions of the old version will mask the new UI.
- `.signing/` holds the private key and its password. It is gitignored. Never print it, commit it, or send it anywhere. Anyone who has the APK can extract it.
- Where things are on the phone, with `<workspace>` = /data/data/md.incept.selfforming/files/workspace (the session instruction `selfRebuild` states them, computed from the workspace path): source `<workspace>/self-forming`; signing key `<workspace>/self-forming/.signing/` (`self-forming.p12`, alias `self-forming`, password file `password`; used automatically by `build-apk.sh`); live web app source = `sourcePath` from `app_update` info (keep it in sync with `apps/on-device`); skill `<workspace>/self-forming/skills/self-rebuild/SKILL.md`; toolchain install log `<workspace>/.self-forming/toolchain.log`.
- The Android build tools (`pi-android install --accept-licenses`, licence accepted on the user's behalf; the welcome text says so while they are missing) start installing in the background when a native session opens (`session.js` `toolchain.ensure`: nothing if `pi-android status` reports them installed or `flock` shows another install running; retried at the next start). Bump `selfFormingVersionCode` for every APK you install. The `app_install_apk` tool is registered only when the host reports `apkInstall`.
