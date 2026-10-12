package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class NativeHttpPolicyTest {
    @Test fun endpointsAreExactAndMethodsRemainScoped() {
        NativeHttpPolicy.endpoint("https://api.openai.com/v1/models", "GET", false)
        NativeHttpPolicy.endpoint("https://api.anthropic.com/v1/messages?beta=true", "POST", true)
        NativeHttpPolicy.endpoint("https://platform.claude.com/v1/oauth/token", "POST", true)
        for (url in listOf("http://api.openai.com/v1/models", "https://api.openai.com:8443/v1/models",
            "https://user@api.openai.com/v1/models", "https://api.openai.com/v1/models#fragment",
            "https://api.openai.com/v1/models/", "https://api.openai.com.evil.invalid/v1/models",
            "https://auth.openai.com/api/accounts/oauth/token?forward=yes")) {
            assertThrows(HostFailure::class.java) { NativeHttpPolicy.endpoint(url, "GET", false) }
        }
        assertThrows(HostFailure::class.java) { NativeHttpPolicy.endpoint("https://api.openai.com/v1/models", "POST", true) }
        assertThrows(HostFailure::class.java) { NativeHttpPolicy.endpoint("https://api.openai.com/v1/models", "GET", true) }
    }
    @Test fun credentialsAndProviderHeadersArePreservedWithoutBrowserMetadata() {
        val headers = listOf("Authorization" to "Bearer dummy-value", "User-Agent" to "claude-cli/test",
            "anthropic-beta" to "oauth-test", "Content-Type" to "application/json")
        assertEquals(headers, NativeHttpPolicy.headers(headers))
        for (name in listOf("Origin", "Referer", "Cookie", "Sec-Fetch-Site", "Proxy-Authorization", "Content-Length", "Accept-Encoding"))
            assertThrows(HostFailure::class.java) { NativeHttpPolicy.headers(listOf(name to "dummy")) }
        assertThrows(HostFailure::class.java) { NativeHttpPolicy.headers(listOf("Authorization" to "dummy\r\nInjected: no")) }
        assertEquals(65536, NativeHttpPolicy.headers(listOf("x-large" to "a".repeat(65536))).single().second.length)
    }
    @Test fun uploadsExceedFormerTotalCapAndDeleteOnClose() {
        val directory = Files.createTempDirectory("pi-http-upload-test").toFile()
        try {
            val upload = HttpUpload(directory)
            val chunk = ByteArray(65536) { (it % 251).toByte() }
            repeat(544) { upload.write(chunk) }
            assertEquals(34L * 1024 * 1024, upload.finish())
            upload.file.inputStream().use { input ->
                val buffer = ByteArray(chunk.size)
                repeat(544) {
                    var offset = 0
                    while (offset < buffer.size) { val count = input.read(buffer, offset, buffer.size - offset); assertTrue(count > 0); offset += count }
                    assertArrayEquals(chunk, buffer)
                }
                assertEquals(-1, input.read())
            }
            upload.close()
            assertFalse(upload.file.exists())
        } finally { directory.deleteRecursively() }
    }
    @Test fun initialCleanupRemovesCrashUploadsWithoutTouchingLiveClients() {
        val root = Files.createTempDirectory("pi-http-root-test").toFile()
        try {
            java.io.File(root, "orphan").writeText("dummy leftover")
            val first = HttpUploadDirectories.open(root)
            val live = java.io.File(first, "live").apply { writeText("dummy current") }
            assertFalse(java.io.File(root, "orphan").exists())
            val second = HttpUploadDirectories.open(root)
            assertTrue(live.exists())
            assertNotEquals(first, second)
        } finally { root.deleteRecursively() }
    }
}
