package md.incept.selfforming

import android.app.Activity
import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONObject
import java.util.concurrent.Executor

/**
 * Native route registry (R1, docs/plugins-ui-editions.md). The Kotlin half of a built-in plugin
 * (plugins/<id>/native/src) declares one `internal object <PascalCaseId>Native : BuiltinNative`, e.g.
 * `CoreSelfUpdateNative`. Gradle lists the objects of the plugin folders present in the generated
 * [BuiltinNatives.ALL]; the host (NativeBridge, MainActivity, SettingsActivity, NativeAuth, and halves reaching
 * other halves, e.g. core-execution's secrets) only talks
 * to this interface, so a fork drops a plugin folder without host edits. Static, never dex-loaded.
 */
internal interface BuiltinNative {
    /** Adds this half's `host.info` capability flags. */
    fun capabilities(into: JSONObject) {}
    /** Extra page message channels (same main-frame + app-origin gate as PiNative); see [BridgeRoutes.receive]. */
    val channels: Set<String> get() = emptySet()
    /** Bridge routes for one NativeBridge (one per Activity/document owner); null = no routes. */
    fun attach(scope: BridgeScope): BridgeRoutes? = null
    /** Served paths under /assets/web/ owned by this half: they never fall through to app files. */
    val assetPrefix: String? get() = null
    /** Opens an owned asset for the current document (null = 403). [pins] = the document's pinned revisions. */
    fun openAsset(context: Context, path: String, pins: MutableMap<String, String>): WebResourceResponse? = null
    /** Buttons of the Android Settings recovery screen (SettingsActivity). */
    fun recoveryActions(): List<RecoveryAction> = emptyList()
    /** An auth.* provider ("chatgpt", "claude"): its record in the shared credential store and its sign-in methods. */
    val authProvider: AuthProvider? get() = null
    /** Secrets for commands (core-secrets), used by core-execution's environment. */
    val commandSecrets: CommandSecrets? get() = null
    /** MainActivity lifecycle, for halves that show UI on the Activity (core-secrets' fingerprint prompts). */
    val activityHooks: ActivityHooks? get() = null
}

internal class RecoveryAction(val label: String, val run: (Activity) -> Unit)

/** What a NativeBridge offers the routes it hosts. */
internal interface BridgeScope {
    val context: Context
    val workspace: Workspace
    /** The current document's pinned plugin revisions (served assets and plugins.read). */
    val pluginPins: MutableMap<String, String>?
    /** env.exec started: MainActivity may ask for the notification permission. */
    fun executionStarted()
}

/** One admitted bridge request. Exactly one of [done]/[fail] must be called. */
internal class BridgeCall(
    val method: String,
    val params: JSONObject,
    val done: (Any?) -> Unit,
    val fail: (Throwable) -> Unit,
    /** Sends an event to the requesting document (dropped after a page reset). */
    val event: (JSONObject) -> Unit,
    /** Runs [block] on the bridge's file worker if the document is still current; exceptions fail the call. */
    val worker: (block: () -> Unit) -> Unit,
    /** Same as [worker] on the route's own executor (e.g. core-storage's one SQLite thread). */
    val on: (executor: Executor, block: () -> Unit) -> Unit,
)

internal interface BridgeRoutes {
    fun handles(method: String): Boolean
    fun dispatch(call: BridgeCall)
    /** A message on one of [BuiltinNative.channels], on the main thread. */
    fun receive(channel: String, raw: String, proxy: JavaScriptReplyProxy) {}
    /** Page recreation (ownership boundary): drop per-document state. */
    fun reset() {}
    /** The bridge closes (after a final [reset]). */
    fun close() {}
}

/**
 * One auth.* provider (X5). NativeAuth (host) keeps the dispatcher and the encrypted record store ([AuthStore], shared
 * with plugin credentials) and answers auth.info/load/save/clear for every provider; [signIn] adds the provider's own
 * methods (auth.listen/open/wait/cancel for chatgpt, auth.openExternal for claude).
 */
internal interface AuthProvider {
    /** The `provider` parameter value. */
    val id: String
    /** Record directory relative to Context.noBackupFilesDir. */
    val directory: String
    /** Android Keystore alias of the record key. */
    val keyAlias: String
    /** Sign-in methods for one NativeAuth (one per bridge); null = records only. */
    fun signIn(context: Context): AuthSignIn? = null
}

internal interface AuthSignIn {
    fun handles(method: String): Boolean
    /** On the auth worker. Throw a HostFailure, or settle exactly one of [AuthCall.done]/[AuthCall.fail] (possibly later). */
    fun dispatch(method: String, params: JSONObject, call: AuthCall)
    /** Page recreation or close (after the call epoch moved on): cancel what is in progress. */
    fun reset() {}
}

internal class AuthCall(
    val done: (Any?) -> Unit,
    val fail: (Throwable) -> Unit,
    /** False once the page that made this call was reset or the bridge closed. */
    val current: () -> Boolean,
)

/** Marker environment variable from the page naming the secret scope (agent|terminal|servers). Never exported. */
internal const val SECRET_SCOPE_VARIABLE = "PI_SECRET_SCOPE"

/** Stored secrets for commands (core-secrets' Kotlin half), used by core-execution. Absent = commands get none. */
internal interface CommandSecrets {
    /** The execution environment exists: injection works before any secrets.* call. */
    fun attach(context: Context)
    /** Secrets of [scope] for one command (may wait for a fingerprint until [cancelled]). */
    fun resolve(scope: String?, cancelled: () -> Boolean): CommandInjection
    /** The command is over: stop extending and wipe its redaction. */
    fun release(redaction: CommandRedaction?)
}

/** Values injected into one command; [locked] = secrets that could not be read; [redaction] covers its output. */
internal class CommandInjection(val values: Map<String, String>, val locked: List<String>, val redaction: CommandRedaction?) {
    companion object { val NONE = CommandInjection(emptyMap(), emptyList(), null) }
}

internal interface CommandRedaction {
    /** One output stream's redactor (a value split across chunks is held back). */
    fun stream(): Stream
    interface Stream {
        fun process(chunk: ByteArray): ByteArray
        fun flush(): ByteArray
    }
}

/** MainActivity lifecycle calls, on the main thread. */
internal interface ActivityHooks {
    /** onCreate; [foreground] tells whether the Activity is started, [post] runs on the main thread. */
    fun created(activity: Activity, foreground: () -> Boolean, post: (Runnable) -> Unit) {}
    /** onStart (true) / onStop (false). */
    fun foreground(value: Boolean) {}
    /** Posted after onResume and onNewIntent. */
    fun resumed() {}
    fun destroyed() {}
}
