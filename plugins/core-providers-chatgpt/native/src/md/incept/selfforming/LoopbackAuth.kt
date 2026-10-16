package md.incept.selfforming

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** One bounded, IPv4 loopback-only OAuth callback listener. No request data is logged or reflected. */
internal class LoopbackAuth(private val state: String, timeoutMillis: Long = 5 * 60_000L) : LoopbackListener {
    private val server = ServerSocket()
    private val reading = AtomicReference<Socket?>()
    private val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
    override val result = CompletableFuture<String>()
    val port: Int get() = server.localPort
    override val redirectUri: String

    init {
        AuthUrls.validateState(state)
        try {
            server.reuseAddress = false
            server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 4)
            server.soTimeout = 500
            redirectUri = "http://127.0.0.1:${server.localPort}/auth/callback"
            Thread({ receive() }, "pi-auth-callback").apply { isDaemon = true; start() }
        } catch (_: Exception) {
            try { server.close() } catch (_: Exception) { }
            throw HostFailure("AUTH_LISTENER", "Could not open the local sign-in listener")
        }
    }

    override fun cancel() {
        result.completeExceptionally(HostFailure("AUTH_CANCELLED", "Sign-in cancelled"))
        closeSockets()
    }

    private fun receive() {
        try {
            while (!result.isDone) {
                if (System.nanoTime() >= deadline) {
                    result.completeExceptionally(HostFailure("AUTH_TIMEOUT", "Sign-in timed out; start again"))
                    break
                }
                val socket = try { server.accept() } catch (_: SocketTimeoutException) { continue }
                reading.set(socket)
                socket.use {
                    if (result.isDone) return@use
                    socket.soTimeout = 500
                    try {
                        val request = readRequest(socket)
                        val callback = AuthUrls.callback(request.target, request.host, server.localPort, state)
                        reply(socket, 200, "Sign-in received. Return to Self Forming to continue.")
                        result.complete(callback)
                    } catch (_: Exception) {
                        // Invalid/malformed callbacks cannot consume the valid pending attempt.
                        try { reply(socket, 400, "This sign-in callback was not accepted.") } catch (_: Exception) { }
                    }
                }
                reading.compareAndSet(socket, null)
            }
        } catch (_: Exception) {
            if (!result.isDone) result.completeExceptionally(HostFailure("AUTH_LISTENER", "The local sign-in listener stopped"))
        } finally { closeSockets() }
    }

    private data class Request(val target: String, val host: String)

    private fun readRequest(socket: Socket): Request {
        val input = socket.getInputStream()
        val bytes = ByteArrayOutputStream()
        val readDeadline = minOf(deadline, System.nanoTime() + TimeUnit.SECONDS.toNanos(2))
        var suffix = 0
        while (suffix != 0x0d0a0d0a) {
            if (bytes.size() >= 16 * 1024 || System.nanoTime() >= readDeadline || result.isDone) invalid()
            val value = input.read()
            if (value < 0 || (value < 32 && value != 13 && value != 10) || value > 126) invalid()
            bytes.write(value)
            suffix = (suffix shl 8) or value
        }
        val lines = bytes.toString("US-ASCII").split("\r\n")
        if (lines.size > 66) invalid()
        val first = lines.first().split(' ')
        if (first.size != 3 || first[0] != "GET" || first[2] != "HTTP/1.1") invalid()
        val headers = HashMap<String, String>()
        for (line in lines.drop(1).filter { it.isNotEmpty() }) {
            val colon = line.indexOf(':')
            if (colon <= 0 || line[0].isWhitespace()) invalid()
            val name = line.substring(0, colon).lowercase(java.util.Locale.ROOT)
            if (!Regex("[!#\$%&'*+.^_`|~0-9a-z-]+").matches(name)) invalid()
            if (headers.put(name, line.substring(colon + 1).trim()) != null) invalid()
        }
        if (headers.containsKey("transfer-encoding") || headers["content-length"]?.let { it != "0" } == true) invalid()
        return Request(first[1], headers["host"] ?: invalid())
    }

    private fun reply(socket: Socket, status: Int, message: String) {
        // Navigation only: OAuth parameters stay in the validated loopback callback.
        val returnLink = if (status == 200) "<p><a href=\"intent://signin-complete#Intent;scheme=${BuildConfig.SIGN_IN_SCHEME};package=${BuildConfig.APPLICATION_ID};end\">Return to Self Forming</a></p>" else ""
        val body = "<!doctype html><html><head><meta name=viewport content=\"width=device-width,initial-scale=1\"><meta name=referrer content=no-referrer><title>Self Forming</title></head><body><h1>Self Forming</h1><p>$message</p>$returnLink</body></html>"
            .toByteArray(Charsets.UTF_8)
        val headers = "HTTP/1.1 $status ${if (status == 200) "OK" else "Bad Request"}\r\n" +
            "Content-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
            "Connection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n" +
            "Content-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\n\r\n"
        socket.getOutputStream().apply { write(headers.toByteArray(Charsets.US_ASCII)); write(body); flush() }
    }

    private fun closeSockets() {
        try { server.close() } catch (_: Exception) { }
        try { reading.getAndSet(null)?.close() } catch (_: Exception) { }
    }

    private fun invalid(): Nothing = throw HostFailure("AUTH_CALLBACK", "Invalid local sign-in callback")
}
