package md.incept.selfforming

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/** The main-frame origin gate lives in MainActivity, before any message reaches this class. */
class NativeBridge(context: Context, private val appStore: WebAppStore? = null,
                   private val onExecutionStart: () -> Unit = {},
                   private val onAppStateChanged: () -> Unit = {}) {
    /** MainActivity: the page wants Android back (button or edge swipe) for itself while a panel is open. */
    @Volatile var onBackHandler: ((Boolean) -> Unit)? = null
    /** MainActivity: the current document's pinned plugin revisions (served assets and plugins.read). */
    @Volatile var pluginPins: MutableMap<String, String>? = null
    private var backProxy: JavaScriptReplyProxy? = null
    private var backEpoch = 0L

    /** Back was pressed while the page asked for it: the page closes its panel. Sent as an env.output event, one of the
     * event shapes the page's bridge accepts. */
    fun dispatchBack() {
        val proxy = backProxy ?: return
        send(JSONObject().put("event", "env.output").put("id", "host-back").put("stream", "stdout").put("data", "back"), proxy, backEpoch)
    }

    private val main = Handler(Looper.getMainLooper())
    private val workspace = Workspace(File(context.filesDir, "workspace").toPath())
    private val executionContext = context.applicationContext
    private val fileWorker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "pi-workspace") }
    private val auth = NativeAuth(context.applicationContext)
    /** Routes of the built-in plugins' Kotlin halves present in this build (R1, BuiltinNative.kt). */
    private val routes: List<BridgeRoutes> = object : BridgeScope {
        override val context: Context get() = executionContext
        override val workspace: Workspace get() = this@NativeBridge.workspace
        override val pluginPins: MutableMap<String, String>? get() = this@NativeBridge.pluginPins
        override fun executionStarted() = onExecutionStart()
    }.let { scope -> BuiltinNatives.ALL.mapNotNull { it.attach(scope) } }
    private val generation = AtomicLong(0)
    private val inFlight = ConcurrentHashMap.newKeySet<String>()
    private var foreground = true
    private var visible = true
    /** The page reports a running reply: keep the session alive while hidden. */
    @Volatile private var keepAlive = false
    private var lifecycleProxy: JavaScriptReplyProxy? = null
    @Volatile private var closed = false

    fun receive(raw: String, proxy: JavaScriptReplyProxy) {
        if (closed) return
        lifecycleProxy = proxy
        val epoch = generation.get()
        var id = ""
        var admittedKey: String? = null
        try {
            if (raw.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) throw HostFailure("TOO_LARGE", "Bridge message exceeds 4 MiB")
            val message = JSONObject(raw)
            id = message.getString("id")
            if (id.isEmpty() || id.length > 160) throw HostFailure("INVALID_REQUEST", "Invalid request identifier")
            val method = message.getString("method")
            val params = message.getJSONObject("params")
            val key = "$epoch:$id"
            if (inFlight.size >= 256) throw HostFailure("BUSY", "Too many pending native operations")
            if (!inFlight.add(key)) throw HostFailure("DUPLICATE_ID", "Request identifier is already active")
            admittedKey = key
            val replyId = id
            val done: (Any?) -> Unit = { result ->
                inFlight.remove(key)
                send(JSONObject().put("id", replyId).put("ok", true).put("result", result ?: JSONObject.NULL), proxy, epoch)
            }
            val fail: (Throwable) -> Unit = { error ->
                inFlight.remove(key)
                send(JSONObject().put("id", replyId).put("ok", false).put("error", wireError(error)), proxy, epoch)
            }
            when {
                method == "host.keepAlive" -> {
                    keepAlive = params.optBoolean("busy")
                    AgentService.onStopRequested = { send(JSONObject().put("event", "agent.stopped").put("id", "agent"), proxy, epoch) }
                    main.post { AgentService.update(executionContext, keepAlive); setForeground(visible) }
                    done(null)
                }
                method == "host.back" -> {
                    backProxy = proxy
                    backEpoch = epoch
                    val enabled = params.optBoolean("enabled")
                    main.post { onBackHandler?.invoke(enabled) }
                    done(null)
                }
                // Built-in halves add their own flags (executionEnv/shell/backgroundExecution, plugins/nativePlugins/
                // pluginEvents/pluginRead, apkInstall, nativeFetch/httpAllowList, claudeAuth, secrets/secretBroker); the rest
                // belongs to the host.
                method == "host.info" -> done(JSONObject().put("platform", "android").put("version", BuildConfig.VERSION_NAME)
                    .put("foreground", foreground).put("workspace", workspace.root.toString()).put("capabilities", JSONObject()
                        .put("browserFetch", true).put("editableApp", appStore != null)
                        .put("backgroundReplies", true).put("backHandler", true)
                        .put("pluginCredentials", true)
                        .also { capabilities -> BuiltinNatives.ALL.forEach { it.capabilities(capabilities) } }))
                method.startsWith("app.") -> fileWorker.execute {
                    if (epoch == generation.get() && !closed) {
                        try {
                            done(application(method, params))
                            main.post { if (epoch == generation.get() && !closed) onAppStateChanged() }
                        } catch (error: Exception) { fail(error) }
                    } else inFlight.remove(key)
                }
                method.startsWith("workspace.") -> fileWorker.execute {
                    if (epoch == generation.get() && !closed) {
                        try { done(files(method, params)) } catch (error: Exception) { fail(error) }
                    } else inFlight.remove(key)
                }
                method.startsWith("auth.") -> auth.dispatch(method, params, done, fail)
                else -> routes.firstOrNull { it.handles(method) }?.dispatch(run {
                    val on: (Executor, () -> Unit) -> Unit = { executor, block -> executor.execute {
                        if (epoch == generation.get() && !closed) {
                            try { block() } catch (error: Exception) { fail(error) }
                        } else inFlight.remove(key)
                    } }
                    BridgeCall(method, params, done, fail, event = { event -> send(event, proxy, epoch) },
                        worker = { block -> on(fileWorker, block) }, on = on)
                })
                    ?: fail(HostFailure("METHOD_NOT_FOUND", "Unknown native method: $method"))
            }
        } catch (error: Exception) {
            admittedKey?.let { inFlight.remove(it) }
            send(JSONObject().put("id", id).put("ok", false).put("error", wireError(error)), proxy, epoch)
        }
    }

    /** A BuiltinNative channel message (MainActivity: main frame + app origin only), on the main thread. */
    fun receiveChannel(channel: String, raw: String, proxy: JavaScriptReplyProxy) {
        if (closed) return
        routes.forEach { it.receive(channel, raw, proxy) }
    }

    private fun files(method: String, params: JSONObject): Any? = when (method) {
        "workspace.read" -> JSONObject().put("text", workspace.read(params.getString("path")))
        "workspace.write" -> { workspace.write(params.getString("path"), params.getString("text")); null }
        "workspace.list" -> JSONArray().also { result ->
            workspace.list(params.getString("path")).forEach { entry -> result.put(JSONObject()
                .put("name", entry.name).put("path", entry.path).put("directory", entry.directory).put("size", entry.size)) }
        }
        else -> throw HostFailure("METHOD_NOT_FOUND", "Unknown workspace method")
    }

    private fun send(message: JSONObject, proxy: JavaScriptReplyProxy, epoch: Long) {
        var text = message.toString()
        if (text.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            text = JSONObject().put("id", message.optString("id")).put("ok", false)
                .put("error", wireError(HostFailure("TOO_LARGE", "Native response exceeds 4 MiB"))).toString()
        }
        // Queue replies and events in the order each operation produces them.
        main.post {
            if (!closed && epoch == generation.get()) {
                try { proxy.postMessage(text) } catch (_: IllegalStateException) { /* document already detached */ }
            }
        }
    }

    /** Let the UI pause its harness before subsequent background transport failures.
     * Keep this bridge and authentication alive: browser sign-in also backgrounds the Activity.
     */
    fun setForeground(visible: Boolean) {
        this.visible = visible
        // The chat keeps running behind other apps while the agent works.
        val value = visible || keepAlive
        if (closed || foreground == value) return
        foreground = value
        val proxy = lifecycleProxy ?: return
        send(JSONObject().put("event", "host.lifecycle").put("id", "host").put("foreground", value),
            proxy, generation.get())
    }

    private fun application(method: String, params: JSONObject): Any? {
        val store = appStore ?: if (method == "app.info") return JSONObject().put("supported", false)
            else throw HostFailure("APP_UNAVAILABLE", "This host does not provide editable application sources")
        return when (method) {
            "app.info" -> appInfo(store.info())
            "app.stage" -> JSONObject().put("revision", store.stage())
            // The JavaScript coordinator awaits this reply, then reloads after closing its Harness.
            // Selecting a revision never reloads early and loses the acknowledgement.
            "app.activate" -> appInfo(store.activate(params.getString("revision")))
            "app.ready" -> appInfo(store.ready(params.getString("revision")))
            "app.restore" -> {
                val target = params.optString("target", "original")
                if (target != "original" && target != "previous") throw HostFailure("APP_INVALID", "Choose the previous or original app")
                appInfo(store.restore(target == "previous"))
            }
            else -> throw HostFailure("METHOD_NOT_FOUND", "Unknown application method")
        }
    }

    private fun appInfo(info: WebAppStore.Info) = JSONObject().put("supported", true)
        .put("sourcePath", info.sourcePath).put("revision", info.revision).put("hostVersion", info.hostVersion)
        .also { value -> info.previousRevision?.let { value.put("previousRevision", it) }; info.notice?.let { value.put("notice", it) } }

    /** Page recreation is an ownership boundary; routes drop per-document state (core-storage queues its close). */
    fun reset() {
        if (closed) return
        generation.incrementAndGet()
        lifecycleProxy = null
        inFlight.clear()
        routes.forEach { it.reset() }
        auth.reset()
    }

    fun close() {
        if (closed) return
        AgentService.onStopRequested = null
        if (keepAlive) main.post { AgentService.update(executionContext, false) }
        reset()
        closed = true
        routes.forEach { it.close() }
        auth.close()
        fileWorker.shutdown()
    }
}
