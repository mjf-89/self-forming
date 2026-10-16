package md.incept.selfforming

import android.content.Context
import dalvik.system.DexClassLoader
import md.incept.selfforming.plugin.PluginContext
import md.incept.selfforming.plugin.PluginModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.*
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Process-owned, trusted code. Paths/immutable snapshots are integrity checks, NOT a sandbox.
 * No module code is run by construction, list, install, enable, rollback, or asset reads.
 * A detached bridge never owns or clears this registry. Calls are not replayed after detach.
 */
class PluginHost internal constructor(
    private val context: Context?, private val root: Path, private val workspace: Path
) {
    private val lock = Any()
    private val registryFile = root.resolve("registry.json")
    private val markerFile = root.resolve("starting.json")
    private val recoveryFile = root.resolve("disabled-all")
    private var registry = JSONObject()
    private var committedRegistry = "{}"
    private val loaded = mutableMapOf<String, Pair<String, PluginModule>>()
    // Even a throwing constructor may have left process-owned resources behind.
    private val attempted = mutableMapOf<String, String>()
    private var recoveryGeneration = 0L

    init {
        PluginFiles.noLinks(root)
        Files.createDirectories(root)
        PluginFiles.noLinks(root)
        registry = if (Files.exists(registryFile, NOFOLLOW_LINKS))
            JSONObject(PluginFiles.text(registryFile, 8 * 1024 * 1024)) else JSONObject()
        committedRegistry = registry.toString()
        if (Files.exists(markerFile, NOFOLLOW_LINKS)) {
            val marker = JSONObject(PluginFiles.text(markerFile, 4096))
            val id = marker.getString("id")
            val hash = marker.getString("hash")
            registry.optJSONObject(id)?.let { row ->
                failures(row).put(hash, "Suspected incomplete native startup (process death can cause false positives); explicitly enable to retry.")
                if (row.optString("hash") == hash) row.put("enabled", false)
            }
            save()
            Files.delete(markerFile)
        }
        if (Files.exists(recoveryFile, NOFOLLOW_LINKS)) {
            registry.keys().forEach { registry.getJSONObject(it).put("enabled", false) }
            save()
        }
    }

    /** Management and code use separate executors: a stuck plugin cannot prevent recovery/list/disable.
     * There is deliberately no timeout claiming that arbitrary native code was interrupted.
     */
    fun dispatch(method: String, params: JSONObject, done: (Any?) -> Unit, fail: (Throwable) -> Unit,
                 pins: MutableMap<String, String>? = null) {
        val executor = if (method == "plugins.call") nativeWorker else managementWorker
        executor.execute {
            val result = try { handle(method, params, pins) } catch (error: Throwable) {
                fail(if (error is HostFailure) error else HostFailure("PLUGIN_ERROR", "Plugin operation failed (${error.javaClass.simpleName.take(120)})"))
                return@execute
            }
            done(result)
        }
    }

    /** pins: the requesting document's pinned revisions (MainActivity), null without a page. */
    internal fun handle(method: String, params: JSONObject, pins: MutableMap<String, String>? = null): Any? {
        val strings = when (method) {
            "plugins.install" -> listOf("path")
            "plugins.enable", "plugins.disable", "plugins.rollback" -> listOf("id")
            "plugins.call" -> listOf("id", "hash", "method")
            "plugins.read" -> listOf("id", "hash", "path")
            else -> emptyList()
        }
        for (key in strings) if (params.opt(key) !is String)
            throw HostFailure("INVALID_REQUEST", "$key must be a string")
        return when (method) {
        "plugins.list" -> synchronized(lock) {
            JSONObject().put("api", 1).put("plugins", JSONArray().also { list ->
                registry.keys().asSequence().toList().sorted().forEach { id ->
                    val row = row(id)
                    val manifest = manifest(id, row.getString("hash"))
                    val status = status(id, row)
                    val metadata = JSONObject()
                    for (key in listOf("id", "name", "version", "web", "native", "provides", "requires", "uses", "reload"))
                        if (manifest.has(key)) metadata.put(key, manifest.get(key))
                    list.put(metadata.put("hash", row.getString("hash"))
                        .put("enabled", row.getBoolean("enabled")).put("state", status.first)
                        .also { status.second?.let { reason -> it.put("reason", reason) } })
                }
            })
        }
        "plugins.install" -> install(params.getString("path"))
        "plugins.enable", "plugins.disable" -> synchronized(lock) {
            val id = PluginFiles.id(params.getString("id"))
            val row = row(id)
            val enabled = method == "plugins.enable"
            // Explicit enable retries a failed hash; never retry simply because a page reopened.
            row.put("enabled", enabled)
            if (enabled) {
                failures(row).remove(row.getString("hash"))
                Files.deleteIfExists(recoveryFile)
            }
            save()
            result(id, row, includeHash = false)
        }
        "plugins.rollback" -> synchronized(lock) {
            val id = PluginFiles.id(params.getString("id"))
            val row = row(id)
            val previous = row.optString("previous")
            if (!PluginFiles.validHash(previous)) throw HostFailure("PLUGIN_NO_PREVIOUS", "No previous plugin revision")
            PluginFiles.verify(snapshot(id, previous), previous)
            val current = row.getString("hash")
            row.put("hash", previous).put("previous", current)
            save()
            result(id, row)
        }
        "plugins.call" -> call(params)
        "plugins.read" -> read(params, pins)
        else -> throw HostFailure("METHOD_NOT_FOUND", "Unknown plugin method")
        }
    }

    private fun install(raw: String): JSONObject {
        val source = PluginFiles.source(workspace, raw)
        // Staging and input revalidation finish before any registry pointer changes.
        val staged = PluginFiles.stage(source, root.resolve("installed"))
        return synchronized(lock) {
            val id = staged.first.getString("id")
            val hash = staged.second
            val old = registry.optJSONObject(id)
            val row = old ?: JSONObject().put("enabled", !Files.exists(recoveryFile, NOFOLLOW_LINKS))
            if (old != null && old.getString("hash") != hash) row.put("previous", old.getString("hash"))
            row.put("hash", hash)
            registry.put(id, row)
            save()
            result(id, row)
        }
    }

    private fun result(id: String, row: JSONObject, includeHash: Boolean = true): JSONObject {
        val status = status(id, row)
        return JSONObject().put("id", id).put("state", status.first)
            .put("restartRequired", attempted.containsKey(id) &&
                (!row.getBoolean("enabled") || attempted[id] != row.getString("hash") || loaded[id] == null))
            .also { if (includeHash) it.put("hash", row.getString("hash")) }
    }

    private fun status(id: String, row: JSONObject): Pair<String, String?> {
        val hash = row.getString("hash")
        val failure = failures(row).optString(hash).takeIf { it.isNotEmpty() }
        if (!row.getBoolean("enabled")) return "disabled" to failure
        if (attempted.containsKey(id) && (attempted[id] != hash || loaded[id] == null && failure == null))
            return "restart-required" to "Native code was already loaded or attempted in this process; restart the app process."
        if (failure != null) return "failed" to failure
        return (if (loaded[id]?.first == hash) "active" else "installed") to null
    }

    // Manifest provides/requires/uses describe WEB composition, including built-in services
    // which need not exist in this installed-package registry. The web runtime resolves that
    // graph and reports blocked composition. M1's Kotlin SDK has no service-binding API:
    // native status describes only snapshot selection and native instance lifecycle, and a
    // native call activates ONLY its targeted id/revision, never declared service providers.

    private fun call(params: JSONObject): Any? {
        val id = PluginFiles.id(params.getString("id"))
        val hash = params.getString("hash")
        val method = params.getString("method")
        if (method.isBlank() || method.length > 256) throw HostFailure("INVALID_REQUEST", "Invalid plugin method")
        val input = params.getJSONObject("input")
        synchronized(lock) {
            val row = row(id)
            if (row.getString("hash") != hash) throw HostFailure("PLUGIN_REVISION_MISMATCH", "Selected plugin revision changed; do not replay mutations automatically")
            val status = status(id, row)
            if (status.first !in setOf("installed", "active")) throw HostFailure("PLUGIN_UNAVAILABLE", status.second ?: "Plugin is ${status.first}")
            if (!manifest(id, hash).has("native")) throw HostFailure("PLUGIN_NO_NATIVE", "Plugin has no native facet")
        }
        activate(id, hash)
        val module = synchronized(lock) {
            val row = row(id)
            if (!row.getBoolean("enabled") || row.getString("hash") != hash)
                throw HostFailure("PLUGIN_REVISION_MISMATCH", "Plugin selection changed before call; no call was made")
            val current = status(id, row)
            if (current.first != "active") throw HostFailure("PLUGIN_UNAVAILABLE", current.second ?: "Plugin is not active")
            loaded[id]?.takeIf { it.first == hash }?.second ?: throw HostFailure("PLUGIN_UNAVAILABLE", "Native plugin is not active")
        }
        try {
            // Serializing on the native executor also bounds conversion failures and non-JSON results.
            val value = module.call(method, input)
            if (value != null && value !== JSONObject.NULL && value !is JSONObject && value !is JSONArray &&
                value !is String && value !is Boolean && value !is Number)
                throw HostFailure("PLUGIN_RESULT", "Plugin call must return a JSON value")
            val encoded = JSONObject().put("value", value ?: JSONObject.NULL).toString()
            if (encoded.toByteArray(Charsets.UTF_8).size > 4 * 1024 * 1024) throw HostFailure("TOO_LARGE", "Plugin result exceeds 4 MiB")
            return JSONObject(encoded).get("value")
        } catch (error: Throwable) {
            // Do not include arbitrary plugin exception messages (which may contain private data).
            if (error is HostFailure) throw error
            throw HostFailure("PLUGIN_CALL_FAILED", "Plugin call threw ${error.javaClass.simpleName.take(120)}; side effects may have occurred, do not automatically retry")
        }
    }

    private fun activate(id: String, expectedHash: String) {
        val selection = synchronized(lock) {
            val row = row(id)
            val hash = row.getString("hash")
            if (hash != expectedHash) throw HostFailure("PLUGIN_REVISION_MISMATCH", "Plugin selection changed before startup")
            if (!row.getBoolean("enabled")) throw HostFailure("PLUGIN_UNAVAILABLE", "Plugin is disabled")
            if (loaded[id]?.first == hash) return
            val manifest = manifest(id, hash)
            if (!manifest.has("native")) return
            if (attempted.containsKey(id)) throw HostFailure("PLUGIN_RESTART_REQUIRED", "Restart the app process before activating this native revision")
            if (failures(row).has(hash)) throw HostFailure("PLUGIN_FAILED", "Explicitly enable the plugin to retry failed startup")
            Triple(hash, manifest, recoveryGeneration)
        }
        val (hash, manifest, generation) = selection
        val directory = snapshot(id, hash)
        PluginFiles.verify(directory, hash)
        val app = context ?: throw HostFailure("PLUGIN_UNAVAILABLE", "Android context is unavailable")
        val data = root.resolve("data").resolve(id)
        PluginFiles.noLinks(data); Files.createDirectories(data); PluginFiles.noLinks(data)
        synchronized(lock) {
            val row = row(id)
            if (recoveryGeneration != generation || !row.getBoolean("enabled") || row.getString("hash") != hash)
                throw HostFailure("PLUGIN_UNAVAILABLE", "Selection changed before native startup")
            // Durable marker precedes class loading, initialization, construction AND start().
            PluginFiles.atomic(markerFile, JSONObject().put("id", id).put("hash", hash).toString())
            attempted[id] = hash
        }
        var module: PluginModule? = null
        try {
            val native = manifest.getJSONObject("native")
            val optimized = File(app.codeCacheDir, "plugins/$id/$hash").apply { mkdirs() }
            val loader = DexClassLoader(directory.resolve(native.getString("jar")).toString(), optimized.path, null,
                PluginModule::class.java.classLoader)
            module = loader.loadClass(native.getString("class")).getDeclaredConstructor().newInstance() as PluginModule
            // emit is bound to this id/revision; events reach only the current page (PluginEvents).
            module.start(PluginContext(app, id, data.toFile()) { event, value -> PluginEvents.shared.emit(id, hash, event, value) })
            synchronized(lock) {
                val row = row(id)
                if (recoveryGeneration != generation || !row.getBoolean("enabled") || row.getString("hash") != hash)
                    throw HostFailure("PLUGIN_UNAVAILABLE", "Selection changed during native startup; restart required")
                loaded[id] = hash to module
                Files.deleteIfExists(markerFile)
            }
        } catch (error: Throwable) {
            var recorded = false
            try {
                synchronized(lock) {
                    loaded.remove(id)
                    failures(row(id)).put(hash, "Native startup failed (${error.javaClass.simpleName.take(120)}); restart the process and explicitly enable to retry.")
                    save()
                    recorded = true
                }
            } finally {
                // Best effort, off main thread, even when writing the failure failed. The marker
                // remains if persistence failed or cleanup hangs/crashes; next boot is conservative.
                try { module?.stop() } catch (_: Throwable) { /* preserve the original failure */ }
                if (recorded) synchronized(lock) { Files.deleteIfExists(markerFile) }
            }
            throw HostFailure("PLUGIN_START_FAILED", "Native startup failed; revision retained, plugin data is not rolled back; process restart may be required")
        }
    }

    /** Does not wait for plugin code or invoke stop(). Already-running trusted code cannot be revoked.
     * The independent marker also makes recovery possible when registry parsing is broken.
     */
    fun disableAll() = synchronized(lock) {
        PluginFiles.atomic(recoveryFile, "disabled\n")
        recoveryGeneration++
        registry.keys().forEach { registry.getJSONObject(it).put("enabled", false) }
        save()
    }

    /** Each document pins its first selected hash per id; old installed snapshots are retained. */
    fun openAsset(path: String, pins: MutableMap<String, String>): InputStream? = synchronized(lock) {
        val parts = path.removePrefix(ASSET_PREFIX).split('/')
        if (!path.startsWith(ASSET_PREFIX) || parts.size < 4 || parts[2] != "web") return null
        val id = PluginFiles.id(parts[0]); val hash = parts[1]
        if (!PluginFiles.validHash(hash)) return null
        val file = snapshotFile(id, hash, parts.drop(2).joinToString("/"), pins) ?: return null
        val stream = Files.newInputStream(file, READ, NOFOLLOW_LINKS)
        pins[id] = hash
        stream
    }

    /** The asset-serving rules (caller holds lock): the document's pinned hash, else only the
     * enabled, selected revision (fully reverified). Null = not served; HostFailure = bad path. */
    private fun snapshotFile(id: String, hash: String, relative: String, pins: Map<String, String>?): Path? {
        val row = registry.optJSONObject(id) ?: return null
        val pinned = pins?.get(id)
        if (pinned != null && pinned != hash) return null
        if (pinned == null && (!row.getBoolean("enabled") || row.getString("hash") != hash)) return null
        PluginFiles.relative(relative)
        val directory = snapshot(id, hash)
        val file = directory.resolve(relative)
        PluginFiles.noLinks(file)
        if (!Files.isRegularFile(file, NOFOLLOW_LINKS) || !PluginFiles.readOnly(file)) return null
        if (pinned == null) PluginFiles.verify(directory, hash)
        return file
    }

    /** plugins.read {id, hash, path, encoding?: "auto"|"text"|"base64"} → {path, size, encoding, text|data}.
     * Same revision rules as served assets (pinned, else selected+enabled; pins the revision for
     * the page like a served asset), canonical path beneath web/, at most MAX_READ_BYTES. */
    private fun read(params: JSONObject, pins: MutableMap<String, String>?): JSONObject {
        val id = PluginFiles.id(params.getString("id"))
        val hash = params.getString("hash")
        val path = params.getString("path")
        if (!PluginFiles.validHash(hash)) throw HostFailure("INVALID_REQUEST", "Invalid plugin revision hash")
        val encoding = params.opt("encoding") ?: "auto"
        if (encoding !in setOf("auto", "text", "base64")) throw HostFailure("INVALID_REQUEST", "encoding must be auto, text or base64")
        PluginFiles.relative(path)
        if (!path.startsWith("web/")) throw HostFailure("PLUGIN_READ_PATH", "Only files beneath web/ of a plugin can be read")
        val bytes = synchronized(lock) {
            val row = row(id)
            val pinned = pins?.get(id)
            val revisionAllowed = if (pinned != null) pinned == hash else row.getBoolean("enabled") && row.getString("hash") == hash
            if (!revisionAllowed) throw HostFailure("PLUGIN_REVISION_MISMATCH", "Only the selected or this page's pinned plugin revision can be read")
            val file = snapshotFile(id, hash, path, pins) ?: throw HostFailure("NOT_FOUND", "No such readable file in the plugin revision")
            if (Files.size(file) > MAX_READ_BYTES) throw HostFailure("TOO_LARGE", "Plugin file exceeds 1 MiB")
            val content = Files.newInputStream(file, READ, NOFOLLOW_LINKS).use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(65536)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    if (output.size() + n > MAX_READ_BYTES) throw HostFailure("TOO_LARGE", "Plugin file exceeds 1 MiB")
                    output.write(buffer, 0, n)
                }
                output.toByteArray()
            }
            pins?.put(id, hash)
            content
        }
        val text = if (encoding == "base64") null else try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: java.nio.charset.CharacterCodingException) {
            if (encoding == "text") throw HostFailure("INVALID_UTF8", "Plugin file is not UTF-8 text; read it as base64")
            null
        }
        val result = JSONObject().put("path", path).put("size", bytes.size)
        return if (text != null) result.put("encoding", "text").put("text", text)
        else result.put("encoding", "base64").put("data", java.util.Base64.getEncoder().encodeToString(bytes))
    }

    private fun row(id: String): JSONObject = registry.optJSONObject(id)
        ?: throw HostFailure("PLUGIN_NOT_FOUND", "Plugin is not installed")
    private fun failures(row: JSONObject): JSONObject = row.optJSONObject("failures")
        ?: JSONObject().also { row.put("failures", it) }
    private fun snapshot(id: String, hash: String): Path {
        PluginFiles.id(id)
        if (!PluginFiles.validHash(hash)) throw HostFailure("PLUGIN_INTEGRITY", "Invalid installed revision hash")
        return root.resolve("installed").resolve(id).resolve(hash)
    }
    private fun manifest(id: String, hash: String) = PluginFiles.manifest(snapshot(id, hash))
    private fun save() {
        val text = registry.toString()
        try {
            if (text.toByteArray(Charsets.UTF_8).size > 8 * 1024 * 1024)
                throw HostFailure("TOO_LARGE", "Plugin registry exceeds 8 MiB")
            PluginFiles.atomic(registryFile, text)
            committedRegistry = text
        } catch (error: Exception) {
            // A failed publication must not leave a pointer selected only in memory. If rename
            // succeeded but directory sync failed, use the actual atomic file rather than guessing.
            registry = try {
                if (Files.exists(registryFile, NOFOLLOW_LINKS)) JSONObject(PluginFiles.text(registryFile, 8 * 1024 * 1024))
                else JSONObject(committedRegistry)
            } catch (_: Exception) { JSONObject(committedRegistry) }
            if (Files.exists(recoveryFile, NOFOLLOW_LINKS)) registry.keys().forEach { registry.getJSONObject(it).put("enabled", false) }
            throw error
        }
    }

    companion object {
        const val ASSET_PREFIX = "/assets/web/plugins/"
        const val MAX_READ_BYTES = 1024 * 1024
        private val managementWorker = Executors.newSingleThreadExecutor { Thread(it, "plugin-management") }
        private val nativeWorker = Executors.newSingleThreadExecutor { Thread(it, "plugin-native") }
        @Volatile private var instance: PluginHost? = null
        /** Android hands out filesDir as /data/user/0/<pkg>/files, where /data/user/0 is a system symlink to
         * /data/data. Resolve the app's own directory once; link checks then apply only to what lies inside it. */
        internal fun appFiles(context: Context): java.nio.file.Path = context.filesDir.toPath().toRealPath()
        fun get(context: Context): PluginHost = instance ?: synchronized(this) {
            instance ?: PluginHost(context.applicationContext, appFiles(context).resolve("plugins"),
                appFiles(context).resolve("workspace")).also { instance = it }
        }
        /** Independent of registry loading, WebView bootstrap, and the native executor. */
        fun recoverDisableAll(context: Context) = synchronized(this) {
            val root = appFiles(context).resolve("plugins")
            PluginFiles.noLinks(root); Files.createDirectories(root)
            PluginFiles.atomic(root.resolve("disabled-all"), "disabled\n")
            instance?.disableAll()
            Unit
        }
        fun mimeType(name: String): String = when (name.substringAfterLast('.').lowercase(java.util.Locale.ROOT)) {
            "js", "mjs" -> "application/javascript"
            "html", "htm" -> "text/html"
            "css" -> "text/css"
            "json", "map" -> "application/json"
            "wasm" -> "application/wasm"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "ico" -> "image/x-icon"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            "txt", "md" -> "text/plain"
            "mp3" -> "audio/mpeg"
            "ogg" -> "audio/ogg"
            "wav" -> "audio/wav"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            else -> "application/octet-stream"
        }
    }
}

/** Filesystem-only staging, also exercised without Android/DexClassLoader in focused JVM tests. */
internal object PluginFiles {
    const val MAX_BYTES = 64L * 1024 * 1024
    const val MAX_FILES = 4096
    const val MAX_MANIFEST = 1024 * 1024
    private val idPattern = Regex("[a-z][a-z0-9-]{1,63}")
    private val hashPattern = Regex("[a-f0-9]{64}")
    private val writes = setOf(PosixFilePermission.OWNER_WRITE, PosixFilePermission.GROUP_WRITE, PosixFilePermission.OTHERS_WRITE)
    fun id(value: String): String {
        if (!idPattern.matches(value)) invalid("Plugin id must match [a-z][a-z0-9-]{1,63}")
        return value
    }
    fun validHash(value: String) = hashPattern.matches(value)
    fun relative(value: String): String {
        if (value.isEmpty() || value.length > 4096 || value.contains('\\') || value.any { it.code < 32 } ||
            value.split('/').any { it.isEmpty() || it == "." || it == ".." } || Regex("^[A-Za-z]:").containsMatchIn(value))
            invalid("Use a relative plugin path without parent components")
        return value
    }
    fun noLinks(path: Path) {
        var current = path.toAbsolutePath().root
        for (part in path.toAbsolutePath()) {
            current = current.resolve(part)
            if (Files.isSymbolicLink(current)) invalid("Symbolic links are not allowed in plugin paths")
        }
    }
    fun source(workspace: Path, raw: String): Path {
        val base = workspace.toAbsolutePath().normalize()
        val path = if (raw.startsWith('/')) {
            // Check raw components before normalizing: parent traversal is never accepted.
            relative(raw.removePrefix("/"))
            File(raw).toPath()
        } else base.resolve(relative(raw))
        if (!path.normalize().startsWith(base) || path == base) invalid("Plugin package must be inside the workspace")
        noLinks(path)
        if (!Files.isDirectory(path, NOFOLLOW_LINKS)) invalid("Plugin package path is not a directory")
        return path
    }
    private fun integer(json: JSONObject, key: String): Int {
        val value = json.get(key)
        if (value !is Number || value.toDouble() != value.toInt().toDouble() || value.toInt() <= 0)
            invalid("$key must be a positive integer")
        return value.toInt()
    }
    fun manifest(root: Path): JSONObject {
        val value = JSONObject(text(root.resolve("plugin.json"), MAX_MANIFEST))
        for (key in listOf("id", "name", "version", "reload")) if (value.opt(key) !is String) invalid("$key must be a string")
        id(value.getString("id"))
        if (integer(value, "api") != 1) invalid("Unsupported plugin API; this host supports api: 1")
        for (key in listOf("name", "version")) if (value.getString(key).isBlank() || value.getString(key).length > 256) invalid("Invalid $key")
        if (!value.has("web") && !value.has("native")) invalid("Plugin needs a web or native facet")
        value.optJSONObject("web")?.let {
            if (it.opt("entry") !is String) invalid("web.entry must be a string")
            val entry = relative(it.getString("entry"))
            if (!entry.startsWith("web/")) invalid("web.entry must be beneath web/")
        } ?: run { if (value.has("web")) invalid("web must be an object") }
        value.optJSONObject("native")?.let {
            if (it.opt("jar") !is String || it.opt("class") !is String) invalid("native.jar and native.class must be strings")
            if (relative(it.getString("jar")) != "native/module.jar") invalid("M1 ships the native jar at native/module.jar")
            if (!Regex("[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)+").matches(it.getString("class"))) invalid("Invalid native class name")
        } ?: run { if (value.has("native")) invalid("native must be an object") }
        val reload = value.getString("reload")
        if (reload !in setOf("scope", "page", "restart") || value.has("native") && reload != "restart") invalid("Native plugins require reload: restart; web plugins use scope, page, or restart")
        for (key in listOf("provides", "requires", "uses")) {
            val declarations = if (value.has(key)) value.getJSONArray(key) else JSONArray().also { value.put(key, it) }
            val seen = mutableSetOf<String>()
            for (i in 0 until declarations.length()) {
                val service = declarations.getJSONObject(i)
                if (service.opt("id") !is String) invalid("Service id must be a string")
                val serviceId = service.getString("id")
                if (serviceId.isBlank() || serviceId.length > 256 || serviceId.any { it.code < 32 }) invalid("Invalid service id")
                val version = integer(service, "version")
                if (!seen.add("$serviceId@$version")) invalid("Duplicate $key declaration")
            }
        }
        return value
    }
    fun text(path: Path, limit: Int): String {
        noLinks(path)
        if (!Files.isRegularFile(path, NOFOLLOW_LINKS) || Files.size(path) > limit) invalid("Missing or oversized ${path.fileName}")
        val bytes = Files.newInputStream(path, READ, NOFOLLOW_LINKS).use { input ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size().toLong() + count > limit) invalid("File grew beyond its limit")
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
        return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    }
    private data class Entry(val path: String, val size: Long, val digest: String, val modified: java.nio.file.attribute.FileTime, val key: Any?)
    private fun inventory(root: Path): List<Entry> {
        noLinks(root)
        val paths = mutableListOf<Path>()
        fun add(path: Path) {
            noLinks(path)
            if (!Files.isRegularFile(path, NOFOLLOW_LINKS)) invalid("Shipped plugin files must be regular files")
            if (paths.size >= MAX_FILES) invalid("Plugin exceeds 4096 shipped files")
            relative(root.relativize(path).toString())
            paths.add(path)
        }
        add(root.resolve("plugin.json"))
        val web = root.resolve("web")
        if (Files.exists(web, NOFOLLOW_LINKS)) {
            noLinks(web)
            if (!Files.isDirectory(web, NOFOLLOW_LINKS)) invalid("web must be a directory")
            // Depth bounded as well as file count; do not follow symlinks or walk native sources.
            var directories = 0
            Files.walk(web, 64).use { stream -> stream.forEach { path ->
                if (Files.isDirectory(path, NOFOLLOW_LINKS) && ++directories > MAX_FILES) invalid("Plugin has excessive directories")
                noLinks(path)
                if (!Files.isDirectory(path, NOFOLLOW_LINKS)) add(path)
                else if (web.relativize(path).nameCount >= 64) invalid("Plugin directory nesting is excessive")
            } }
        }
        val jar = root.resolve("native/module.jar")
        noLinks(jar)
        if (Files.exists(jar, NOFOLLOW_LINKS)) add(jar)
        var total = 0L
        // Match LC_ALL=C tooling: canonical path ordering is unsigned UTF-8 byte order,
        // not Kotlin's UTF-16 order (which differs for supplementary characters).
        return paths.sortedWith { a, b -> comparePaths(root.relativize(a).toString(), root.relativize(b).toString()) }.map { path ->
            val before = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
            total += before.size()
            if (total > MAX_BYTES || path.fileName.toString() == "plugin.json" && before.size() > MAX_MANIFEST) invalid("Plugin exceeds shipped size limits (64 MiB total, 1 MiB manifest)")
            val digest = digestFile(path, before.size())
            val after = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
            if (before.size() != after.size() || before.lastModifiedTime() != after.lastModifiedTime() || before.fileKey() != after.fileKey()) invalid("Plugin source changed while reading; rebuild and retry")
            Entry(root.relativize(path).toString(), before.size(), digest, before.lastModifiedTime(), before.fileKey())
        }
    }
    private fun comparePaths(a: String, b: String): Int {
        val left = a.toByteArray(Charsets.UTF_8); val right = b.toByteArray(Charsets.UTF_8)
        for (i in 0 until minOf(left.size, right.size)) {
            val comparison = (left[i].toInt() and 255).compareTo(right[i].toInt() and 255)
            if (comparison != 0) return comparison
        }
        return left.size.compareTo(right.size)
    }
    private fun digestFile(path: Path, expected: Long): String {
        val digest = MessageDigest.getInstance("SHA-256")
        var count = 0L
        Files.newInputStream(path, READ, NOFOLLOW_LINKS).use { input ->
            val buffer = ByteArray(65536)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                count += n
                if (count > expected || count > MAX_BYTES) invalid("Plugin file changed or exceeds size limit")
                digest.update(buffer, 0, n)
            }
        }
        if (count != expected) invalid("Plugin source changed while reading")
        return hex(digest.digest())
    }
    private fun hash(entries: List<Entry>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        entries.forEach { digest.update((it.path + "\u0000" + it.digest + "\n").toByteArray(Charsets.UTF_8)) }
        return hex(digest.digest())
    }
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    fun readOnly(path: Path): Boolean = Files.getPosixFilePermissions(path, NOFOLLOW_LINKS).none { it in writes }
    private fun freeze(path: Path, directory: Boolean = false) = Files.setPosixFilePermissions(path,
        if (directory) setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_EXECUTE)
        else setOf(PosixFilePermission.OWNER_READ))

    fun stage(source: Path, installed: Path): Pair<JSONObject, String> {
        val before = inventory(source)
        val metadata = manifest(source)
        val expected = hash(before)
        val parent = installed.resolve(metadata.getString("id"))
        noLinks(parent); Files.createDirectories(parent); noLinks(parent)
        val temporary = Files.createTempDirectory(parent, ".stage-")
        try {
            for (entry in before) {
                val from = source.resolve(entry.path)
                noLinks(from)
                val to = temporary.resolve(entry.path)
                Files.createDirectories(to.parent)
                // Android 14 sequence: OPEN a new descriptor, mark inode read-only, THEN write bytes
                // through the already-open descriptor. Never load a writable dex or reuse its inode.
                FileChannel.open(to, CREATE_NEW, WRITE, NOFOLLOW_LINKS).use { output ->
                    freeze(to)
                    Files.newInputStream(from, READ, NOFOLLOW_LINKS).use { input ->
                        val buffer = ByteArray(65536)
                        var count = 0L
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            count += n
                            if (count > entry.size) invalid("Plugin source changed while staging")
                            val bytes = ByteBuffer.wrap(buffer, 0, n)
                            while (bytes.hasRemaining()) output.write(bytes)
                        }
                        if (count != entry.size) invalid("Plugin source changed while staging")
                    }
                    output.force(true)
                }
            }
            verify(temporary, expected)
            if (manifest(temporary).toString() != metadata.toString()) invalid("Plugin manifest changed while staging")
            if (inventory(source) != before) invalid("Plugin source changed while staging; publish a finished build and retry")
            Files.walk(temporary).use { stream -> stream.filter { Files.isDirectory(it, NOFOLLOW_LINKS) }
                .sorted(Comparator.reverseOrder()).forEach { freeze(it, true); syncDirectory(it) } }
            val destination = parent.resolve(expected)
            if (Files.exists(destination, NOFOLLOW_LINKS)) verify(destination, expected)
            else { Files.move(temporary, destination, ATOMIC_MOVE); syncDirectory(parent) }
            return metadata to expected
        } finally {
            if (Files.exists(temporary, NOFOLLOW_LINKS)) {
                Files.walk(temporary).use { stream -> stream.filter { Files.isDirectory(it, NOFOLLOW_LINKS) }
                    .forEach { it.toFile().setWritable(true, true) } }
                Files.walk(temporary).use { stream -> stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
            }
        }
    }
    fun verify(root: Path, expected: String) {
        val entries = inventory(root)
        if (hash(entries) != expected) invalid("Installed plugin hash does not match; reinstall from a finished build")
        entries.forEach { if (!readOnly(root.resolve(it.path))) invalid("Installed plugin code must be read-only") }
        val metadata = manifest(root)
        metadata.optJSONObject("web")?.let { web ->
            if (entries.none { it.path == web.getString("entry") }) invalid("Missing web entry")
        }
        metadata.optJSONObject("native")?.let { native ->
            if (entries.none { it.path == native.getString("jar") }) invalid("Missing native jar")
        }
    }
    fun atomic(path: Path, text: String) {
        noLinks(path); Files.createDirectories(path.parent); noLinks(path)
        val temporary = Files.createTempFile(path.parent, ".plugin-", ".tmp")
        try {
            FileChannel.open(temporary, WRITE, NOFOLLOW_LINKS).use { channel ->
                val buffer = ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8))
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
            Files.move(temporary, path, ATOMIC_MOVE, REPLACE_EXISTING)
            syncDirectory(path.parent)
        } finally { Files.deleteIfExists(temporary) }
    }
    private fun syncDirectory(path: Path) { FileChannel.open(path, READ).use { it.force(true) } }
    private fun invalid(reason: String): Nothing = throw HostFailure("PLUGIN_INVALID", reason)
}
