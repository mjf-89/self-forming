package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class LoopbackAuthTest {
    private val state = "dGhpcy1pcy1hLXJhbmRvbS10ZXN0LXN0YXRl"

    @Test fun invalidCallbackDoesNotConsumeAttemptAndSuccessPageNeverReflectsSecrets() {
        val listener = LoopbackAuth(state, timeoutMillis = 10_000)
        try {
            assertTrue(listener.redirectUri.startsWith("http://127.0.0.1:"))
            assertTrue(request(listener.port, "/auth/callback?state=wrong&code=bad").startsWith("HTTP/1.1 400"))
            assertFalse(listener.result.isDone)
            assertTrue(request(listener.port, "/auth/callback?state=$state").startsWith("HTTP/1.1 400"))
            assertFalse(listener.result.isDone)
            assertTrue(request(listener.port, "/auth/callback?state=$state&code=bad", "evil.test:${listener.port}").startsWith("HTTP/1.1 400"))
            assertFalse(listener.result.isDone)
            val response = request(listener.port, "/auth/callback?state=$state&code=secret-code")
            assertTrue(response.startsWith("HTTP/1.1 200"))
            assertFalse(response.contains(state))
            assertFalse(response.contains("secret-code"))
            assertTrue(response.contains("intent://signin-complete#Intent;scheme=selfforming;package=md.incept.selfforming;end"))
            assertEquals("${listener.redirectUri}?state=$state&code=secret-code", listener.result.get(2, TimeUnit.SECONDS))
        } finally { listener.cancel() }
    }

    @Test fun cancellationReleasesPortAndSettlesWait() {
        val listener = LoopbackAuth(state)
        val port = listener.port
        listener.cancel()
        val error = assertThrows(ExecutionException::class.java) { listener.result.get(2, TimeUnit.SECONDS) }
        assertEquals("AUTH_CANCELLED", (error.cause as HostFailure).code)
        awaitReleasedPort(port)
    }

    @Test fun timeoutSettlesPendingWait() {
        val listener = LoopbackAuth(state, timeoutMillis = 50)
        try {
            val error = assertThrows(ExecutionException::class.java) { listener.result.get(2, TimeUnit.SECONDS) }
            assertEquals("AUTH_TIMEOUT", (error.cause as HostFailure).code)
        } finally { listener.cancel() }
    }

    private fun awaitReleasedPort(port: Int) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        var lastFailure: BindException? = null
        // The JVM may defer the final descriptor close until its blocked accept unwinds.
        // Require the same exclusive bind to succeed promptly, without enabling address reuse.
        do {
            try {
                ServerSocket().use { socket ->
                    socket.reuseAddress = false
                    socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 1)
                    assertTrue(socket.isBound)
                }
                return
            } catch (error: BindException) { lastFailure = error }
            Thread.sleep(10)
        } while (System.nanoTime() < deadline)
        throw AssertionError("Cancelling sign-in did not release its port within two seconds", lastFailure)
    }

    private fun request(port: Int, target: String, host: String = "127.0.0.1:$port"): String = Socket("127.0.0.1", port).use { socket ->
        socket.soTimeout = 3000
        socket.getOutputStream().write("GET $target HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
        socket.getInputStream().readBytes().toString(Charsets.UTF_8)
    }
}
