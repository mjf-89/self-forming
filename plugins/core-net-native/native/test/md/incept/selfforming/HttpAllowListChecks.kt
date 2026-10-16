package md.incept.selfforming

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

/** Standalone JVM checks of the HTTP allow-list (APK 0.6.0 Track B; moved out of core-plugin-management's
 * PluginTrackBChecks with X4n so each plugin folder's tests compile without the other). Compile with
 * HttpAllowList.kt, NativeHttpPolicy.kt, HostFailure.kt against android.jar; run with a REAL org.json jar
 * before android.jar (Android's stubs cannot execute JSON). No Android runtime, APK or app data.
 */
object HttpAllowListChecks {
    private lateinit var temporary: Path
    private var checks = 0

    @JvmStatic fun main(args: Array<String>) {
        temporary = Files.createTempDirectory("http-allow-list-check-")
        try {
            check("allow-list: entry validation (https, host[:port], plain prefix, fixed hosts refused)") { allowListParse() }
            check("allow-list: policy permits listed endpoints only; fixed rules unchanged") { allowListPolicy() }
            check("allow-list: stored atomically, max entries, invalid set changes nothing, corrupt file fails closed") { allowListStore() }
            println("PASS: $checks allow-list checks")
        } finally {
            Files.walk(temporary).use { stream -> stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } }
        }
    }

    private fun check(name: String, block: () -> Unit) { block(); checks++; println("PASS: $name") }
    private fun equal(expected: Any?, actual: Any?) { require(expected == actual) { "Expected $expected, got $actual" } }
    private fun rejects(code: String? = null, block: () -> Unit) {
        try { block() } catch (error: HostFailure) { if (code != null) equal(code, error.code); return }
        error("Expected HostFailure${code?.let { " $it" } ?: ""}")
    }
    private fun folder() = Files.createTempDirectory(temporary, "case-")

    // ---------- allow-list ----------
    private fun allowListParse() {
        equal(HttpAllowList.Entry("openrouter.ai", 443, "/api/v1/"), HttpAllowList.parse("https://openrouter.ai/api/v1/"))
        equal(HttpAllowList.Entry("llm.example.com", 8443, "/"), HttpAllowList.parse("https://LLM.example.com:8443"))
        equal("https://llm.example.com:8443/", HttpAllowList.parse("https://llm.example.com:8443").url())
        equal("https://openrouter.ai/api/v1/", HttpAllowList.parse("https://openrouter.ai:443/api/v1/").url())
        for (bad in listOf("http://openrouter.ai/", "ftp://x.example/", "https://user@openrouter.ai/", "https://openrouter.ai/?q=1",
            "https://openrouter.ai/#x", "https://openrouter.ai/a/../b", "https://openrouter.ai/a//b", "https://openrouter.ai/a/./b",
            "https://openrouter.ai/a%2fb", "https://openrouter.ai/ a", "https:///nohost", "openrouter.ai", "",
            "https://api.openai.com/", "https://API.OPENAI.COM/v2/", "https://api.anthropic.com/v1/", "https://auth.openai.com/",
            "https://platform.claude.com/x", "https://[::1]/", "https://under_score.example/", "https://-bad.example/",
            "https://example.com:0/", "https://exämple.com/", "https://example.com/" + "a".repeat(300)))
            rejects("HTTP_ALLOW_LIST") { HttpAllowList.parse(bad) }
    }
    private fun allowListPolicy() {
        val entries = listOf(HttpAllowList.parse("https://openrouter.ai/api/v1/"), HttpAllowList.parse("https://llm.example.com:8443/v1"))
        fun ok(url: String, method: String = "POST", body: Boolean = true) = NativeHttpPolicy.endpoint(url, method, body, entries)
        fun refused(url: String, method: String = "POST", body: Boolean = true, list: List<HttpAllowList.Entry> = entries) =
            rejects { NativeHttpPolicy.endpoint(url, method, body, list) }
        ok("https://openrouter.ai/api/v1/chat/completions")
        ok("https://openrouter.ai/api/v1/models?limit=5", "GET", false)
        ok("https://OPENROUTER.AI/api/v1/models", "GET", false)
        ok("https://llm.example.com:8443/v1", "GET", false)
        ok("https://llm.example.com:8443/v1/chat/completions")
        ok("https://openrouter.ai/api/v1/x", "DELETE", false); ok("https://openrouter.ai/api/v1/x", "PUT")
        refused("https://llm.example.com:8443/v1x/chat") // segment boundary
        refused("https://llm.example.com/v1/chat") // other port
        refused("https://openrouter.ai/api/v2/chat")
        refused("https://openrouter.ai/api/v1/../../admin")
        refused("https://openrouter.ai/api/v1/%2e%2e/admin"); refused("https://openrouter.ai/api/v1/a%2Fb"); refused("https://openrouter.ai/api/v1//x")
        refused("http://openrouter.ai/api/v1/chat")
        refused("https://user@openrouter.ai/api/v1/chat")
        refused("https://openrouter.ai/api/v1/chat#frag")
        refused("https://evil.openrouter.ai/api/v1/chat"); refused("https://openrouter.ai.evil.example/api/v1/chat")
        refused("https://openrouter.ai/api/v1/chat", "PATCH"); refused("https://openrouter.ai/api/v1/chat", "TRACE")
        refused("https://openrouter.ai/api/v1/models", "GET", true)
        refused("https://openrouter.ai/api/v1/chat/completions", list = emptyList())
        // Fixed endpoints: unchanged with or without a list, never widened by it.
        for (list in listOf(emptyList(), entries)) {
            NativeHttpPolicy.endpoint("https://api.openai.com/v1/responses", "POST", true, list)
            NativeHttpPolicy.endpoint("https://api.anthropic.com/v1/models?limit=1", "GET", false, list)
            NativeHttpPolicy.endpoint("https://auth.openai.com/api/accounts/oauth/token", "POST", true, list)
            refused("https://api.openai.com/v1/files", list = list)
            refused("https://api.openai.com/v1/responses", "GET", false, list)
            refused("https://auth.openai.com/api/accounts/oauth/token?x=1", list = list)
            refused("https://api.openai.com:8443/v1/responses", list = list)
            refused("https://api.openai.com/v1/models", "GET", true, list)
            refused("https://localhost/v1/models", "GET", false, list)
        }
        // Even a hand-made entry for a fixed host never relaxes its rules.
        val sneaky = listOf(HttpAllowList.Entry("api.openai.com", 443, "/"))
        refused("https://api.openai.com/v1/files", list = sneaky)
        equal(false, HttpAllowList.permits(sneaky, URI("https://api.openai.com/v1/files"), "POST"))
    }
    private fun allowListStore() {
        val directory = folder()
        val file = directory.resolve("no_backup/http-allow-list.json").toFile()
        val store = HttpAllowList(file)
        equal(0, store.get().getJSONArray("entries").length()); equal(HttpAllowList.MAX_ENTRIES, store.get().getInt("max"))
        val saved = store.set(JSONArray(listOf("https://openrouter.ai/api/v1/", "https://OpenRouter.ai/api/v1/", "https://llm.example.com:8443/v1")))
        equal(listOf("https://openrouter.ai/api/v1/", "https://llm.example.com:8443/v1"), (0 until saved.getJSONArray("entries").length()).map { saved.getJSONArray("entries").getString(it) })
        equal(2, HttpAllowList(file).entries().size) // persisted, reread by a new instance
        equal(1, JSONObject(file.readText()).getInt("version"))
        equal(listOf(file.name), file.parentFile!!.list()!!.toList()) // no temporary files left behind
        // Invalid input changes nothing (all or nothing).
        rejects("HTTP_ALLOW_LIST") { store.set(JSONArray(listOf("https://ok.example/", "http://bad.example/"))) }
        rejects("HTTP_ALLOW_LIST") { store.set(JSONArray(listOf("https://ok.example/", 5))) }
        rejects("HTTP_ALLOW_LIST") { store.set(JSONArray((0..HttpAllowList.MAX_ENTRIES).map { "https://h$it.example/" })) }
        equal(2, store.entries().size); equal(2, HttpAllowList(file).entries().size)
        equal(HttpAllowList.MAX_ENTRIES, store.set(JSONArray((1..HttpAllowList.MAX_ENTRIES).map { "https://h$it.example/" })).getJSONArray("entries").length())
        equal(0, store.set(JSONArray()).getJSONArray("entries").length())
        equal(0, HttpAllowList(file).entries().size)
        // Corrupt or tampered storage fails closed; bad entries are skipped individually.
        file.writeText("{not json"); equal(0, HttpAllowList(file).entries().size)
        file.writeText(JSONObject().put("entries", JSONArray(listOf("https://ok.example/v1", "https://api.openai.com/", "http://x.example/"))).toString())
        equal(listOf(HttpAllowList.parse("https://ok.example/v1")), HttpAllowList(file).entries())
        equal(0, HttpAllowList(directory.resolve("missing.json").toFile()).entries().size)
    }
}
