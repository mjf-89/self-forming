package md.incept.selfforming

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/** Pull-based model and OAuth HTTP. Neither uploads nor response bodies are buffered in memory. */
internal class NativeHttp(root: File,
    private val connect: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    private class Request(val id: String, val url: URL, val method: String,
                          val headers: List<Pair<String, String>>, val hasBody: Boolean) {
        val cancelled = AtomicBoolean(false)
        val busy = AtomicBoolean(false)
        val disposed = AtomicBoolean(false)
        @Volatile var sent = false
        @Volatile var responded = false
        @Volatile var upload: HttpUpload? = null
        @Volatile var connection: HttpURLConnection? = null
        @Volatile var input: InputStream? = null
        fun check() { if (cancelled.get()) throw HostFailure("ABORTED", "HTTP request cancelled") }
    }
    private val directory = HttpUploadDirectories.open(root)
    private val requests = ConcurrentHashMap<String, Request>()
    private val admission = Any()
    private val workers = Executors.newFixedThreadPool(NativeHttpPolicy.MAX_REQUESTS) { Thread(it, "pi-http") }
    // A blocking read/write must never prevent cancellation from closing its connection.
    private val cancellers = Executors.newFixedThreadPool(NativeHttpPolicy.MAX_REQUESTS) { Thread(it, "pi-http-cancel") }
    @Volatile private var closed = false

    fun dispatch(method: String, params: JSONObject, done: (Any?) -> Unit, fail: (Throwable) -> Unit) {
        try {
            val id = params.getString("requestId")
            if (id.isEmpty() || id.length > 160) throw HostFailure("INVALID_REQUEST", "Invalid HTTP request identifier")
            if (method == "http.cancel") { requests[id]?.let(::cancel); done(null); return }
            if (closed) throw HostFailure("ABORTED", "HTTP host is closed")
            if (method == "http.open") {
                val verb = params.getString("method")
                val hasBody = params.getBoolean("hasBody")
                val url = NativeHttpPolicy.endpoint(params.getString("url"), verb, hasBody).toURL()
                val raw = params.getJSONArray("headers")
                val headers = NativeHttpPolicy.headers((0 until raw.length()).map { index ->
                    val pair = raw.getJSONArray(index)
                    if (pair.length() != 2) throw HostFailure("INVALID_HEADER", "Invalid HTTP header pair")
                    pair.getString(0) to pair.getString(1)
                })
                synchronized(admission) {
                    if (closed) throw HostFailure("ABORTED", "HTTP host is closed")
                    if (requests.size >= NativeHttpPolicy.MAX_REQUESTS) throw HostFailure("HTTP_BUSY", "Too many active HTTP requests")
                    if (requests.putIfAbsent(id, Request(id, url, verb, headers, hasBody)) != null)
                        throw HostFailure("DUPLICATE_ID", "HTTP request identifier is already active")
                }
                done(null)
                return
            }
            if (method !in setOf("http.write", "http.send", "http.read"))
                throw HostFailure("METHOD_NOT_FOUND", "Unknown HTTP method")
            val request = requests[id] ?: throw HostFailure("HTTP_STATE", "HTTP request is no longer active")
            request.check()
            if (!request.busy.compareAndSet(false, true)) throw HostFailure("HTTP_BUSY", "An HTTP operation is already pending")
            val operation = Runnable {
                var result: Any? = null
                var failure: HostFailure? = null
                try {
                    request.check()
                    result = when (method) {
                        "http.write" -> { write(request, params.getString("data")); null }
                        "http.send" -> send(request)
                        else -> read(request)
                    }
                    request.check()
                } catch (error: Exception) {
                    failure = safeError(error, request)
                }
                if (failure != null || request.cancelled.get() || request.disposed.get()) dispose(request)
                synchronized(request) {
                    if (request.cancelled.get() && failure == null) failure = HostFailure("ABORTED", "HTTP request cancelled")
                    // Release once, before publishing completion. A following RPC owns the flag
                    // immediately and this worker must never clear that newer operation's flag.
                    request.busy.set(false)
                    if (request.disposed.get()) requests.remove(request.id, request)
                }
                if (closed && requests.isEmpty()) directory.delete()
                failure?.let(fail) ?: done(result)
            }
            try { workers.execute(operation) }
            catch (_: RejectedExecutionException) {
                request.cancelled.set(true)
                request.busy.set(false)
                dispose(request)
                throw HostFailure("ABORTED", "HTTP host is closed")
            }
        } catch (error: Exception) { fail(safeError(error)) }
    }

    private fun write(request: Request, data: String) {
        if (!request.hasBody || request.sent) throw HostFailure("HTTP_STATE", "HTTP upload is not writable")
        if (data.length > ((NativeHttpPolicy.CHUNK_BYTES + 2) / 3) * 4 || !validBase64(data))
            throw HostFailure("TOO_LARGE", "Invalid HTTP upload chunk")
        val bytes = Base64.decode(data, Base64.NO_WRAP)
        if (bytes.size > NativeHttpPolicy.CHUNK_BYTES) throw HostFailure("TOO_LARGE", "HTTP chunks exceed 64 KiB")
        val upload = synchronized(request) {
            request.check()
            request.upload ?: HttpUpload(directory).also { request.upload = it }
        }
        request.check()
        upload.write(bytes)
    }

    private fun send(request: Request): JSONObject {
        if (request.sent) throw HostFailure("HTTP_STATE", "HTTP request was already sent")
        request.sent = true
        val connection = synchronized(request) {
            request.check()
            connect(request.url).also { request.connection = it }
        }
        request.check()
        connection.requestMethod = request.method
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 20_000
        connection.readTimeout = 0 // Reasoning can be quiet; AbortSignal and page ownership close the socket.
        connection.useCaches = false
        connection.setRequestProperty("Accept-Encoding", "identity")
        for ((name, value) in request.headers) connection.addRequestProperty(name, value)
        if (request.hasBody) {
            val upload = request.upload
            val length = upload?.finish() ?: 0L
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(length)
            try {
                request.check()
                connection.outputStream.use { output ->
                    upload?.file?.inputStream()?.use { input ->
                        val buffer = ByteArray(NativeHttpPolicy.CHUNK_BYTES)
                        while (true) {
                            request.check()
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                    }
                }
            } catch (error: Exception) {
                request.check()
                // Some servers reject an upload before consuming it. Preserve that HTTP error
                // if the platform exposes it, rather than losing it as a write exception.
                val status = try { connection.responseCode } catch (_: Exception) { -1 }
                if (status < 300) throw error
            } finally { upload?.close(); request.upload = null }
        }
        request.check()
        val status = connection.responseCode
        if (status !in 200..599) throw HostFailure("HTTP_NETWORK", "The server returned no valid HTTP response")
        if (status in 300..399 && status != 304) throw HostFailure("HTTP_REDIRECT", "HTTP redirects are not followed")
        val headers = JSONArray()
        for ((name, values) in connection.headerFields) if (name != null) for (value in values.orEmpty()) {
            if (name.lowercase(Locale.ROOT) !in setOf("set-cookie", "set-cookie2"))
                headers.put(JSONArray().put(name).put(value))
        }
        val input = when {
            status in setOf(204, 205, 304) -> null
            status >= 400 -> connection.errorStream
            else -> connection.inputStream
        }
        val accepted = synchronized(request) {
            if (request.cancelled.get()) false else { request.input = input; true }
        }
        if (!accepted) { try { input?.close() } catch (_: Exception) { }; request.check() }
        request.responded = true
        return JSONObject().put("status", status).put("statusText", connection.responseMessage ?: "")
            .put("headers", headers).put("url", request.url.toString())
    }

    private fun read(request: Request): JSONObject {
        if (!request.responded) throw HostFailure("HTTP_STATE", "HTTP response headers are not available")
        val bytes = ByteArray(NativeHttpPolicy.CHUNK_BYTES)
        var count: Int
        do { request.check(); count = request.input?.read(bytes) ?: -1 } while (count == 0)
        request.check()
        if (count < 0) {
            request.disposed.set(true)
            return JSONObject().put("data", "").put("done", true)
        }
        return JSONObject().put("data", Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP)).put("done", false)
    }

    private fun safeError(error: Exception, request: Request? = null): HostFailure = when {
        request?.cancelled?.get() == true -> HostFailure("ABORTED", "HTTP request cancelled")
        error is HostFailure -> error
        error is SocketTimeoutException -> HostFailure("HTTP_TIMEOUT", "The HTTP connection timed out")
        else -> HostFailure("HTTP_NETWORK", "The HTTP operation could not be completed")
    }

    private fun cancel(request: Request) {
        synchronized(admission) {
            if (requests[request.id] !== request) return
            synchronized(request) { if (!request.cancelled.compareAndSet(false, true)) return }
            // Admission also guards executor shutdown, so an admitted cancellation is queued
            // before close shuts this executor down; completed requests need no new work.
            cancellers.execute {
                // Android can create its internal connection after an earlier disconnect. Repeat
                // until the admitted operation settles, covering cancellation at that boundary.
                do {
                    dispose(request)
                    if (request.busy.get()) Thread.sleep(25)
                } while (request.busy.get())
                dispose(request)
            }
        }
    }
    private fun dispose(request: Request) {
        // Reclose after an in-flight operation settles: disconnect can race the platform
        // opening a socket. Keep its admission slot until that worker has actually finished.
        request.disposed.set(true)
        try { request.connection?.disconnect() } catch (_: Exception) { }
        try { request.input?.close() } catch (_: Exception) { }
        try { request.upload?.close() } catch (_: Exception) { }
        if (!request.busy.get()) requests.remove(request.id, request)
        if (closed && requests.isEmpty()) directory.delete()
    }
    fun reset() { synchronized(admission) { requests.values.toList().forEach(::cancel) } }
    fun close() {
        synchronized(admission) {
            closed = true
            requests.values.toList().forEach(::cancel)
            workers.shutdown()
            cancellers.shutdown()
        }
        if (requests.isEmpty()) directory.delete()
    }
    private fun validBase64(value: String): Boolean {
        if (value.length % 4 != 0) return false
        val padding = value.indexOf('=').let { if (it < 0) value.length else it }
        if (value.length - padding > 2) return false
        return value.take(padding).all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '+' || it == '/' } &&
            value.drop(padding).all { it == '=' }
    }
}
