package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.net.URLEncoder

class AuthUrlsTest {
    private val state = "dGhpcy1pcy1hLXJhbmRvbS10ZXN0LXN0YXRl"
    private val redirect = "http://127.0.0.1:45678/auth/callback"
    private val query = "state=$state&redirect_uri=${URLEncoder.encode(redirect, "UTF-8")}&response_type=code"

    @Test fun stateMustHaveAtLeast32UrlSafeCharacters() {
        AuthUrls.validateState("a".repeat(32))
        assertThrows(HostFailure::class.java) { AuthUrls.validateState("a".repeat(31)) }
        assertThrows(HostFailure::class.java) { AuthUrls.validateState("a".repeat(257)) }
        assertThrows(HostFailure::class.java) { AuthUrls.validateState("a".repeat(32) + "+") }
    }

    @Test fun authorizationAllowsOnlyTheExactEndpointAndBoundAttempt() {
        AuthUrls.authorize("https://auth.openai.com/api/accounts/authorize?$query", redirect, state)
        for (url in listOf(
            "http://auth.openai.com/api/accounts/authorize?$query",
            "https://auth.openai.com.evil.test/api/accounts/authorize?$query",
            "https://other@auth.openai.com/api/accounts/authorize?$query",
            "https://auth.openai.com:444/api/accounts/authorize?$query",
            "https://auth.openai.com/api/accounts/authorize/other?$query",
            "https://auth.openai.com/api/accounts/authorize?$query#secret",
            "https://auth.openai.com/api/accounts/authorize?$query&state=$state",
            "https://auth.openai.com/api/accounts/authorize?state=wrong&redirect_uri=$redirect",
        )) assertThrows(HostFailure::class.java) { AuthUrls.authorize(url, redirect, state) }
    }

    @Test fun callbackRequiresExactHostPathAndStateEvenForErrors() {
        assertEquals("$redirect?state=$state&error=access_denied",
            AuthUrls.callback("/auth/callback?state=$state&error=access_denied", "127.0.0.1:45678", 45678, state))
        for ((target, host) in listOf(
            "/auth/callback?state=$state" to "localhost:45678",
            "/auth/callback?state=$state" to "127.0.0.1:45679",
            "/auth/callback?state=$state" to "evil.test:45678",
            "/callback?state=$state" to "127.0.0.1:45678",
            "/auth/callback?error=access_denied" to "127.0.0.1:45678",
            "/auth/callback?state=$state" to "127.0.0.1:45678",
            "/auth/callback?state=$state&code=&error=" to "127.0.0.1:45678",
            "/auth/callback?state=$state&state=other" to "127.0.0.1:45678",
            "http://127.0.0.1:45678/auth/callback?state=$state" to "127.0.0.1:45678",
        )) assertThrows(HostFailure::class.java) { AuthUrls.callback(target, host, 45678, state) }
    }

    @Test fun claudeBrowserLaunchRequiresTheUpstreamClientCallbackAndPkce() {
        val fields = linkedMapOf(
            "code" to "true", "client_id" to "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            "redirect_uri" to "https://platform.claude.com/oauth/code/callback", "response_type" to "code",
            "scope" to "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
            "code_challenge" to "a".repeat(43), "code_challenge_method" to "S256", "state" to "b".repeat(43),
        )
        fun url(values: Map<String, String> = fields, endpoint: String = "https://claude.ai/oauth/authorize"): String =
            endpoint + "?" + values.entries.joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }
        AuthUrls.authorizeClaude(url())
        for (endpoint in listOf("http://claude.ai/oauth/authorize", "https://claude.ai.evil.test/oauth/authorize",
            "https://user@claude.ai/oauth/authorize", "https://claude.ai:444/oauth/authorize", "https://claude.ai/other")) {
            assertThrows(HostFailure::class.java) { AuthUrls.authorizeClaude(url(endpoint = endpoint)) }
        }
        for ((key, value) in listOf("client_id" to "other", "redirect_uri" to "https://example.test/callback",
            "response_type" to "token", "code" to "false", "code_challenge_method" to "plain",
            "code_challenge" to "short", "state" to "", "scope" to "user:profile")) {
            assertThrows(HostFailure::class.java) { AuthUrls.authorizeClaude(url(fields + (key to value))) }
        }
        assertThrows(HostFailure::class.java) { AuthUrls.authorizeClaude(url() + "&state=" + "b".repeat(43)) }
        assertThrows(HostFailure::class.java) { AuthUrls.authorizeClaude(url() + "#fragment") }
    }
}
