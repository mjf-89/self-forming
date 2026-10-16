package md.incept.selfforming

import android.content.Context
import java.io.File
import org.json.JSONObject

/**
 * One editable-app store per process. MainActivity and SettingsActivity share it so a
 * restore made from Android Settings is immediately visible to the running app.
 */
object AppStoreProvider {
    @Volatile private var store: WebAppStore? = null
    @Volatile var error: String? = null
        private set

    @Synchronized fun get(context: Context): WebAppStore? {
        store?.let { return it }
        if (error != null) return null
        return try {
            create(context.applicationContext).also { store = it }
        } catch (failure: Exception) {
            error = "Editable app sources are unavailable: ${failure.message}"
            null
        }
    }

    private fun create(context: Context): WebAppStore {
        val assets = context.assets
        val manifest = assets.open("web/app-manifest.json").bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        if (manifest.getInt("format") != 1 || manifest.getString("hostVersion") != BuildConfig.VERSION_NAME)
            throw HostFailure("APP_INCOMPATIBLE", "Application source manifest does not match this host")
        fun paths(key: String): Set<String> = manifest.getJSONArray(key).let { values -> (0 until values.length()).map { values.getString(it) }.toSet() }
        return WebAppStore(File(context.filesDir, "workspace").toPath(), File(context.noBackupFilesDir, "web-app").toPath(), BuildConfig.VERSION_NAME,
            paths("editableFiles"), paths("immutableFiles")) { name -> assets.open("web/$name") }
    }
}
