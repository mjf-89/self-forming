package md.incept.selfforming

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest

/** Pure URL checks shared by the browser launch and the untrusted loopback callback. */
internal object AuthUrls {
    fun validateState(state: String) {
        if (!Regex("[A-Za-z0-9_-]{32,256}").matches(state)) {
            throw HostFailure("AUTH_STATE", "Sign-in requires a fresh URL-safe state value")
        }
    }

    fun authorize(url: String, redirectUri: String, state: String) {
        val uri = parse(url)
        if (url.length > 32 * 1024 || uri.scheme != "https" || uri.host != "auth.openai.com" ||
            (uri.port != -1 && uri.port != 443) || uri.rawPath != "/api/accounts/authorize" ||
            uri.userInfo != null || uri.rawFragment != null) denied()
        val query = query(uri.rawQuery)
        if (query["redirect_uri"] != redirectUri || !sameState(query["state"], state)) denied()
    }

    /** Claude's upstream OAuth flow returns a code to copy from its own callback page. */
    fun authorizeClaude(url: String) {
        val uri = parse(url)
        if (url.length > 32 * 1024 || uri.scheme != "https" || uri.host != "claude.ai" ||
            (uri.port != -1 && uri.port != 443) || uri.rawPath != "/oauth/authorize" ||
            uri.userInfo != null || uri.rawFragment != null) denied()
        val values = query(uri.rawQuery)
        if (values["client_id"] != CLAUDE_CLIENT_ID || values["redirect_uri"] != CLAUDE_REDIRECT_URI ||
            values["response_type"] != "code" || values["code"] != "true" || values["code_challenge_method"] != "S256" ||
            !PKCE.matches(values["code_challenge"] ?: "") || !PKCE.matches(values["state"] ?: "") ||
            values["scope"]?.split(' ')?.toSet() != CLAUDE_SCOPES) denied()
    }

    fun callback(target: String, host: String?, port: Int, state: String): String {
        if (target.length > 16 * 1024 || !target.startsWith('/') || target.startsWith("//") ||
            host != "127.0.0.1:$port") denied()
        val uri = parse(target)
        val query = query(uri.rawQuery)
        if (uri.isAbsolute || uri.rawAuthority != null || uri.rawPath != "/auth/callback" ||
            uri.rawFragment != null || !sameState(query["state"], state) ||
            (query["code"].isNullOrEmpty() && query["error"].isNullOrEmpty())) denied()
        return "http://127.0.0.1:$port$target"
    }

    private fun parse(value: String): URI = try { URI(value) }
        catch (_: Exception) { denied() }

    private fun query(raw: String?): Map<String, String> {
        if (raw == null || raw.length > 32 * 1024) denied()
        val result = HashMap<String, String>()
        for (part in raw.split('&')) {
            val pieces = part.split('=', limit = 2)
            val key = decode(pieces[0])
            val value = decode(pieces.getOrElse(1) { "" })
            if (key.isEmpty() || result.put(key, value) != null) denied()
        }
        return result
    }

    private fun decode(value: String): String = try { URLDecoder.decode(value, "UTF-8") }
        catch (_: Exception) { denied() }

    private fun sameState(received: String?, expected: String): Boolean = received != null &&
        MessageDigest.isEqual(received.toByteArray(Charsets.UTF_8), expected.toByteArray(Charsets.UTF_8))

    private fun denied(): Nothing = throw HostFailure("AUTH_URL", "Sign-in URL did not match the active attempt")

    private val PKCE = Regex("[A-Za-z0-9_-]{43}")
    private const val CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    private const val CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
    private val CLAUDE_SCOPES = setOf("org:create_api_key", "user:profile", "user:inference",
        "user:sessions:claude_code", "user:mcp_servers", "user:file_upload")
}
