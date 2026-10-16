package md.incept.selfforming

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * The auth.* dispatcher and its shared credential store (host, X5). Every provider's record is one [AuthStore]
 * (separately encrypted, own Keystore key): the providers the built-in halves declare ([AuthProvider]: chatgpt in
 * core-providers-chatgpt, claude in core-providers-claude) and the generic plugin credentials ([PluginCredentials]).
 * auth.info/load/save/clear are answered here; the providers' sign-in methods go to their [AuthSignIn].
 * Storage/dispatch has its own actor; long waits register a completion instead of blocking it.
 */
internal class NativeAuth(private val context: Context) {
    private val providers: Map<String, AuthProvider> = BuiltinNatives.ALL.mapNotNull { it.authProvider }.associateBy { it.id }
    // The providers' own paths and aliases are unchanged, so existing installations stay signed in.
    private val stores: Map<String, AuthStore> = providers.mapValues { (_, provider) ->
        AuthStore(File(context.noBackupFilesDir, provider.directory), provider.keyAlias)
    }
    private val signIns: Map<String, AuthSignIn> = providers.mapNotNull { (id, provider) -> provider.signIn(context)?.let { id to it } }.toMap()
    // One record + Keystore key per plugin credential (PluginCredentials); created on demand.
    private val pluginStores = ConcurrentHashMap<String, AuthStore>()
    private val epoch = AtomicLong(0)
    @Volatile private var closed = false

    fun dispatch(method: String, params: JSONObject, done: (Any?) -> Unit, fail: (Throwable) -> Unit) {
        val version = epoch.get()
        val current = { !closed && version == epoch.get() }
        AuthWorker.executor.execute {
            try {
                if (!current()) cancelled()
                val provider = params.optString("provider", "chatgpt")
                val plugin = if (PluginCredentials.isPluginProvider(provider)) PluginCredentials.parse(provider)
                    ?: throw HostFailure("AUTH_PROVIDER", "Plugin credentials use provider plugin:<pluginId>:<name>") else null
                if (plugin != null && method !in PluginCredentials.METHODS)
                    throw HostFailure("AUTH_PROVIDER", "Plugin credentials support only auth.info, auth.load, auth.save and auth.clear")
                val store = if (plugin != null) pluginStores.getOrPut(provider) {
                    AuthStore(File(context.noBackupFilesDir, plugin.directory), plugin.alias)
                } else stores[provider] ?: throw HostFailure("AUTH_PROVIDER", "Unknown sign-in provider")
                when (method) {
                    // Plugin records have no host id of their own: info only says whether one is saved.
                    "auth.info" -> done(if (plugin != null) JSONObject().put("storage", "encrypted").put("saved", store.saved())
                        else JSONObject().put("hostId", store.hostId()).put("storage", "encrypted"))
                    "auth.load" -> done(store.load())
                    "auth.save" -> { store.save(params.getJSONObject("record")); done(null) }
                    "auth.clear" -> { store.clear(); done(null) }
                    else -> {
                        val signIn = signIns[provider]?.takeIf { it.handles(method) }
                        if (signIn != null) signIn.dispatch(method, params, AuthCall(done, fail, current))
                        else throw when (method) {
                            in LOOPBACK_METHODS -> HostFailure("AUTH_PROVIDER", "This provider uses a code from its sign-in page")
                            "auth.openExternal" -> HostFailure("AUTH_PROVIDER", "Unsupported external sign-in provider")
                            else -> HostFailure("METHOD_NOT_FOUND", "Unknown sign-in method")
                        }
                    }
                }
            } catch (error: Exception) {
                // Never send platform exceptions that might include a URL, record, or token.
                fail(if (error is HostFailure) error else HostFailure("AUTH_ERROR", "The sign-in operation failed"))
            }
        }
    }

    fun reset() {
        epoch.incrementAndGet()
        signIns.values.forEach { it.reset() }
    }

    fun close() { closed = true; reset() }
    private fun cancelled(): Nothing = throw HostFailure("AUTH_CANCELLED", "Sign-in cancelled")

    private companion object {
        val LOOPBACK_METHODS = setOf("auth.listen", "auth.open", "auth.wait", "auth.cancel")
    }
}

/** Serializes credential changes across Activity recreation, independently from SQLite. */
private object AuthWorker {
    val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "pi-auth") }
}
