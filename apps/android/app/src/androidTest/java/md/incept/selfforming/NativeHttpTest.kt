package md.incept.selfforming

import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.Closeable
import java.io.FilterInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Opt-in device verification. Real Android connections; only the internal factory maps URLs to a test server. */
@RunWith(AndroidJUnit4::class)
class NativeHttpTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private fun call(http: NativeHttp, method: String, params: JSONObject): CompletableFuture<Any?> =
        CompletableFuture<Any?>().also { future -> http.dispatch(method, params, { future.complete(it) }, { future.completeExceptionally(it) }) }
    private fun wait(future: CompletableFuture<Any?>): Any? = future.get(45, TimeUnit.SECONDS)
    private fun id(value: String) = JSONObject().put("requestId", value)
    private fun open(http: NativeHttp, requestId: String, url: String, body: Boolean) {
        wait(call(http, "http.open", id(requestId).put("url", url).put("method", if (body) "POST" else "GET")
            .put("headers", JSONArray().put(JSONArray().put("Authorization").put("Bearer dummy-device-test")))
            .put("hasBody", body)))
    }
    private fun fixture(server: MockWebServer, root: File) = NativeHttp(root) { url ->
        // Production NativeHttpPolicy still validates the original provider URL first.
        server.url(url.file).toUrl().openConnection() as HttpURLConnection
    }
    private fun root() = File(context.cacheDir, "http-test-${UUID.randomUUID()}")

    @Test fun largeUploadAndResponseUseBoundedChunksAndExactBytes() {
        MockWebServer().use { server ->
        server.start()
        val root = root()
        val http = fixture(server, root)
        try {
            val chunk = ByteArray(65536) { (it % 251).toByte() }
            val response = Buffer()
            val responseDigest = MessageDigest.getInstance("SHA-256")
            repeat(192) { response.write(chunk); responseDigest.update(chunk) } // 12 MiB, beyond old auth response cap.
            server.enqueue(MockResponse().setBody(response).setHeader("Content-Type", "application/octet-stream"))
            open(http, "large", "https://api.openai.com/v1/responses", true)
            val uploadDigest = MessageDigest.getInstance("SHA-256")
            val encoded = Base64.encodeToString(chunk, Base64.NO_WRAP)
            repeat(544) { // 34 MiB, beyond the former model upload cap.
                wait(call(http, "http.write", id("large").put("data", encoded)))
                uploadDigest.update(chunk)
            }
            val head = wait(call(http, "http.send", id("large"))) as JSONObject
            assertEquals(200, head.getInt("status"))
            val receivedDigest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            while (true) {
                val part = wait(call(http, "http.read", id("large"))) as JSONObject
                val bytes = Base64.decode(part.getString("data"), Base64.NO_WRAP)
                assertTrue(bytes.size <= 65536)
                received += bytes.size; receivedDigest.update(bytes)
                if (part.getBoolean("done")) break
                assertTrue(bytes.isNotEmpty())
            }
            assertEquals(12L * 1024 * 1024, received)
            assertArrayEquals(responseDigest.digest(), receivedDigest.digest())
            val request = server.takeRequest(10, TimeUnit.SECONDS)!!
            assertEquals(34L * 1024 * 1024, request.bodySize)
            assertArrayEquals(uploadDigest.digest(), request.body.sha256().toByteArray())
            assertEquals((34L * 1024 * 1024).toString(), request.getHeader("Content-Length"))
            assertNull(request.getHeader("Origin")); assertNull(request.getHeader("Referer")); assertNull(request.getHeader("Cookie"))
            assertEquals("identity", request.getHeader("Accept-Encoding"))
            assertFalse(root.walkTopDown().any { it.isFile })
        } finally { http.close(); root.deleteRecursively() }
        }
    }

    @Test fun cancellationInterruptsPendingHeadersAndPendingBodyReads() {
        for (body in listOf(false, true)) StalledServer(body).use { server ->
            val root = root()
            val readStarted = CountDownLatch(1)
            val http = NativeHttp(root) { url ->
                val connection = URL("http://127.0.0.1:${server.port}${url.file}").openConnection() as HttpURLConnection
                if (body) ReadTrackingConnection(connection, readStarted) else connection
            }
            try {
                val requestId = if (body) "body" else "headers"
                open(http, requestId, "https://api.openai.com/v1/models", false)
                val sending = call(http, "http.send", id(requestId))
                server.requestReceived.get(10, TimeUnit.SECONDS)
                val pending = if (body) {
                    assertEquals(200, (wait(sending) as JSONObject).getInt("status"))
                    call(http, "http.read", id(requestId)).also {
                        assertTrue("Response InputStream.read was never entered", readStarted.await(10, TimeUnit.SECONDS))
                    }
                } else sending
                assertFalse("The stalled operation completed before cancellation", pending.isDone)
                wait(call(http, "http.cancel", id(requestId)))
                assertAborted(pending)
                // Also require real TCP disconnection; an early rejected promise alone is insufficient.
                server.disconnected.get(5, TimeUnit.SECONDS)
                assertFalse(root.walkTopDown().any { it.isFile })
            } finally { http.close(); root.deleteRecursively() }
        }
    }
    private fun assertAborted(future: CompletableFuture<Any?>) {
        try { future.get(8, TimeUnit.SECONDS); fail("Cancelled HTTP operation unexpectedly succeeded") }
        catch (error: java.util.concurrent.ExecutionException) {
            assertTrue(error.cause is HostFailure)
            assertEquals("ABORTED", (error.cause as HostFailure).code)
        }
    }

    /** No timed sleep or delayed MockWebServer task survives teardown. */
    private class StalledServer(private val body: Boolean) : Closeable {
        private val listener = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val port get() = listener.localPort
        val requestReceived = CompletableFuture<Unit>()
        val disconnected = CompletableFuture<Unit>()
        private val lifecycle = Any()
        private var closed = false
        @Volatile private var socket: Socket? = null
        private val worker = Thread({
            try {
                listener.accept().use { connection ->
                    synchronized(lifecycle) {
                        socket = connection
                        if (closed) connection.close()
                    }
                    val reader = connection.getInputStream().bufferedReader(Charsets.US_ASCII)
                    while (true) {
                        val line = reader.readLine() ?: throw IOException("Test request ended before its headers")
                        if (line.isEmpty()) break
                    }
                    if (body) connection.getOutputStream().also { output ->
                        output.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                        output.flush()
                    }
                    requestReceived.complete(Unit)
                    // The client owes no request body. EOF or reset demonstrates socket closure.
                    val next = try { connection.getInputStream().read() } catch (_: IOException) { -1 }
                    check(next == -1) { "Unexpected bytes after the test request" }
                    disconnected.complete(Unit)
                }
            } catch (error: Exception) {
                requestReceived.completeExceptionally(error)
                disconnected.completeExceptionally(error)
            }
        }, "http-stalled-test").apply { isDaemon = true; start() }
        override fun close() {
            try {
                synchronized(lifecycle) {
                    closed = true
                    try { listener.close() } finally { socket?.close() }
                }
            } finally {
                worker.join(3000)
                check(!worker.isAlive) { "Test socket worker did not terminate" }
            }
        }
    }

    /** Delegate every transport operation; observe entry to the real response read only. */
    private class ReadTrackingConnection(private val delegate: HttpURLConnection,
        private val readStarted: CountDownLatch) : HttpURLConnection(delegate.url) {
        override fun connect() = delegate.connect()
        override fun disconnect() = delegate.disconnect()
        override fun usingProxy() = delegate.usingProxy()
        override fun setRequestMethod(value: String) { delegate.requestMethod = value }
        override fun setInstanceFollowRedirects(value: Boolean) { delegate.instanceFollowRedirects = value }
        override fun setConnectTimeout(value: Int) { delegate.connectTimeout = value }
        override fun setReadTimeout(value: Int) { delegate.readTimeout = value }
        override fun setUseCaches(value: Boolean) { delegate.useCaches = value }
        override fun setRequestProperty(name: String, value: String) = delegate.setRequestProperty(name, value)
        override fun addRequestProperty(name: String, value: String) = delegate.addRequestProperty(name, value)
        override fun getResponseCode() = delegate.responseCode
        override fun getResponseMessage() = delegate.responseMessage
        override fun getHeaderFields() = delegate.headerFields
        override fun getErrorStream() = delegate.errorStream
        override fun getInputStream() = object : FilterInputStream(delegate.inputStream) {
            override fun read(bytes: ByteArray): Int {
                readStarted.countDown()
                return super.read(bytes)
            }
            override fun read(bytes: ByteArray, offset: Int, count: Int): Int {
                readStarted.countDown()
                return super.read(bytes, offset, count)
            }
        }
    }
}
