package md.incept.selfforming

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.READ
import java.nio.file.StandardOpenOption.WRITE
import java.util.Locale

/**
 * User-managed HTTPS endpoints that NativeHttp may reach in addition to NativeHttpPolicy's fixed
 * OpenAI/Anthropic endpoints (docs/plugins-providers-agent-core.md §F.2, §B3 core-net-native).
 * Entries are URL prefixes "https://host[:port]/path/prefix". Stored natively (no_backup); the page
 * edits them only through `http.allowList.get/set`. The fixed provider hosts cannot be listed, so
 * their stricter per-endpoint rules are never relaxed. Unlisted hosts stay refused.
 */
internal class HttpAllowList(private val file: File) {
    data class Entry(val host: String, val port: Int, val pathPrefix: String) {
        fun url(): String = "https://$host${if (port == 443) "" else ":$port"}$pathPrefix"
    }

    private val lock = Any()
    @Volatile private var cached: List<Entry>? = null

    /** A missing or unreadable file means no extra endpoints (fails closed). */
    fun entries(): List<Entry> = cached ?: synchronized(lock) {
        cached ?: load().also { cached = it }
    }

    fun get(): JSONObject = describe(entries())

    /** Replaces the whole list. Every entry must be valid, otherwise nothing changes. */
    fun set(raw: JSONArray): JSONObject = synchronized(lock) {
        if (raw.length() > MAX_ENTRIES) throw invalid("At most $MAX_ENTRIES allowed endpoints")
        val parsed = (0 until raw.length()).map { index ->
            val value = raw.opt(index) as? String ?: throw invalid("Entry ${index + 1} must be a URL string")
            try { parse(value) } catch (error: HostFailure) { throw invalid("Entry ${index + 1}: ${error.message}") }
        }.distinct()
        write(JSONObject().put("version", 1).put("entries", JSONArray(parsed.map { it.url() })).toString())
        cached = parsed
        describe(parsed)
    }

    private fun describe(list: List<Entry>) = JSONObject()
        .put("entries", JSONArray(list.map { it.url() })).put("max", MAX_ENTRIES)

    private fun load(): List<Entry> = try {
        if (!file.isFile || file.length() > MAX_FILE_BYTES) emptyList() else {
            val json = JSONObject(String(Files.readAllBytes(file.toPath()), Charsets.UTF_8))
            val list = json.optJSONArray("entries") ?: JSONArray()
            (0 until minOf(list.length(), MAX_ENTRIES)).mapNotNull { index ->
                (list.opt(index) as? String)?.let { try { parse(it) } catch (_: HostFailure) { null } }
            }.distinct()
        }
    } catch (_: Exception) { emptyList() }

    private fun write(text: String) {
        val directory: File = file.absoluteFile.parentFile ?: throw HostFailure("IO_ERROR", "Cannot store the allowed endpoints")
        if (!directory.isDirectory && !directory.mkdirs()) throw HostFailure("IO_ERROR", "Cannot store the allowed endpoints")
        val temporary = Files.createTempFile(directory.toPath(), ".allow-list-", ".tmp")
        try {
            FileChannel.open(temporary, WRITE).use { channel ->
                val buffer = ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8))
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
            Files.move(temporary, file.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
            try { FileChannel.open(directory.toPath(), READ).use { it.force(true) } } catch (_: Exception) { }
        } finally { Files.deleteIfExists(temporary) }
    }

    companion object {
        const val MAX_ENTRIES = 32
        private const val MAX_URL = 512
        private const val MAX_PREFIX = 256
        private const val MAX_FILE_BYTES = 64L * 1024
        /** Hosts with fixed per-endpoint rules in NativeHttpPolicy; listing them would relax those rules. */
        val FIXED_HOSTS = setOf("api.openai.com", "api.anthropic.com", "auth.openai.com", "platform.claude.com")
        val METHODS = setOf("GET", "POST", "PUT", "DELETE", "HEAD")
        private val label = Regex("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
        private val prefixCharacters = Regex("/[A-Za-z0-9._~!$&'()*+,;=:@/-]*")

        private fun invalid(reason: String) = HostFailure("HTTP_ALLOW_LIST", reason)

        /** "https://host[:port]/prefix" → Entry, or HostFailure with a reason. */
        fun parse(value: String): Entry {
            if (value.isEmpty() || value.length > MAX_URL || value.any { it.code <= 32 || it.code >= 127 })
                throw invalid("Use a plain https:// URL without spaces")
            val uri = try { URI(value) } catch (_: Exception) { throw invalid("Not a valid URL") }
            if (uri.scheme != "https") throw invalid("Only https:// endpoints can be allowed")
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null)
                throw invalid("Use host[:port] and a path prefix only (no user, query or fragment)")
            val host = uri.host?.lowercase(Locale.ROOT) ?: throw invalid("The URL has no host")
            if (host.length > 253 || !host.split('.').all { label.matches(it) }) throw invalid("Use a DNS host name")
            if (host in FIXED_HOSTS) throw invalid("$host is built in with fixed endpoints")
            val port = if (uri.port == -1) 443 else uri.port
            if (port !in 1..65535) throw invalid("Invalid port")
            val path = uri.rawPath.orEmpty().ifEmpty { "/" }
            if (path.length > MAX_PREFIX || !prefixCharacters.matches(path) || path.contains("//") ||
                path.split('/').any { it == "." || it == ".." })
                throw invalid("The path prefix must be a plain absolute path (no //, . or .. segments, no % escapes)")
            return Entry(host, port, path)
        }

        /** True when a listed entry covers the request. Never true for the fixed hosts. */
        fun permits(entries: List<Entry>, uri: URI, method: String): Boolean {
            if (entries.isEmpty() || uri.scheme != "https" || uri.rawUserInfo != null || uri.rawFragment != null) return false
            val host = uri.host?.lowercase(Locale.ROOT) ?: return false
            if (host in FIXED_HOSTS || method !in METHODS) return false
            val port = if (uri.port == -1) 443 else uri.port
            val path = uri.rawPath ?: return false
            // Refuse anything a server could normalize out of the prefix: dot segments, empty
            // segments, encoded dots/slashes/backslashes.
            if (!path.startsWith("/") || path.contains("//") || path.contains('\\') ||
                path.split('/').any { it == "." || it == ".." } ||
                Regex("%(2e|2f|5c)", RegexOption.IGNORE_CASE).containsMatchIn(path)) return false
            return entries.any { entry ->
                entry.host == host && entry.port == port && (if (entry.pathPrefix.endsWith("/")) path.startsWith(entry.pathPrefix)
                    else path == entry.pathPrefix || path.startsWith(entry.pathPrefix + "/"))
            }
        }

        @Volatile private var instance: HttpAllowList? = null
        /** Process-wide, so every page/bridge sees the same list. */
        fun shared(file: File): HttpAllowList = instance ?: synchronized(this) {
            instance ?: HttpAllowList(file).also { instance = it }
        }
    }
}
