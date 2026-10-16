package md.incept.selfforming

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest

/** ChatGPT sign-in URL checks shared by the browser launch and the untrusted loopback callback (Claude's: ClaudeAuthUrls). */
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
}
