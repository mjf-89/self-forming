package md.incept.selfforming

import java.net.URI
import java.util.Locale

/** The host accepts provider APIs, not arbitrary authenticated proxy destinations. */
internal object NativeHttpPolicy {
    const val CHUNK_BYTES = 64 * 1024
    const val MAX_REQUESTS = 8
    private val token = Regex("[!#\$%&'*+.^_`|~0-9A-Za-z-]+")
    private val managed = setOf("host", "content-length", "transfer-encoding", "connection", "upgrade",
        "expect", "trailer", "te", "origin", "referer", "cookie", "cookie2", "accept-encoding",
        "anthropic-dangerous-direct-browser-access")
    private val endpoints = mapOf(
        "api.openai.com/v1/models" to "GET", "api.openai.com/v1/responses" to "POST",
        "api.anthropic.com/v1/models" to "GET", "api.anthropic.com/v1/messages" to "POST",
        "auth.openai.com/.well-known/openid-configuration" to "GET",
        "auth.openai.com/.well-known/jwks.json" to "GET",
        "auth.openai.com/api/accounts/oauth/token" to "POST",
        "auth.openai.com/api/accounts/oauth/revoke" to "POST",
        "platform.claude.com/v1/oauth/token" to "POST")

    fun endpoint(url: String, method: String, hasBody: Boolean): URI {
        val uri = try { URI(url) } catch (_: Exception) { throw HostFailure("HTTP_ENDPOINT", "Unsupported HTTP endpoint") }
        val host = uri.host?.lowercase(Locale.ROOT)
        if (uri.scheme != "https" || uri.rawUserInfo != null || uri.rawFragment != null ||
            uri.port !in setOf(-1, 443) || endpoints["$host${uri.rawPath}"] != method ||
            (uri.rawQuery != null && host !in setOf("api.openai.com", "api.anthropic.com")))
            throw HostFailure("HTTP_ENDPOINT", "Unsupported HTTP endpoint or method")
        if (method == "GET" && hasBody) throw HostFailure("INVALID_REQUEST", "GET requests cannot have a body")
        return uri
    }

    fun headers(headers: List<Pair<String, String>>): List<Pair<String, String>> {
        for ((name, value) in headers) {
            val lower = name.lowercase(Locale.ROOT)
            if (!token.matches(name) || value.any { (it.code < 32 && it != '\t') || it.code == 127 } ||
                lower in managed || lower.startsWith("proxy-") || lower.startsWith("sec-"))
                throw HostFailure("INVALID_HEADER", "Unsupported HTTP header")
        }
        return headers
    }
}
