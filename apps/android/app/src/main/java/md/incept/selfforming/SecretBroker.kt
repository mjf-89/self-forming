package md.incept.selfforming

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Hands secret values to helper programs inside the Linux environment (PRoot shares the loopback with the app).
 *
 *   GET /v1/env?label=<url-encoded text>&wait=<seconds, default 60, max 120>
 *   Authorization: Bearer <token>
 *   -> 200 {"values":{"NAME":"value"},"denied":["NAME"],"locked":["NAME"]}
 *
 * The token selects the scope (agent, terminal or servers): only secrets enabled for it are returned. Tokens are random
 * 256-bit values created when the app process starts and compared in constant time. Locked fingerprint
 * secrets make the request wait for the user ([SecretPrompter]); names the user declines (or that are not answered
 * within `wait`) come back in `denied`, names that cannot be unlocked at all (no wait, no usable key) in `locked`.
 * Server limits: loopback only, at most 8 requests at once (others get 503), 8 KiB of request head, no body,
 * 5 s to send the request, GET only, connections are closed after one answer.
 */
internal object SecretBroker {
    private const val MAX_CONCURRENT = 8
    private const val MAX_HEAD_BYTES = 8 * 1024
    private const val READ_TIMEOUT_MS = 5_000
    private const val DEFAULT_WAIT_SECONDS = 60.0
    private const val MAX_WAIT_SECONDS = 120.0
    private const val MAX_LABEL_CHARS = 60
    private val SCOPES = listOf("agent", "terminal", "servers")

    private val random = SecureRandom()
    // One token per scope, created when this process first needs them (that is, once per app process start).
    private val tokens: Map<String, ByteArray> = SCOPES.associateWith {
        ByteArray(32).also { random.nextBytes(it) }.joinToString("") { b -> "%02x".format(b) }.toByteArray(Charsets.US_ASCII)
    }

    private val inflight = AtomicInteger()
    private val pool = ThreadPoolExecutor(MAX_CONCURRENT, MAX_CONCURRENT, 30, TimeUnit.SECONDS, LinkedBlockingQueue(MAX_CONCURRENT)) {
        Thread(it, "pi-secret-broker").apply { isDaemon = true }
    }.apply { allowCoreThreadTimeOut(true) }
    @Volatile private var server: ServerSocket? = null

    val port: Int get() = server?.localPort ?: 0

    /** Bind on first use. Returns false when the listener could not be opened. */
    @Synchronized fun ensureStarted(): Boolean {
        server?.takeIf { !it.isClosed }?.let { return true }
        return try {
            val socket = ServerSocket()
            socket.reuseAddress = false
            socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 32)
            server = socket
            Thread({ acceptLoop(socket) }, "pi-secret-broker-accept").apply { isDaemon = true; start() }
            true
        } catch (_: Exception) { false }
    }

    /** SF_SECRETS_URL and SF_SECRETS_TOKEN for a command of [scope], or null for an unknown scope / failed start. */
    fun environmentFor(scope: String?): Map<String, String>? {
        val token = tokens[scope] ?: return null
        if (!ensureStarted()) return null
        return linkedMapOf("SF_SECRETS_URL" to "http://127.0.0.1:$port", "SF_SECRETS_TOKEN" to String(token, Charsets.US_ASCII))
    }

    /** Copies of every token (redacted from command output). Empty until the listener exists. */
    fun tokenValues(): List<ByteArray> = if (server == null) emptyList() else SCOPES.map { tokens.getValue(it).copyOf() }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try { socket.accept() } catch (_: IOException) {
                if (socket.isClosed) break
                try { Thread.sleep(50) } catch (_: InterruptedException) {}
                continue
            }
            if (inflight.incrementAndGet() > MAX_CONCURRENT) {
                inflight.decrementAndGet()
                reject(client)
                continue
            }
            try {
                pool.execute { try { handle(client) } finally { inflight.decrementAndGet() } }
            } catch (_: RejectedExecutionException) {
                inflight.decrementAndGet()
                reject(client)
            }
        }
        synchronized(this) { if (server === socket) server = null }
    }

    private fun reject(client: Socket) {
        try { client.soTimeout = 500; respond(client, 503, "Service Unavailable", error("busy"), "Retry-After: 1\r\n") } catch (_: Exception) {}
        close(client)
    }

    // ---------------------------------------------------------------- one request

    private class Bad(val status: Int, val reason: String, val detail: String) : Exception(detail)
    private class Request(val method: String, val path: String, val query: Map<String, String>, val authorization: String?)

    private fun handle(client: Socket) {
        try {
            client.soTimeout = READ_TIMEOUT_MS
            client.tcpNoDelay = true
            val input = BufferedInputStream(client.getInputStream(), 2048)
            val request = try { read(input) } catch (bad: Bad) {
                return respond(client, bad.status, bad.reason, error(bad.detail))
            }
            val scope = authenticate(request.authorization)
                ?: return respond(client, 401, "Unauthorized", error("unauthorized"), "WWW-Authenticate: Bearer\r\n")
            if (request.method != "GET") return respond(client, 405, "Method Not Allowed", error("method not allowed"), "Allow: GET\r\n")
            if (request.path != "/v1/env") return respond(client, 404, "Not Found", error("not found"))
            val waitSeconds = request.query["wait"]?.let { text ->
                text.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }?.coerceAtMost(MAX_WAIT_SECONDS)
                    ?: return respond(client, 400, "Bad Request", error("invalid wait"))
            } ?: DEFAULT_WAIT_SECONDS
            val label = cleanLabel(request.query["label"])
            val fetched = SecretStore.fetch(scope, label, (waitSeconds * 1000).toLong()) { peerGone(client, input) }
            val values = JSONObject()
            fetched.values.forEach { (name, value) -> values.put(name, value) }
            respond(client, 200, "OK", JSONObject().put("values", values)
                .put("denied", JSONArray(fetched.denied)).put("locked", JSONArray(fetched.locked)).toString())
        } catch (_: Exception) {
            // Timeouts and broken connections: nothing to say, nobody is listening.
        } finally { close(client) }
    }

    /** The scope whose token matches, in constant time per comparison (all three are always compared). */
    private fun authenticate(header: String?): String? {
        if (header == null || header.length < 8 || !header.regionMatches(0, "Bearer ", 0, 7, ignoreCase = true)) return null
        val given = header.substring(7).trim().toByteArray(Charsets.ISO_8859_1)
        var match: String? = null
        for (scope in SCOPES) if (MessageDigest.isEqual(tokens.getValue(scope), given)) match = scope
        return match
    }

    private fun cleanLabel(raw: String?): String {
        val text = raw.orEmpty().filter { !it.isISOControl() }.trim()
        if (text.isEmpty()) return "A Linux command"
        return if (text.length <= MAX_LABEL_CHARS) text else text.substring(0, MAX_LABEL_CHARS - 1) + "\u2026"
    }

    /** A GET has no body, so a read that returns end-of-stream means the client hung up while waiting. */
    private fun peerGone(client: Socket, input: BufferedInputStream): Boolean = try {
        client.soTimeout = 1
        input.read() < 0
    } catch (_: SocketTimeoutException) { false } catch (_: IOException) { true }

    private fun read(input: BufferedInputStream): Request {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(READ_TIMEOUT_MS.toLong())
        val head = java.io.ByteArrayOutputStream()
        var tail = 0
        while (tail != 0x0d0a0d0a) {
            if (head.size() >= MAX_HEAD_BYTES) throw Bad(431, "Request Header Fields Too Large", "request too large")
            if (System.nanoTime() > deadline) throw Bad(408, "Request Timeout", "request timeout")
            val value = try { input.read() } catch (_: SocketTimeoutException) { throw Bad(408, "Request Timeout", "request timeout") }
            if (value < 0) throw Bad(400, "Bad Request", "incomplete request")
            head.write(value)
            tail = (tail shl 8) or value
        }
        val lines = head.toString("ISO-8859-1").split("\r\n").dropLast(2)
        val first = lines.firstOrNull()?.split(' ') ?: throw Bad(400, "Bad Request", "bad request")
        if (first.size != 3 || !first[2].startsWith("HTTP/1.")) throw Bad(400, "Bad Request", "bad request")
        var authorization: String? = null
        for (line in lines.drop(1)) {
            val colon = line.indexOf(':')
            if (colon <= 0 || line[0].isWhitespace()) throw Bad(400, "Bad Request", "bad header")
            val name = line.substring(0, colon).lowercase(java.util.Locale.ROOT)
            val value = line.substring(colon + 1).trim()
            when (name) {
                "authorization" -> { if (authorization != null) throw Bad(400, "Bad Request", "bad header"); authorization = value }
                "transfer-encoding" -> throw Bad(400, "Bad Request", "unsupported")
                "content-length" -> if (value != "0") throw Bad(400, "Bad Request", "unsupported")
            }
        }
        val target = first[1]
        val question = target.indexOf('?')
        val path = if (question < 0) target else target.substring(0, question)
        val query = HashMap<String, String>()
        if (question >= 0) for (pair in target.substring(question + 1).split('&')) {
            if (pair.isEmpty()) continue
            val equals = pair.indexOf('=')
            try {
                val key = URLDecoder.decode(if (equals < 0) pair else pair.substring(0, equals), "UTF-8")
                query[key] = if (equals < 0) "" else URLDecoder.decode(pair.substring(equals + 1), "UTF-8")
            } catch (_: IllegalArgumentException) { throw Bad(400, "Bad Request", "bad query") }
        }
        return Request(first[0], path, query, authorization)
    }

    private fun error(message: String) = JSONObject().put("error", message).toString()

    private fun respond(client: Socket, status: Int, reason: String, body: String, extra: String = "") {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status $reason\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.size}\r\n" +
            "Connection: close\r\nCache-Control: no-store\r\n$extra\r\n"
        client.soTimeout = READ_TIMEOUT_MS
        client.getOutputStream().apply { write(head.toByteArray(Charsets.US_ASCII)); write(bytes); flush() }
    }

    private fun close(client: Socket) { try { client.close() } catch (_: Exception) {} }
}
