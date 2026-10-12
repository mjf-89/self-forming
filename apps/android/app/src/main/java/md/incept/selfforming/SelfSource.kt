package md.incept.selfforming

import android.content.Context
import android.util.Log
import java.io.File
import java.io.InputStream
import java.util.zip.ZipInputStream

/**
 * Unpacks the app's own source so the agent can rebuild Self Forming on the phone:
 * - workspace/self-forming/ : the repository (with .git and .signing/), only if it does not exist yet.
 *   Existing work there is never overwritten; missing .signing/ and skills/ files are restored.
 * - workspace/self-forming/dist/ : this APK's prebuilt web app, runtime payload and a copy of
 *   source.zip, refreshed whenever a different APK is installed.
 */
object SelfSource {
    private const val TAG = "SelfSource"
    private const val SOURCE = "self-source/source.zip"

    fun installAsync(context: Context) {
        val app = context.applicationContext
        Thread({ try { install(app) } catch (error: Exception) { Log.w(TAG, "Could not unpack app source", error) } }, "pi-self-source").start()
    }

    @Synchronized private fun install(context: Context) {
        val hasSource = try { context.assets.open(SOURCE).close(); true } catch (_: Exception) { false }
        if (!hasSource) return
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val stamp = "${BuildConfig.VERSION_NAME} ${info.lastUpdateTime}"
        val repo = File(context.filesDir, "workspace/self-forming")
        val dist = File(repo, "dist")
        val marker = File(dist, ".installed-apk")
        val fresh = !repo.exists()
        // The key folder and the self-rebuild skill are restored when missing, even if this APK was unpacked before.
        val restore = !fresh && !(File(repo, ".signing/self-forming.p12").isFile && File(repo, ".signing/password").isFile &&
            File(repo, "skills/self-rebuild/SKILL.md").isFile)
        val current = !fresh && marker.isFile && marker.readText() == stamp
        if (current && !restore) return

        context.assets.open(SOURCE).use { unzip(it, repo) { name -> fresh || name.startsWith(".signing/") || name.startsWith("skills/") } }
        if (current) return // only the missing key / skill files were restored; dist/ is already this APK's

        // Prebuilt outputs of this APK: lets the app rebuild without Bun or a runtime download.
        val stage = File(repo, "dist.unpacking")
        stage.deleteRecursively()
        copyAssets(context, "web", File(stage, "app"))
        copyAssets(context, "runtime", File(stage, "runtime/assets/runtime"))
        copyAssets(context, "licenses", File(stage, "runtime/assets/licenses"))
        val libs = File(stage, "runtime/jniLibs/arm64-v8a").apply { mkdirs() }
        for (name in listOf("libproot.so", "libproot-loader.so")) {
            val source = File(context.applicationInfo.nativeLibraryDir, name)
            if (source.isFile) source.copyTo(File(libs, name), overwrite = true).setExecutable(true, false)
        }
        context.assets.open(SOURCE).use { input -> File(stage, "source.zip").outputStream().use { input.copyTo(it) } }
        File(stage, ".installed-apk").writeText(stamp)
        dist.deleteRecursively()
        if (!stage.renameTo(dist)) throw IllegalStateException("Could not publish $dist")
    }

    private fun unzip(input: InputStream, target: File, include: (String) -> Boolean) {
        val root = target.canonicalFile
        ZipInputStream(input).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val name = entry.name
                if (entry.isDirectory || !include(name)) continue
                val file = File(root, name).canonicalFile
                if (!file.path.startsWith(root.path + File.separator)) continue // no path traversal
                if ((name.startsWith(".signing/") || name.startsWith("skills/")) && file.exists()) continue // never overwrite
                file.parentFile?.mkdirs()
                file.outputStream().use { zip.copyTo(it) }
                if (name.endsWith(".sh") || name == "gradlew") file.setExecutable(true, false)
            }
        }
    }

    private fun copyAssets(context: Context, path: String, target: File) {
        val children = context.assets.list(path) ?: return
        if (children.isEmpty()) {
            target.parentFile?.mkdirs()
            try { context.assets.open(path).use { input -> target.outputStream().use { input.copyTo(it) } } } catch (_: Exception) {}
            return
        }
        target.mkdirs()
        for (child in children) copyAssets(context, "$path/$child", File(target, child))
    }
}
