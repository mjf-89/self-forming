package md.incept.selfforming

import java.net.URI
import java.net.URLDecoder

/** The Claude sign-in page the browser may open (moved from the host's AuthUrls.authorizeClaude with X5). */
internal object ClaudeAuthUrls {
    /** Claude's upstream OAuth flow returns a code to copy from its own callback page. */
    fun authorize(url: String) {
        val uri = parse(url)
        if (url.length > 32 * 1024 || uri.scheme != "https" || uri.host != "claude.ai" ||
            (uri.port != -1 && uri.port != 443) || uri.rawPath != "/oauth/authorize" ||
            uri.userInfo != null || uri.rawFragment != null) denied()
        val values = query(uri.rawQuery)
        if (values["client_id"] != CLIENT_ID || values["redirect_uri"] != REDIRECT_URI ||
            values["response_type"] != "code" || values["code"] != "true" || values["code_challenge_method"] != "S256" ||
            !PKCE.matches(values["code_challenge"] ?: "") || !PKCE.matches(values["state"] ?: "") ||
            values["scope"]?.split(' ')?.toSet() != SCOPES) denied()
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

    private fun denied(): Nothing = throw HostFailure("AUTH_URL", "Sign-in URL did not match the active attempt")

    private val PKCE = Regex("[A-Za-z0-9_-]{43}")
    private const val CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    private const val REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
    private val SCOPES = setOf("org:create_api_key", "user:profile", "user:inference",
        "user:sessions:claude_code", "user:mcp_servers", "user:file_upload")
}
