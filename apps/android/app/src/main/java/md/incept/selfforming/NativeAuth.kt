package md.incept.selfforming

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletionException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Storage/dispatch has its own actor; auth.wait registers a completion instead of blocking it. */
internal class NativeAuth(private val context: Context) {
    private data class Attempt(val id: String, val state: String, val listener: LoopbackAuth)
    // Keep the original ChatGPT path and alias so existing installations stay signed in.
    private val chatGPTStore = AuthStore(File(context.noBackupFilesDir, "chatgpt"))
    private val claudeStore = AuthStore(File(context.noBackupFilesDir, "claude"), "md.incept.selfforming.claude.v1")
    private val main = Handler(Looper.getMainLooper())
    private val epoch = AtomicLong(0)
    private val lock = Any()
    @Volatile private var attempt: Attempt? = null
    @Volatile private var closed = false

    fun dispatch(method: String, params: JSONObject, done: (Any?) -> Unit, fail: (Throwable) -> Unit) {
        val version = epoch.get()
        AuthWorker.executor.execute {
            try {
                if (closed || version != epoch.get()) cancelled()
                val provider = params.optString("provider", "chatgpt")
                val store = when (provider) {
                    "chatgpt" -> chatGPTStore
                    "claude" -> claudeStore
                    else -> throw HostFailure("AUTH_PROVIDER", "Unknown sign-in provider")
                }
                if (provider != "chatgpt" && method in setOf("auth.listen", "auth.open", "auth.wait", "auth.cancel"))
                    throw HostFailure("AUTH_PROVIDER", "This provider uses a code from its sign-in page")
                when (method) {
                    "auth.info" -> done(JSONObject().put("hostId", store.hostId()).put("storage", "encrypted"))
                    "auth.load" -> done(store.load())
                    "auth.save" -> { store.save(params.getJSONObject("record")); done(null) }
                    "auth.clear" -> { store.clear(); done(null) }
                    "auth.openExternal" -> {
                        if (provider != "claude") throw HostFailure("AUTH_PROVIDER", "Unsupported external sign-in provider")
                        val url = params.getString("url")
                        AuthUrls.authorizeClaude(url)
                        main.post {
                            if (closed || version != epoch.get()) fail(HostFailure("AUTH_CANCELLED", "Sign-in cancelled"))
                            else try {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                    .addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                done(null)
                            } catch (_: Exception) {
                                fail(HostFailure("AUTH_BROWSER", "No browser could open the sign-in page"))
                            }
                        }
                    }
                    "auth.listen" -> {
                        val state = params.getString("state")
                        if (attempt?.listener?.result?.isDone == false) throw HostFailure("AUTH_BUSY", "Another sign-in is already in progress")
                        // Binding the socket happens off the UI thread and outside the lifecycle lock.
                        val next = Attempt(UUID.randomUUID().toString(), state, LoopbackAuth(state))
                        val admitted = synchronized(lock) {
                            if (closed || version != epoch.get()) false
                            else { attempt = next; true }
                        }
                        if (!admitted) { next.listener.cancel(); cancelled() }
                        next.listener.result.whenComplete { _, _ -> SignInService.stop(next.id) }
                        done(JSONObject().put("attemptId", next.id).put("redirectUri", next.listener.redirectUri))
                    }
                    "auth.open" -> {
                        val current = current(params)
                        val url = params.getString("url")
                        AuthUrls.authorize(url, current.listener.redirectUri, current.state)
                        // A later service failure still cancels auth.wait, but auth.open
                        // has exactly one reply even after the browser was launched.
                        val replied = AtomicBoolean(false)
                        fun opened() { if (replied.compareAndSet(false, true)) done(null) }
                        fun openFailed(error: Throwable) { if (replied.compareAndSet(false, true)) fail(error) }
                        main.post {
                            if (closed || version != epoch.get() || attempt !== current || current.listener.result.isDone) {
                                openFailed(HostFailure("AUTH_CANCELLED", "Sign-in cancelled"))
                            } else SignInService.start(context, current.id, ready = {
                                if (closed || version != epoch.get() || attempt !== current || current.listener.result.isDone) {
                                    SignInService.stop(current.id)
                                    openFailed(HostFailure("AUTH_CANCELLED", "Sign-in cancelled"))
                                } else try {
                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                        .addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                    opened()
                                } catch (_: Exception) {
                                    current.listener.cancel()
                                    openFailed(HostFailure("AUTH_BROWSER", "No browser could open the sign-in page"))
                                }
                            }, failed = { error -> current.listener.cancel(); openFailed(error) })
                        }
                    }
                    "auth.wait" -> {
                        val current = current(params)
                        current.listener.result.whenComplete { url, error ->
                            if (error != null) fail(if (error is CompletionException) error.cause ?: error else error)
                            else done(JSONObject().put("url", url))
                            synchronized(lock) { if (attempt === current) attempt = null }
                        }
                    }
                    "auth.cancel" -> {
                        val requested = params.getString("attemptId")
                        attempt?.takeIf { it.id == requested }?.listener?.cancel()
                        done(null)
                    }
                    else -> throw HostFailure("METHOD_NOT_FOUND", "Unknown sign-in method")
                }
            } catch (error: Exception) {
                // Never send platform exceptions that might include a URL, record, or token.
                fail(if (error is HostFailure) error else HostFailure("AUTH_ERROR", "The sign-in operation failed"))
            }
        }
    }

    private fun current(params: JSONObject): Attempt = attempt?.takeIf { it.id == params.getString("attemptId") }
        ?: throw HostFailure("AUTH_ATTEMPT", "Sign-in attempt is no longer active")

    fun reset() {
        epoch.incrementAndGet()
        val previous = synchronized(lock) { attempt.also { attempt = null } }
        previous?.listener?.cancel()
    }

    fun close() { closed = true; reset() }
    private fun cancelled(): Nothing = throw HostFailure("AUTH_CANCELLED", "Sign-in cancelled")
}

/** Serializes credential changes across Activity recreation, independently from SQLite. */
private object AuthWorker {
    val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "pi-auth") }
}
