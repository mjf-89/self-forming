package md.incept.selfforming

import org.json.JSONObject
import java.io.File

/**
 * core-net-native's Kotlin half (R1, step X4n): the http.* bridge routes (pull-based [NativeHttp] under
 * [NativeHttpPolicy]) and the user-managed [HttpAllowList] (`http.allowList.get/set`), with the `nativeFetch` and
 * `httpAllowList` capability flags. Same method names and JSON shapes as before; the allow-list file stays
 * noBackupFilesDir/http-allow-list.json (process-wide instance). Only these routes read the list: plugin credentials
 * (auth.*) and plugins.* never did, so no host interface is needed. A fork without plugins/core-net-native has
 * neither flag and answers http.* with METHOD_NOT_FOUND (the page then uses browser fetch only).
 */
internal object CoreNetNativeNative : BuiltinNative {
    override fun capabilities(into: JSONObject) {
        into.put("nativeFetch", true).put("httpAllowList", true)
    }

    override fun attach(scope: BridgeScope): BridgeRoutes = object : BridgeRoutes {
        private val allowList = HttpAllowList.shared(File(scope.context.noBackupFilesDir, "http-allow-list.json"))
        private val http = NativeHttp(File(scope.context.cacheDir, "native-http"), allowList = { allowList.entries() })

        override fun handles(method: String) = method.startsWith("http.")

        override fun dispatch(call: BridgeCall) = when (call.method) {
            "http.allowList.get" -> call.worker { call.done(allowList.get()) }
            "http.allowList.set" -> call.worker { call.done(allowList.set(call.params.getJSONArray("entries"))) }
            else -> http.dispatch(call.method, call.params, call.done, call.fail)
        }

        override fun reset() = http.reset()
        override fun close() = http.close()
    }
}
