package md.incept.selfforming

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONObject

/** core-plugin-management's Kotlin half (R1): plugins.* routes, the PiPlugins event channel, installed
 * plugin assets under /assets/web/plugins/ and the "Disable all plugins" recovery action. */
internal object CorePluginManagementNative : BuiltinNative {
    private const val CHANNEL = "PiPlugins"

    override fun capabilities(into: JSONObject) {
        into.put("plugins", true).put("nativePlugins", true).put("pluginEvents", true).put("pluginRead", true)
    }

    override val channels = setOf(CHANNEL)

    override fun attach(scope: BridgeScope): BridgeRoutes = object : BridgeRoutes {
        /** PiPlugins page epoch: replaced on every reset, so plugin events reach only the current document. */
        @Volatile private var page = Any()
        @Volatile private var closed = false

        override fun handles(method: String) = method.startsWith("plugins.")
        override fun dispatch(call: BridgeCall) = call.worker {
            PluginHost.get(scope.context).dispatch(call.method, call.params, call.done, call.fail, scope.pluginPins)
        }

        /** Only listen messages are accepted; anything else is ignored. */
        override fun receive(channel: String, raw: String, proxy: JavaScriptReplyProxy) {
            if (channel != CHANNEL || closed) return
            val request = PluginEvents.parseListen(raw) ?: return
            val owner = page
            val events = PluginEvents.shared
            events.listen(owner, request.page, request.plugins) { text ->
                // Delivered on the main thread; a newer document never receives an older page's events.
                if (closed || page !== owner) false
                else try { proxy.postMessage(text); true } catch (_: IllegalStateException) { false }
            }
            try { proxy.postMessage(events.ready(request.page)) } catch (_: IllegalStateException) { /* detached */ }
        }

        // PluginHost is process-owned: a page detach neither clears its registry nor
        // unloads code. In-flight plugin mutations have UNKNOWN outcome; never replay them.
        override fun reset() {
            PluginEvents.existing?.detach(page)
            page = Any()
        }
        override fun close() { closed = true }
    }

    override val assetPrefix = PluginHost.ASSET_PREFIX

    override fun openAsset(context: Context, path: String, pins: MutableMap<String, String>): WebResourceResponse? =
        PluginHost.get(context).openAsset(path, pins)?.let { input -> WebResourceResponse(PluginHost.mimeType(path), null, input) }

    override fun recoveryActions() = listOf(RecoveryAction("Disable all plugins") { activity -> disableAll(activity) })

    private fun disableAll(activity: Activity) {
        AlertDialog.Builder(activity).setTitle("Disable all plugins?")
            .setMessage("Plugin data and installed revisions are kept. Already-running native code cannot be unloaded: after disabling, force stop Self Forming in Android App info, then reopen it.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Disable") { _, _ ->
                // Independent of the WebView, plugin registry initialization and native-code executor.
                Thread({
                    val error = try { PluginHost.recoverDisableAll(activity.applicationContext); null }
                        catch (_: Exception) { "Could not save plugin recovery state." }
                    activity.runOnUiThread {
                        if (!activity.isFinishing && !activity.isDestroyed) AlertDialog.Builder(activity)
                            .setTitle(if (error == null) "Plugins disabled" else "Recovery failed")
                            .setMessage(error ?: "Force stop Self Forming from Android App info, then reopen it. Plugin files and data were kept.")
                            .setPositiveButton("OK", null).show()
                    }
                }, "plugin-recovery").start()
            }.show()
    }
}
