package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.net.URLEncoder

class ClaudeAuthUrlsTest {
    @Test fun claudeBrowserLaunchRequiresTheUpstreamClientCallbackAndPkce() {
        val fields = linkedMapOf(
            "code" to "true", "client_id" to "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            "redirect_uri" to "https://platform.claude.com/oauth/code/callback", "response_type" to "code",
            "scope" to "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
            "code_challenge" to "a".repeat(43), "code_challenge_method" to "S256", "state" to "b".repeat(43),
        )
        fun url(values: Map<String, String> = fields, endpoint: String = "https://claude.ai/oauth/authorize"): String =
            endpoint + "?" + values.entries.joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }
        ClaudeAuthUrls.authorize(url())
        for (endpoint in listOf("http://claude.ai/oauth/authorize", "https://claude.ai.evil.test/oauth/authorize",
            "https://user@claude.ai/oauth/authorize", "https://claude.ai:444/oauth/authorize", "https://claude.ai/other")) {
            assertThrows(HostFailure::class.java) { ClaudeAuthUrls.authorize(url(endpoint = endpoint)) }
        }
        for ((key, value) in listOf("client_id" to "other", "redirect_uri" to "https://example.test/callback",
            "response_type" to "token", "code" to "false", "code_challenge_method" to "plain",
            "code_challenge" to "short", "state" to "", "scope" to "user:profile")) {
            assertThrows(HostFailure::class.java) { ClaudeAuthUrls.authorize(url(fields + (key to value))) }
        }
        assertThrows(HostFailure::class.java) { ClaudeAuthUrls.authorize(url() + "&state=" + "b".repeat(43)) }
        assertThrows(HostFailure::class.java) { ClaudeAuthUrls.authorize(url() + "#fragment") }
    }
}
