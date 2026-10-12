package md.incept.selfforming

import java.net.URI

/** Direct browser model traffic is permitted only from the packaged application origin. */
internal object BrowserConnections {
    private const val APP_ORIGIN = "https://appassets.androidplatform.net"

    fun allowed(url: String, method: String, origin: String?): Boolean {
        if (origin != APP_ORIGIN) return false
        val uri = try { URI(url) } catch (_: Exception) { return false }
        if (uri.scheme != "https" || uri.userInfo != null || uri.rawFragment != null ||
            (uri.port != -1 && uri.port != 443)) return false
        val expected = when (uri.host to uri.rawPath) {
            "api.openai.com" to "/v1/responses" -> "POST"
            "api.openai.com" to "/v1/models" -> "GET"
            "api.anthropic.com" to "/v1/messages" -> "POST"
            "api.anthropic.com" to "/v1/models" -> "GET"
            else -> return false
        }
        return method == expected || method == "OPTIONS"
    }
}
