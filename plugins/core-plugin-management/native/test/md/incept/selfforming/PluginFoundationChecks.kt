package md.incept.selfforming

import org.json.JSONObject
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest

/** Standalone JVM contract checks. Compile together with PluginHost.kt, PluginApi.kt and
 * HostFailure.kt against android.jar and a real org.json jar (Android's mockable stubs cannot
 * execute JSON operations). Run this object's main with kotlin-stdlib + org.json + android.jar.
 * No APK, Gradle, Android plugin loading, or real app data is involved.
 */
object PluginFoundationChecks {
    private lateinit var temporary: Path
    private var checks = 0
    @JvmStatic fun main(args: Array<String>) {
        temporary = Files.createTempDirectory("plugin-foundation-check-")
        try {
            check("snapshot hash, read-only files, excluded native sources") { snapshot() }
            check("path traversal and symlinks") { paths() }
            check("manifest validation and API compatibility") { manifests() }
            check("manifest, total byte and shipped file limits") { limits() }
            check("integrity revalidation") { integrity() }
            check("install and list never load native code; mismatch rejected") { management() }
            check("previous pointer rollback and failed install preservation") { rollback() }
            check("failed registry publication restores committed in-memory selection") { publicationFailure() }
            check("page-pinned immutable assets and MIME") { assets() }
            check("startup marker suspicion and explicit retry") { marker() }
            check("disable-all preserves code/data and survives reopen") { recovery() }
            check("native revision replacement truthfully requires restart") { restart() }
            check("native calls are pinned, bounded and never retried on exceptions") { nativeCalls() }
            check("web composition never blocks native state or starts other native providers") { compositionBoundary() }
            check("app directory behind a system symlink is resolved; links inside plugin paths still rejected") { systemSymlink() }
            if (args.size == 2) check("tooling-built package canonical hash agrees with native host") {
                val actual = PluginFiles.stage(java.io.File(args[0]).toPath(), folder()).second
                equal(args[1], actual)
                println("Counter snapshot: $actual")
            }
            println("PASS: $checks focused plugin checks")
        } finally {
            Files.walk(temporary).use { stream -> stream.filter { Files.isDirectory(it) }.forEach { it.toFile().setWritable(true, true) } }
            Files.walk(temporary).use { stream -> stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
        }
    }
    private fun check(name: String, block: () -> Unit) { block(); checks++; println("PASS: $name") }
    private fun equal(expected: Any?, actual: Any?) { require(expected == actual) { "Expected $expected, got $actual" } }
    private fun rejects(code: String? = null, block: () -> Unit) {
        try { block() } catch (error: HostFailure) { if (code != null) equal(code, error.code); return }
        error("Expected HostFailure")
    }
    private fun folder() = Files.createTempDirectory(temporary, "case-")
    private fun metadata(id: String = "counter", native: Boolean = false): JSONObject = JSONObject()
        .put("id", id).put("name", "Counter").put("version", "0.1.0").put("api", 1)
        .put("web", JSONObject().put("entry", "web/index.js"))
        .put("reload", if (native) "restart" else "scope")
        .put("provides", org.json.JSONArray()).put("requires", org.json.JSONArray()).put("uses", org.json.JSONArray())
        .also { if (native) it.put("native", JSONObject().put("jar", "native/module.jar").put("class", "example.Counter")) }
    private fun write(root: Path, path: String, text: String) {
        val file = root.resolve(path); Files.createDirectories(file.parent); Files.write(file, text.toByteArray())
    }
    private fun source(root: Path = folder(), id: String = "counter", native: Boolean = false): Path {
        write(root, "plugin.json", metadata(id, native).toString())
        write(root, "web/index.js", "export const value = 1;")
        if (native) write(root, "native/module.jar", "Deliberately not executable: management must never load this")
        return root
    }
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun snapshot() {
        val source = source(native = true)
        write(source, "native/src/Ignore.kt", "not shipped")
        write(source, "web/\uE000.js", "bmp")
        write(source, "web/\uD800\uDC00.js", "supplementary")
        val installed = folder()
        val (manifest, hash) = PluginFiles.stage(source, installed)
        equal("counter", manifest.getString("id"))
        val expected = listOf("native/module.jar", "plugin.json", "web/index.js", "web/\uE000.js", "web/\uD800\uDC00.js").joinToString("") {
            it + "\u0000" + sha(Files.readAllBytes(source.resolve(it))) + "\n"
        }
        equal(sha(expected.toByteArray()), hash)
        val snapshot = installed.resolve("counter/$hash")
        require(!Files.exists(snapshot.resolve("native/src/Ignore.kt")))
        for (file in listOf("native/module.jar", "plugin.json", "web/index.js")) require(PluginFiles.readOnly(snapshot.resolve(file)))
        write(source, "web/index.js", "edited")
        equal("export const value = 1;", String(Files.readAllBytes(snapshot.resolve("web/index.js"))))
        val second = PluginFiles.stage(source, installed).second
        require(second != hash)
        PluginFiles.verify(snapshot, hash)
        equal(second, PluginFiles.stage(source, installed).second)
    }
    private fun paths() {
        for (path in listOf("/web/file", "web/../file", "web//file", "web/./file", "web\\file", "C:/file", "web/line\nbreak")) rejects { PluginFiles.relative(path) }
        val workspace = folder(); val pkg = source(workspace.resolve("plugins/counter"))
        equal(pkg, PluginFiles.source(workspace, "plugins/counter"))
        equal(pkg, PluginFiles.source(workspace, pkg.toString()))
        rejects { PluginFiles.source(workspace, "plugins/../plugins/counter") }
        rejects { PluginFiles.source(workspace, folder().toString()) }
        Files.createSymbolicLink(pkg.resolve("web/link"), pkg.resolve("plugin.json"))
        rejects { PluginFiles.stage(pkg, folder()) }
        Files.delete(pkg.resolve("web/link"))
        Files.createSymbolicLink(workspace.resolve("linked"), pkg)
        rejects { PluginFiles.source(workspace, "linked") }
    }
    private fun manifests() {
        val pkg = source()
        for (bad in listOf(
            metadata().put("id", "x"), metadata().put("api", 2), metadata().put("api", "1"),
            metadata().put("web", JSONObject().put("entry", "../index.js")),
            metadata().put("web", JSONObject().put("entry", "native/index.js")),
            metadata(native = true).put("reload", "scope"),
            metadata().put("provides", org.json.JSONArray("[{\"id\":\"thing\",\"version\":1.5}]"))
        )) {
            write(pkg, "plugin.json", bad.toString()); rejects { PluginFiles.manifest(pkg) }
        }
        val nativeOnly = metadata(native = true).also { it.remove("web") }
        write(pkg, "plugin.json", nativeOnly.toString())
        equal("counter", PluginFiles.manifest(pkg).getString("id"))
    }
    private fun limits() {
        val pkg = source()
        Files.newByteChannel(pkg.resolve("web/large"), java.nio.file.StandardOpenOption.CREATE, WRITE).use {
            it.position(PluginFiles.MAX_BYTES); it.write(java.nio.ByteBuffer.wrap(byteArrayOf(0)))
        }
        rejects { PluginFiles.stage(pkg, folder()) }
        Files.delete(pkg.resolve("web/large"))
        write(pkg, "plugin.json", " ".repeat(PluginFiles.MAX_MANIFEST + 1))
        rejects { PluginFiles.stage(pkg, folder()) }
        write(pkg, "plugin.json", metadata().toString())
        for (i in 0 until PluginFiles.MAX_FILES) write(pkg, "web/f$i", "")
        rejects { PluginFiles.stage(pkg, folder()) }
    }
    private fun integrity() {
        val installed = folder()
        val hash = PluginFiles.stage(source(), installed).second
        val root = installed.resolve("counter/$hash")
        val file = root.resolve("web/index.js")
        Files.setPosixFilePermissions(file, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
        rejects { PluginFiles.verify(root, hash) }
        Files.write(file, "tampered".toByteArray())
        Files.setPosixFilePermissions(file, setOf(PosixFilePermission.OWNER_READ))
        rejects { PluginFiles.verify(root, hash) }
    }
    private class Fixture {
        val workspace = folder()
        val root = folder()
        val pkg = source(workspace.resolve("plugins/counter"), native = true)
        val host = PluginHost(null, root, workspace)
        fun install() = host.handle("plugins.install", JSONObject().put("path", pkg.toString())) as JSONObject
        fun list() = host.handle("plugins.list", JSONObject()) as JSONObject
        fun action(action: String) = host.handle("plugins.$action", JSONObject().put("id", "counter")) as JSONObject
    }
    private fun management() {
        val f = Fixture()
        val result = f.install()
        equal("installed", result.getString("state")); equal(false, result.getBoolean("restartRequired"))
        equal("installed", f.list().getJSONArray("plugins").getJSONObject(0).getString("state"))
        rejects("PLUGIN_REVISION_MISMATCH") {
            f.host.handle("plugins.call", JSONObject().put("id", "counter").put("hash", "0".repeat(64)).put("method", "inc").put("input", JSONObject()))
        }
        require(!Files.exists(f.root.resolve("starting.json")))
        f.action("disable"); equal("disabled", f.list().getJSONArray("plugins").getJSONObject(0).getString("state"))
        equal("installed", f.action("enable").getString("state"))
    }
    private fun rollback() {
        val f = Fixture()
        val first = f.install().getString("hash")
        write(f.pkg, "web/index.js", "second")
        val second = f.install().getString("hash")
        equal(first, f.action("rollback").getString("hash"))
        equal(second, f.action("rollback").getString("hash"))
        write(f.pkg, "plugin.json", metadata().put("api", 99).toString())
        rejects { f.install() }
        equal(second, f.list().getJSONArray("plugins").getJSONObject(0).getString("hash"))
        require(Files.exists(f.root.resolve("installed/counter/$first/native/module.jar")))
        val persisted = JSONObject(String(Files.readAllBytes(f.root.resolve("registry.json"))))
        equal(first, persisted.getJSONObject("counter").getString("previous"))
    }
    private fun publicationFailure() {
        val f = Fixture(); f.install()
        Files.setPosixFilePermissions(f.root, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_EXECUTE))
        try {
            try { f.action("disable"); error("Expected publication failure") } catch (_: java.io.IOException) { /* expected */ }
        } finally {
            Files.setPosixFilePermissions(f.root, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE))
        }
        equal(true, f.list().getJSONArray("plugins").getJSONObject(0).getBoolean("enabled"))
        equal("disabled", f.action("disable").getString("state"))
    }
    private fun assets() {
        val f = Fixture(); val first = f.install().getString("hash")
        val pins = mutableMapOf<String, String>()
        fun url(hash: String) = PluginHost.ASSET_PREFIX + "counter/$hash/web/index.js"
        equal("export const value = 1;", f.host.openAsset(url(first), pins)!!.bufferedReader().use { it.readText() })
        write(f.pkg, "web/index.js", "second"); val second = f.install().getString("hash")
        equal("export const value = 1;", f.host.openAsset(url(first), pins)!!.bufferedReader().use { it.readText() })
        equal(null, f.host.openAsset(url(second), pins))
        equal(null, f.host.openAsset(url(first), mutableMapOf()))
        equal("second", f.host.openAsset(url(second), mutableMapOf())!!.bufferedReader().use { it.readText() })
        val secondPins = mutableMapOf<String, String>()
        equal("second", f.host.openAsset(url(second), secondPins)!!.bufferedReader().use { it.readText() })
        f.action("disable")
        equal(null, f.host.openAsset(url(second), mutableMapOf()))
        equal("second", f.host.openAsset(url(second), secondPins)!!.bufferedReader().use { it.readText() })
        equal(first, f.action("rollback").getString("hash"))
        equal(null, f.host.openAsset(url(first), mutableMapOf()))
        f.action("enable")
        equal("export const value = 1;", f.host.openAsset(url(first), mutableMapOf())!!.bufferedReader().use { it.readText() })
        equal("second", f.host.openAsset(url(second), secondPins)!!.bufferedReader().use { it.readText() })
        equal(null, f.host.openAsset(url(second), mutableMapOf()))
        equal(null, f.host.openAsset(PluginHost.ASSET_PREFIX + "counter/$second/native/module.jar", mutableMapOf()))
        rejects { f.host.openAsset(PluginHost.ASSET_PREFIX + "counter/$first/web/../../registry.json", mutableMapOf()) }
        equal("application/javascript", PluginHost.mimeType("index.mjs"))
        equal("application/wasm", PluginHost.mimeType("module.wasm"))
        equal("image/svg+xml", PluginHost.mimeType("icon.svg"))
        equal("application/octet-stream", PluginHost.mimeType("unknown"))
    }
    private fun marker() {
        val f = Fixture(); val hash = f.install().getString("hash")
        PluginFiles.atomic(f.root.resolve("starting.json"), JSONObject().put("id", "counter").put("hash", hash).toString())
        val restarted = PluginHost(null, f.root, f.workspace)
        val row = (restarted.handle("plugins.list", JSONObject()) as JSONObject).getJSONArray("plugins").getJSONObject(0)
        equal("disabled", row.getString("state")); require(row.getString("reason").contains("Suspected"))
        require(!Files.exists(f.root.resolve("starting.json")))
        equal("installed", (restarted.handle("plugins.enable", JSONObject().put("id", "counter")) as JSONObject).getString("state"))
        write(f.pkg, "web/index.js", "selected after the suspect revision")
        val second = (restarted.handle("plugins.install", JSONObject().put("path", f.pkg.toString())) as JSONObject).getString("hash")
        PluginFiles.atomic(f.root.resolve("starting.json"), JSONObject().put("id", "counter").put("hash", hash).toString())
        val next = PluginHost(null, f.root, f.workspace)
        val selected = (next.handle("plugins.list", JSONObject()) as JSONObject).getJSONArray("plugins").getJSONObject(0)
        equal(second, selected.getString("hash")); equal("installed", selected.getString("state"))
        equal(true, selected.getBoolean("enabled")) // Suspicion belongs to the marked hash, not a replacement.
        val rollback = next.handle("plugins.rollback", JSONObject().put("id", "counter")) as JSONObject
        equal(hash, rollback.getString("hash")); equal("failed", rollback.getString("state"))
        equal("installed", (next.handle("plugins.enable", JSONObject().put("id", "counter")) as JSONObject).getString("state"))
    }
    private fun recovery() {
        val f = Fixture(); val hash = f.install().getString("hash")
        write(f.root, "data/counter/keep.txt", "keep me")
        f.host.disableAll()
        equal("disabled", f.list().getJSONArray("plugins").getJSONObject(0).getString("state"))
        val restarted = PluginHost(null, f.root, f.workspace)
        equal("disabled", (restarted.handle("plugins.list", JSONObject()) as JSONObject).getJSONArray("plugins").getJSONObject(0).getString("state"))
        equal("keep me", String(Files.readAllBytes(f.root.resolve("data/counter/keep.txt"))))
        require(Files.exists(f.root.resolve("installed/counter/$hash/native/module.jar")))
    }
    private fun restart() {
        val f = Fixture(); val first = f.install().getString("hash")
        // Simulate a constructor attempt: cannot exercise DexClassLoader in a JVM check.
        val attempted = PluginHost::class.java.getDeclaredField("attempted").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        (attempted.get(f.host) as MutableMap<String, String>)["counter"] = first
        write(f.pkg, "web/index.js", "changed revision")
        val result = f.install()
        equal("restart-required", result.getString("state")); equal(true, result.getBoolean("restartRequired"))
        equal(true, f.action("disable").getBoolean("restartRequired"))
        equal("restart-required", f.action("enable").getString("state"))
    }
    private fun nativeCalls() {
        val f = Fixture(); val hash = f.install().getString("hash")
        var calls = 0
        val module = object : md.incept.selfforming.plugin.PluginModule {
            override fun start(context: md.incept.selfforming.plugin.PluginContext) = error("Already loaded test instance")
            override fun call(method: String, input: JSONObject): Any? {
                calls++
                if (method == "throws") throw IllegalStateException("private-sentinel-must-not-escape")
                if (method == "invalid") return java.io.File("not-json")
                return JSONObject().put("count", calls).put("input", input)
            }
            override fun stop() = Unit
        }
        @Suppress("UNCHECKED_CAST")
        val loaded = PluginHost::class.java.getDeclaredField("loaded").apply { isAccessible = true }.get(f.host)
            as MutableMap<String, Pair<String, md.incept.selfforming.plugin.PluginModule>>
        @Suppress("UNCHECKED_CAST")
        val attempted = PluginHost::class.java.getDeclaredField("attempted").apply { isAccessible = true }.get(f.host)
            as MutableMap<String, String>
        loaded["counter"] = hash to module; attempted["counter"] = hash
        fun invoke(method: String): Any? = f.host.handle("plugins.call", JSONObject().put("id", "counter").put("hash", hash)
            .put("method", method).put("input", JSONObject().put("value", 42)))
        equal(1, (invoke("value") as JSONObject).getInt("count"))
        try { invoke("throws"); error("Expected failure") } catch (failure: HostFailure) {
            equal("PLUGIN_CALL_FAILED", failure.code)
            require(!failure.message.orEmpty().contains("private-sentinel"))
        }
        equal(2, calls)
        rejects("PLUGIN_RESULT") { invoke("invalid") }
        equal(3, calls)
        f.action("disable")
        rejects("PLUGIN_UNAVAILABLE") { invoke("value") }
        equal(3, calls)
    }
    private fun compositionBoundary() {
        val workspace = folder(); val root = folder(); val host = PluginHost(null, root, workspace)
        fun install(id: String, provides: String, requires: String, native: Boolean = true): JSONObject {
            val pkg = source(workspace.resolve(id), id, native)
            write(pkg, "plugin.json", metadata(id, native).put("provides", org.json.JSONArray(provides))
                .put("requires", org.json.JSONArray(requires)).toString())
            return (host.handle("plugins.install", JSONObject().put("path", pkg.toString())) as JSONObject).also {
                equal("installed", it.getString("state")); equal(false, it.getBoolean("restartRequired"))
            }
        }
        val service = "[{\"id\":\"value\",\"version\":1}]"
        // No built-in allowlist: neither execution nor arbitrary web contracts live in this registry.
        val requirements = "[{\"id\":\"value\",\"version\":1},{\"id\":\"execution\",\"version\":1},{\"id\":\"arbitrary.web\",\"version\":7}]"
        val hash = install("consumer", "[]", requirements).getString("hash")
        var calls = 0
        val module = object : md.incept.selfforming.plugin.PluginModule {
            override fun start(context: md.incept.selfforming.plugin.PluginContext) = error("Already loaded test instance")
            override fun call(method: String, input: JSONObject): Any? = ++calls
            override fun stop() = Unit
        }
        // Real DexClassLoader needs Android. Seed only the target instance; all provider jars are
        // deliberately non-executable, so attempting to activate any provider would fail this check.
        @Suppress("UNCHECKED_CAST")
        val loaded = PluginHost::class.java.getDeclaredField("loaded").apply { isAccessible = true }.get(host)
            as MutableMap<String, Pair<String, md.incept.selfforming.plugin.PluginModule>>
        @Suppress("UNCHECKED_CAST")
        val attempted = PluginHost::class.java.getDeclaredField("attempted").apply { isAccessible = true }.get(host)
            as MutableMap<String, String>
        loaded["consumer"] = hash to module; attempted["consumer"] = hash
        fun invoke() = host.handle("plugins.call", JSONObject().put("id", "consumer").put("hash", hash)
            .put("method", "value").put("input", JSONObject()))
        equal(1, invoke())
        val providerHash = install("provider", service, "[]").getString("hash")
        equal(2, invoke()) // A declared native provider must NOT be started as dependency injection.
        equal(setOf("consumer"), attempted.keys); equal(setOf("consumer"), loaded.keys)
        require(!Files.exists(root.resolve("starting.json")))
        install("conflict", service, "[]")
        equal(3, invoke()) // Duplicate web providers are the web runtime's diagnostic, not native's.
        host.handle("plugins.disable", JSONObject().put("id", "provider"))
        equal(4, invoke())
        host.handle("plugins.enable", JSONObject().put("id", "provider"))
        attempted["provider"] = providerHash // Unrelated failed attempt requires restart only there.
        equal(5, invoke())
        val a = "[{\"id\":\"cycle.a\",\"version\":1}]"; val b = "[{\"id\":\"cycle.b\",\"version\":1}]"
        install("cycle-a", a, b); install("cycle-b", b, a)
        val webHash = install("web-only", "[]", requirements, native = false).getString("hash")
        rejects("PLUGIN_NO_NATIVE") {
            host.handle("plugins.call", JSONObject().put("id", "web-only").put("hash", webHash)
                .put("method", "value").put("input", JSONObject()))
        }
        val list = (host.handle("plugins.list", JSONObject()) as JSONObject).getJSONArray("plugins")
        val rows = (0 until list.length()).associate { list.getJSONObject(it).let { row -> row.getString("id") to row } }
        equal("active", rows.getValue("consumer").getString("state"))
        equal("restart-required", rows.getValue("provider").getString("state"))
        for (id in listOf("conflict", "cycle-a", "cycle-b", "web-only")) equal("installed", rows.getValue(id).getString("state"))
        equal(org.json.JSONArray(requirements).toString(), rows.getValue("consumer").getJSONArray("requires").toString())
        equal(org.json.JSONArray(service).toString(), rows.getValue("conflict").getJSONArray("provides").toString())
        equal(6, invoke())
    }

    private fun systemSymlink() {
        // Android: filesDir = /data/user/0/<pkg>/files, and /data/user/0 -> /data/data.
        val real = Files.createDirectories(temporary.resolve("data-data/pkg/files"))
        val user0 = temporary.resolve("data-user-0")
        Files.createSymbolicLink(user0, temporary.resolve("data-data"))
        val handedOut = user0.resolve("pkg/files")
        rejects { PluginFiles.noLinks(handedOut.resolve("plugins")) }
        val resolved = handedOut.toRealPath()
        equal(real.toRealPath(), resolved)
        PluginFiles.noLinks(resolved.resolve("plugins"))
        Files.createDirectories(resolved.resolve("plugins"))
        Files.createSymbolicLink(resolved.resolve("plugins/evil"), temporary)
        rejects { PluginFiles.noLinks(resolved.resolve("plugins/evil/x")) }
    }
}
