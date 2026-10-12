package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test

class BrowserConnectionsTest {
    private val origin = "https://appassets.androidplatform.net"

    @Test fun onlyRequiredModelEndpointsAndMethodsAreAdmitted() {
        for ((url, method) in listOf("https://api.openai.com/v1/responses" to "POST",
            "https://api.openai.com/v1/models" to "GET", "https://api.anthropic.com/v1/messages?beta=true" to "POST",
            "https://api.anthropic.com/v1/models" to "GET")) {
            assertTrue(BrowserConnections.allowed(url, method, origin))
            assertTrue(BrowserConnections.allowed(url, "OPTIONS", origin))
            assertFalse(BrowserConnections.allowed(url, "DELETE", origin))
        }
    }

    @Test fun previewOriginsNavigationAndLookalikeEndpointsDoNotGetModelAccess() {
        val url = "https://api.openai.com/v1/responses"
        for (other in listOf(null, "null", "http://127.0.0.1:3000", "https://example.test",
            "$origin.evil.test", "$origin/")) assertFalse(BrowserConnections.allowed(url, "POST", other))
        for (other in listOf("http://api.openai.com/v1/responses", "https://api.openai.com.evil.test/v1/responses",
            "https://user@api.openai.com/v1/responses", "https://api.openai.com:444/v1/responses",
            "https://api.openai.com/v1/responses/other", "https://api.openai.com/v1/%72esponses",
            "https://api.openai.com/v1/files", "https://auth.openai.com/api/accounts/oauth/token",
            "https://api.anthropic.com/v1/messages#fragment")) assertFalse(BrowserConnections.allowed(other, "POST", origin))
    }
}
