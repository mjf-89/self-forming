package md.incept.selfforming

import org.json.JSONObject
import java.nio.file.Paths

/** core-self-update's bridge route (R1): apk.install for an APK inside the workspace. */
internal object CoreSelfUpdateNative : BuiltinNative {
    override fun capabilities(into: JSONObject) { into.put("apkInstall", true) }

    override fun attach(scope: BridgeScope): BridgeRoutes = object : BridgeRoutes {
        override fun handles(method: String) = method == "apk.install"
        override fun dispatch(call: BridgeCall) = call.worker {
            val raw = call.params.getString("path")
            val workspace = scope.workspace
            val path = if (raw.startsWith("/")) Paths.get(raw).normalize() else workspace.resolve(raw)
            if (!path.startsWith(workspace.root)) throw HostFailure("PATH_DENIED", "The APK must be inside the workspace")
            call.done(JSONObject().put("text", ApkInstaller.install(scope.context, path.toFile())))
        }
    }
}
