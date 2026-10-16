package md.incept.selfforming

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LoopbackPolicyTest {
    @Test fun onlyExactHttpLoopbackHostsAreAllowed() {
        for (url in listOf("http://127.0.0.1:8091/", "http://localhost:8888/lab", "https://localhost/")) {
            assertTrue(url, MainActivity.allowedLoopback(Uri.parse(url)))
            assertFalse("Local pages must not receive the bridge", MainActivity.allowedOrigin(Uri.parse(url)))
        }
        for (url in listOf(
            "https://example.com/", "http://localhost.example.com/", "http://192.168.1.1/",
            "http://127.0.0.1@example.com/", "http://user@localhost/",
            "file:///etc/passwd", "javascript:alert(1)", "http://localhost:0/", "http://localhost:65536/"
        )) assertFalse(url, MainActivity.allowedLoopback(Uri.parse(url)))
    }
}
