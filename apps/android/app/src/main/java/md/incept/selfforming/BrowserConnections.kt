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

    /**
     * Relay origins the network route plugins need (N4): libs/cors-rot runs Tor (webtor over Snowflake) and Tailscale
     * (tsconnect, Go→WASM) inside the page. Taken from the library source; the page CSP's connect-src lists exactly these:
     *  - wss://snowflake.torproject.net — the Snowflake WebSocket bridge webtor connects to (network.js SNOWFLAKE_URL) and
     *    the relay the Snowflake proxy frame forwards to; wss on any subdomain of snowflake.torproject.net — other relays the broker may
     *    assign (the proxy accepts any host ending in snowflake.torproject.net, snowflake-core.js allowedRelayPattern);
     *  - https://snowflake-broker.torproject.net (+ :8443) — the proxy frame polls the broker and probes its NAT type
     *    (snowflake-core.js brokerUrl, PROBEURL);
     *  - https and wss on subdomains of tailscale.com — Tailscale's control plane (controlplane.tailscale.com: key fetch
     *    over HTTPS, Noise over WebSocket) and its DERP relays (derpN.tailscale.com over WebSocket, HTTPS latency probes).
     * The page also needs connect-src 'self': tailscale-client.js fetches its own tailscale.wasm.
     */
    val RELAY_CONNECT_SRC = listOf("wss://snowflake.torproject.net", "wss://*.snowflake.torproject.net",
        "https://snowflake-broker.torproject.net", "https://snowflake-broker.torproject.net:8443",
        "https://*.tailscale.com", "wss://*.tailscale.com")

    /** HTTPS requests to those relays pass the WebView request filter (WebSockets never reach it). App origin only. */
    fun relay(url: String, method: String, origin: String?): Boolean {
        if (origin != APP_ORIGIN || method !in setOf("GET", "HEAD", "POST", "OPTIONS")) return false
        val uri = try { URI(url) } catch (_: Exception) { return false }
        if (uri.scheme != "https" || uri.userInfo != null || uri.rawFragment != null) return false
        val host = uri.host ?: return false
        return when {
            host == "snowflake-broker.torproject.net" -> uri.port in setOf(-1, 443, 8443)
            TAILSCALE.matches(host) -> uri.port == -1 || uri.port == 443
            else -> false
        }
    }

    private val TAILSCALE = Regex("([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+tailscale\\.com")
}
