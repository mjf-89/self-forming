package md.incept.selfforming

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * core-providers-chatgpt's Kotlin half (R1; X5): the "chatgpt" auth provider. Its record stays where it always was
 * (noBackupFilesDir/chatgpt, Keystore alias md.incept.selfforming.chatgpt.v1) in the host's shared credential store;
 * this half owns the browser sign-in with a loopback redirect: auth.listen/open/wait/cancel ([LoopbackAuth],
 * [SignInService], [AuthUrls]). Method names, JSON shapes and errors are unchanged.
 */
internal object CoreProvidersChatgptNative : BuiltinNative {
    override val authProvider: AuthProvider = object : AuthProvider {
        override val id = "chatgpt"
        override val directory = "chatgpt"
        override val keyAlias = "md.incept.selfforming.chatgpt.v1"
        override fun signIn(context: Context): AuthSignIn = ChatGPTSignIn(context)
    }
}

internal interface LoopbackListener {
    val result: CompletableFuture<String>
    val redirectUri: String
    fun cancel()
}

/** One per NativeAuth (bridge). Called on the host's auth worker; browser launches happen on the main thread. */
private class ChatGPTSignIn(private val context: Context) : AuthSignIn {
    private class Attempt(val id: String, val state: String, val listener: LoopbackListener)
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    @Volatile private var attempt: Attempt? = null

    override fun handles(method: String) = method in setOf("auth.listen", "auth.open", "auth.wait", "auth.cancel")

    override fun dispatch(method: String, params: JSONObject, call: AuthCall) {
        val done = call.done
        val fail = call.fail
        when (method) {
            "auth.listen" -> {
                val state = params.getString("state")
                if (attempt?.listener?.result?.isDone == false) throw HostFailure("AUTH_BUSY", "Another sign-in is already in progress")
                // Binding the socket happens off the UI thread and outside the lifecycle lock.
                val next = Attempt(UUID.randomUUID().toString(), state, LoopbackAuth(state))
                val admitted = synchronized(lock) {
                    if (!call.current()) false
                    else { attempt = next; true }
                }
                if (!admitted) { next.listener.cancel(); throw HostFailure("AUTH_CANCELLED", "Sign-in cancelled") }
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
                    if (!call.current() || attempt !== current || current.listener.result.isDone) {
                        openFailed(HostFailure("AUTH_CANCELLED", "Sign-in cancelled"))
                    } else SignInService.start(context, current.id, ready = {
                        if (!call.current() || attempt !== current || current.listener.result.isDone) {
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
    }

    private fun current(params: JSONObject): Attempt = attempt?.takeIf { it.id == params.getString("attemptId") }
        ?: throw HostFailure("AUTH_ATTEMPT", "Sign-in attempt is no longer active")

    override fun reset() {
        val previous = synchronized(lock) { attempt.also { attempt = null } }
        previous?.listener?.cancel()
    }
}
