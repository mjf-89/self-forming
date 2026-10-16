package md.incept.selfforming

import md.incept.selfforming.plugin.PluginContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/** Standalone JVM checks for Track B part 1 (APK 0.6.0): plugin events queue/epochs, plugins.read
 * path/revision rules, plugin credential provider validation and the additive PluginContext ABI
 * (the allow-list checks moved to core-net-native's HttpAllowListChecks with X4n). Compile with
 * PluginHost.kt, PluginEvents.kt, PluginCredentials.kt, HostFailure.kt, plugin/PluginApi.kt against android.jar;
 * run with a REAL org.json jar before android.jar (Android's stubs cannot execute JSON). Run as an
 * unprivileged uid so read-only checks are meaningful. No Android runtime, APK or app data.
 */
object PluginTrackBChecks {
    private lateinit var temporary: Path
    private var checks = 0

    @JvmStatic fun main(args: Array<String>) {
        temporary = Files.createTempDirectory("plugin-track-b-check-")
        try {
            check("events: delivered only to the current page epoch, in order") { eventsEpoch() }
            check("events: dropped and counted without a listener, for unheard plugins and on overflow") { eventsDrops() }
            check("events: names, data size and listen messages are validated") { eventsValidation() }
            check("PluginContext: 3-argument constructor and members unchanged; emit is additive") { contextAbi() }
            check("plugins.read: selected/pinned revision only, canonical web/ paths, size and encodings") { pluginRead() }
            check("plugins.read and served assets share the pinning rules") { readPins() }
            check("plugin credential providers: pattern, record directory and Keystore alias family") { credentials() }
            println("PASS: $checks Track B checks")
        } finally {
            Files.walk(temporary).use { stream -> stream.filter { Files.isDirectory(it) }.forEach { it.toFile().setWritable(true, true) } }
            Files.walk(temporary).use { stream -> stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
        }
    }

    private fun check(name: String, block: () -> Unit) { block(); checks++; println("PASS: $name") }
    private fun equal(expected: Any?, actual: Any?) { require(expected == actual) { "Expected $expected, got $actual" } }
    private fun rejects(code: String? = null, block: () -> Unit) {
        try { block() } catch (error: HostFailure) { if (code != null) equal(code, error.code); return }
        error("Expected HostFailure${code?.let { " $it" } ?: ""}")
    }
    private fun illegal(block: () -> Unit) {
        try { block() } catch (_: IllegalArgumentException) { return }
        error("Expected IllegalArgumentException")
    }
    private fun folder() = Files.createTempDirectory(temporary, "case-")

    // ---------- events ----------
    private class Loop {
        val tasks = ArrayDeque<Runnable>()
        val post: (Runnable) -> Unit = { tasks.addLast(it) }
        fun run() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    }
    private class Page(val accept: () -> Boolean = { true }) {
        val messages = mutableListOf<JSONObject>()
        val sink: (String) -> Boolean = { text -> if (accept()) { messages.add(JSONObject(text)); true } else false }
    }
    private const val PAGE_A = "pageAAAA1"
    private const val PAGE_B = "pageBBBB2"
    private val HASH = "a".repeat(64)

    private fun eventsEpoch() {
        val loop = Loop(); val events = PluginEvents(loop.post)
        val first = Any(); val page = Page()
        events.listen(first, PAGE_A, setOf("counter"), page.sink)
        equal(true, events.emit("counter", HASH, "tick", JSONObject().put("n", 1)))
        equal(true, events.emit("counter", HASH, "tick", JSONObject().put("n", 2)))
        equal(0, page.messages.size) // Delivery happens on the posted (main-thread) drain only.
        loop.run()
        equal(listOf(1, 2), page.messages.map { it.getJSONObject("data").getInt("n") })
        val message = page.messages[0]
        equal("event", message.getString("type")); equal(PAGE_A, message.getString("page"))
        equal("counter", message.getString("plugin")); equal(HASH, message.getString("hash")); equal("tick", message.getString("event"))
        equal(1L, message.getLong("seq")); equal(2L, page.messages[1].getLong("seq")); equal(0L, message.getLong("dropped"))
        // Same owner/page only updates the plugin set (queued events stay valid).
        events.emit("counter", HASH, "tick", JSONObject().put("n", 3))
        events.listen(first, PAGE_A, setOf("counter", "other"), page.sink)
        loop.run(); equal(3, page.messages.size)
        // Page epoch ends: queued events are dropped, never delivered to the next document.
        events.emit("counter", HASH, "tick", JSONObject().put("n", 4))
        events.detach(first)
        val second = Any(); val next = Page()
        events.listen(second, PAGE_B, setOf("counter"), next.sink)
        events.emit("counter", HASH, "tick", JSONObject().put("n", 5))
        loop.run()
        equal(3, page.messages.size)
        equal(listOf(5), next.messages.map { it.getJSONObject("data").getInt("n") })
        equal(PAGE_B, next.messages[0].getString("page")); equal(1L, next.messages[0].getLong("dropped"))
        // A newer listener replaces an older one even without detach (Activity recreation).
        events.emit("counter", HASH, "tick", JSONObject().put("n", 6))
        val third = Any(); val newest = Page()
        events.listen(third, "pageCCCC3", setOf("counter"), newest.sink)
        loop.run()
        equal(1, next.messages.size); equal(0, newest.messages.size)
        // Detaching an older owner does not remove the current listener.
        events.detach(second)
        equal(true, events.emit("counter", HASH, "tick", JSONObject().put("n", 7)))
        loop.run(); equal(1, newest.messages.size)
        // A sink that reports a detached document counts as dropped (stale).
        val closed = Any(); events.listen(closed, "pageDDDD4", setOf("counter"), Page { false }.sink)
        events.emit("counter", HASH, "tick", JSONObject()); loop.run()
        val stats = events.stats()
        equal(0, stats.getInt("queued")); equal(3L, stats.getLong("stale")); equal(5L, stats.getLong("delivered"))
        // Stopped listening to a plugin between emit and delivery: not delivered.
        val last = Page(); val owner = Any()
        events.listen(owner, "pageEEEE5", setOf("counter"), last.sink)
        events.emit("counter", HASH, "tick", JSONObject())
        events.listen(owner, "pageEEEE5", emptySet(), last.sink)
        loop.run(); equal(0, last.messages.size)
    }

    private fun eventsDrops() {
        val loop = Loop(); val events = PluginEvents(loop.post, maxQueue = 3, maxQueuedBytes = 64 * 1024)
        equal(false, events.emit("counter", HASH, "tick", JSONObject())) // nobody listens
        val page = Page(); val owner = Any()
        events.listen(owner, PAGE_A, setOf("counter"), page.sink)
        equal(false, events.emit("other", HASH, "tick", JSONObject())) // page does not listen to this plugin
        repeat(3) { equal(true, events.emit("counter", HASH, "tick", JSONObject().put("i", it))) }
        equal(false, events.emit("counter", HASH, "tick", JSONObject())) // queue full
        var stats = events.stats()
        equal(2L, stats.getLong("unheard")); equal(1L, stats.getLong("overflow")); equal(3, stats.getInt("queued"))
        loop.run()
        equal(3, page.messages.size)
        equal(2L, page.messages[0].getLong("dropped")) // gaps are visible to the page (count at emit time)
        // Byte budget also bounds the queue.
        val small = PluginEvents(loop.post, maxQueue = 100, maxQueuedBytes = 70_000)
        small.listen(owner, PAGE_A, setOf("counter"), page.sink)
        val big = JSONObject().put("text", "x".repeat(20_000))
        equal(true, small.emit("counter", HASH, "big", big))
        equal(false, small.emit("counter", HASH, "big", big))
        equal(1L, small.stats().getLong("overflow"))
        // Long bursts are delivered in bounded batches (re-posted), all in order.
        val burstLoop = Loop(); val burst = PluginEvents(burstLoop.post)
        val many = Page(); burst.listen(owner, PAGE_A, setOf("counter"), many.sink)
        repeat(100) { burst.emit("counter", HASH, "n", JSONObject().put("i", it)) }
        equal(1, burstLoop.tasks.size) // one drain scheduled for the whole burst
        burstLoop.tasks.removeFirst().run()
        require(many.messages.size in 1 until 100) { "Expected a bounded first batch, got ${many.messages.size}" }
        burstLoop.run()
        equal((0 until 100).toList(), many.messages.map { it.getJSONObject("data").getInt("i") })
        stats = burst.stats(); equal(100L, stats.getLong("delivered")); equal(0L, stats.getLong("dropped"))
    }

    private fun eventsValidation() {
        val events = PluginEvents({ })
        events.listen(Any(), PAGE_A, setOf("counter"), Page().sink)
        for (name in listOf("", "1tick", "has space", "x".repeat(65), "ü")) illegal { events.emit("counter", HASH, name, JSONObject()) }
        illegal { events.emit("counter", HASH, "big", JSONObject().put("text", "x".repeat(PluginEvents.MAX_DATA_BYTES))) }
        equal(true, events.emit("counter", HASH, "a.b:c-d_e", JSONObject().put("text", "x".repeat(60_000))))
        val good = PluginEvents.parseListen("{\"type\":\"listen\",\"page\":\"$PAGE_A\",\"plugins\":[\"counter\",\"other-one\"]}")!!
        equal(PAGE_A, good.page); equal(setOf("counter", "other-one"), good.plugins)
        equal(emptySet<String>(), PluginEvents.parseListen("{\"type\":\"listen\",\"page\":\"$PAGE_A\",\"plugins\":[]}")!!.plugins)
        for (bad in listOf("not json", "[]", "{\"type\":\"emit\",\"page\":\"$PAGE_A\",\"plugins\":[]}",
            "{\"type\":\"listen\",\"page\":\"short\",\"plugins\":[]}",
            "{\"type\":\"listen\",\"page\":\"bad page token\",\"plugins\":[]}",
            "{\"type\":\"listen\",\"page\":\"$PAGE_A\",\"plugins\":[\"Bad\"]}",
            "{\"type\":\"listen\",\"page\":\"$PAGE_A\",\"plugins\":[1]}",
            "{\"type\":\"listen\",\"page\":\"$PAGE_A\",\"plugins\":\"counter\"}",
            "{\"type\":\"listen\",\"page\":\"$PAGE_A\",\"plugins\":${JSONArray((0..PluginEvents.MAX_PLUGINS).map { "p$it" })}}",
            "{\"type\":\"listen\",\"page\":\"$PAGE_A\",\"plugins\":[],\"pad\":\"${"x".repeat(PluginEvents.MAX_LISTEN_BYTES)}\"}"))
            equal(null, PluginEvents.parseListen(bad))
        val ready = JSONObject(events.ready(PAGE_A))
        equal("ready", ready.getString("type")); equal(PAGE_A, ready.getString("page")); equal(0L, ready.getLong("dropped"))
    }

    private fun contextAbi() {
        val type = PluginContext::class.java
        val context = Class.forName("android.content.Context")
        // Exactly the 0.5.x members still exist with the same JVM signatures.
        type.getConstructor(context, String::class.java, File::class.java)
        equal(context, type.getMethod("getAppContext").returnType)
        equal(String::class.java, type.getMethod("getId").returnType)
        equal(File::class.java, type.getMethod("getDataDir").returnType)
        equal(java.lang.Boolean.TYPE, type.getMethod("emit", String::class.java, JSONObject::class.java).returnType)
        // A Context without running Android's stub constructor (it would throw "Stub!").
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        val allocate = unsafe.javaClass.getMethod("allocateInstance", Class::class.java)
        val app = allocate.invoke(unsafe, Class.forName("android.content.ContextWrapper")) as android.content.Context
        val data = folder().toFile()
        val old = PluginContext(app, "counter", data)
        equal("counter", old.id); equal(data, old.dataDir)
        equal(false, old.emit("tick", JSONObject())) // no host lane: a no-op, not a crash
        val seen = mutableListOf<String>()
        val wired = PluginContext(app, "counter", data) { event, value -> seen.add("$event:${value.getInt("n")}"); true }
        equal(true, wired.emit("tick", JSONObject().put("n", 1)))
        illegal { wired.emit("bad name", JSONObject()) }
        equal(listOf("tick:1"), seen)
        // Optional: a module compiled against the 0.5.x SDK (args: <class> on the classpath) still runs.
        System.getProperty("legacyModule")?.let { name ->
            val module = Class.forName(name).getDeclaredConstructor().newInstance() as md.incept.selfforming.plugin.PluginModule
            module.start(PluginContext(app, "counter", data) { _, _ -> true })
            equal(1L, (module.call("increment", JSONObject()) as Number).toLong())
            equal(1L, (module.call("get", JSONObject()) as Number).toLong())
            module.stop()
            println("  legacy module $name: started, called and stopped with the new SDK")
        }
    }

    // ---------- plugins.read ----------
    private fun write(root: Path, path: String, bytes: ByteArray) {
        val file = root.resolve(path); Files.createDirectories(file.parent); Files.write(file, bytes)
    }
    private fun manifest(id: String = "notes") = JSONObject().put("id", id).put("name", "Notes").put("version", "0.1.0")
        .put("api", 1).put("web", JSONObject().put("entry", "web/index.js")).put("reload", "scope")
        .put("provides", JSONArray()).put("requires", JSONArray()).put("uses", JSONArray())
    private class Fixture {
        val workspace = folder(); val root = folder()
        val pkg: Path = workspace.resolve("plugins/notes").also { pkg ->
            write(pkg, "plugin.json", manifest().toString().toByteArray())
            write(pkg, "web/index.js", "export function setup() {}".toByteArray())
            write(pkg, "web/skills/notes/SKILL.md", "---\nname: notes\ndescription: Notes.\n---\nÜber\n".toByteArray())
            write(pkg, "web/skills/notes/assets/logo.bin", byteArrayOf(0, -1, -2, 10, 13))
            write(pkg, "web/large.txt", ByteArray(PluginHost.MAX_READ_BYTES + 1) { 'x'.code.toByte() })
        }
        val host = PluginHost(null, root, workspace)
        fun install() = (host.handle("plugins.install", JSONObject().put("path", pkg.toString())) as JSONObject).getString("hash")
        fun read(hash: String, path: String, encoding: String? = null, pins: MutableMap<String, String>? = null) =
            host.handle("plugins.read", JSONObject().put("id", "notes").put("hash", hash).put("path", path)
                .also { if (encoding != null) it.put("encoding", encoding) }, pins) as JSONObject
    }
    private fun pluginRead() {
        val f = Fixture(); val hash = f.install()
        val skill = f.read(hash, "web/skills/notes/SKILL.md")
        equal("text", skill.getString("encoding")); require(skill.getString("text").endsWith("Über\n"))
        equal("web/skills/notes/SKILL.md", skill.getString("path"))
        equal("---\nname: notes\ndescription: Notes.\n---\nÜber\n".toByteArray().size, skill.getInt("size"))
        val binary = f.read(hash, "web/skills/notes/assets/logo.bin")
        equal("base64", binary.getString("encoding"))
        require(java.util.Base64.getDecoder().decode(binary.getString("data")).contentEquals(byteArrayOf(0, -1, -2, 10, 13)))
        equal("base64", f.read(hash, "web/index.js", "base64").getString("encoding"))
        rejects("INVALID_UTF8") { f.read(hash, "web/skills/notes/assets/logo.bin", "text") }
        rejects("INVALID_REQUEST") { f.read(hash, "web/index.js", "utf16") }
        rejects("TOO_LARGE") { f.read(hash, "web/large.txt") }
        rejects("NOT_FOUND") { f.read(hash, "web/missing.md") }
        rejects("NOT_FOUND") { f.read(hash, "web/skills") } // directories are not files
        rejects("PLUGIN_READ_PATH") { f.read(hash, "plugin.json") }
        rejects("PLUGIN_READ_PATH") { f.read(hash, "native/module.jar") }
        for (path in listOf("web/../plugin.json", "/web/index.js", "web//index.js", "web/./index.js", "web\\index.js", "web/a\u0000b", ""))
            rejects("PLUGIN_INVALID") { f.read(hash, path) }
        rejects("PLUGIN_REVISION_MISMATCH") { f.read("b".repeat(64), "web/index.js") }
        rejects("INVALID_REQUEST") { f.read("not-a-hash", "web/index.js") }
        rejects("PLUGIN_NOT_FOUND") { f.host.handle("plugins.read", JSONObject().put("id", "absent").put("hash", hash).put("path", "web/index.js")) }
        rejects("INVALID_REQUEST") { f.host.handle("plugins.read", JSONObject().put("id", "notes").put("hash", hash)) }
        // Disabled and not pinned: refused (same as serving).
        f.host.handle("plugins.disable", JSONObject().put("id", "notes"))
        rejects("PLUGIN_REVISION_MISMATCH") { f.read(hash, "web/index.js") }
        f.host.handle("plugins.enable", JSONObject().put("id", "notes"))
        // A snapshot tampered with after install is not read when unpinned (full reverification).
        val file = f.root.resolve("installed/notes/$hash/web/index.js")
        file.toFile().setWritable(true, true); Files.write(file, "tampered".toByteArray()); file.toFile().setWritable(false, false)
        rejects("PLUGIN_INVALID") { f.read(hash, "web/index.js") }
    }
    private fun readPins() {
        val f = Fixture(); val first = f.install()
        val pins = mutableMapOf<String, String>()
        equal("export function setup() {}", f.read(first, "web/index.js", pins = pins).getString("text"))
        equal(first, pins["notes"]) // reading pins the page to that revision, like a served asset
        write(f.pkg, "web/index.js", "second".toByteArray()); val second = f.install()
        // The page keeps its pinned (now unselected) revision; the new one is refused for it.
        equal("export function setup() {}", f.read(first, "web/index.js", pins = pins).getString("text"))
        rejects("PLUGIN_REVISION_MISMATCH") { f.read(second, "web/index.js", pins = pins) }
        // Without a pin (another page / no page): only the selected revision.
        rejects("PLUGIN_REVISION_MISMATCH") { f.read(first, "web/index.js") }
        equal("second", f.read(second, "web/index.js").getString("text"))
        // Served assets follow the same pin set.
        equal(null, f.host.openAsset(PluginHost.ASSET_PREFIX + "notes/$second/web/index.js", pins))
        equal("export function setup() {}", f.host.openAsset(PluginHost.ASSET_PREFIX + "notes/$first/web/index.js", pins)!!.bufferedReader().use { it.readText() })
        val fresh = mutableMapOf<String, String>()
        equal("second", f.host.openAsset(PluginHost.ASSET_PREFIX + "notes/$second/web/index.js", fresh)!!.bufferedReader().use { it.readText() })
        equal("second", f.read(second, "web/index.js", pins = fresh).getString("text"))
        rejects("PLUGIN_REVISION_MISMATCH") { f.read(first, "web/index.js", pins = fresh) }
    }

    // ---------- credentials ----------
    private fun credentials() {
        val key = PluginCredentials.parse("plugin:openai-compatible:openrouter")!!
        equal("openai-compatible", key.pluginId); equal("openrouter", key.name)
        equal("plugin-auth/openai-compatible/openrouter", key.directory)
        equal("md.incept.selfforming.plugin.v1.openai-compatible.openrouter", key.alias)
        equal("v1.key_2", PluginCredentials.parse("plugin:llama:v1.key_2")!!.name)
        for (bad in listOf("plugin:", "plugin:x:key", "plugin:Llama:key", "plugin:llama:", "plugin:llama:Key", "plugin:llama:.hidden",
            "plugin:llama:-x", "plugin:llama:a/b", "plugin:llama:..", "plugin:llama:key:extra", "plugin:llama", "plugin::key",
            "plugin:llama:" + "k".repeat(65), "plugin:1llama:key", " plugin:llama:key", "plugin:llama:key\n", "chatgpt", "claude"))
            equal(null, PluginCredentials.parse(bad))
        equal(true, PluginCredentials.isPluginProvider("plugin:Bad"))
        equal(false, PluginCredentials.isPluginProvider("chatgpt")); equal(false, PluginCredentials.isPluginProvider("claude"))
        // Distinct credentials never share a record directory or a key alias, nor the built-in ones.
        val keys = listOf("plugin:ab:c.d", "plugin:ab-c:d", "plugin:ab:c-d", "plugin:abc:d").map { PluginCredentials.parse(it)!! }
        equal(keys.size, keys.map { it.alias }.toSet().size); equal(keys.size, keys.map { it.directory }.toSet().size)
        for (k in keys) {
            require(k.alias.startsWith(PluginCredentials.ALIAS_PREFIX))
            require(k.alias != "md.incept.selfforming.chatgpt.v1" && k.alias != "md.incept.selfforming.claude.v1")
            require(k.directory.startsWith("plugin-auth/") && !k.directory.split('/').any { it == ".." || it == "." || it.isEmpty() })
        }
        equal(setOf("auth.info", "auth.load", "auth.save", "auth.clear"), PluginCredentials.METHODS)
    }
}
