package md.incept.selfforming

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * core-providers-claude's Kotlin half (R1; X5): the "claude" auth provider and the `claudeAuth` capability flag.
 * Its record stays where it always was (noBackupFilesDir/claude, Keystore alias md.incept.selfforming.claude.v1) in
 * the host's shared credential store; this half owns auth.openExternal (the upstream OAuth page, validated by
 * [ClaudeAuthUrls], whose code the user copies back). Method names, JSON shapes and errors are unchanged.
 */
internal object CoreProvidersClaudeNative : BuiltinNative {
    override fun capabilities(into: JSONObject) { into.put("claudeAuth", true) }

    override val authProvider: AuthProvider = object : AuthProvider {
        override val id = "claude"
        override val directory = "claude"
        override val keyAlias = "md.incept.selfforming.claude.v1"
        override fun signIn(context: Context): AuthSignIn = ClaudeSignIn(context)
    }
}

private class ClaudeSignIn(private val context: Context) : AuthSignIn {
    private val main = Handler(Looper.getMainLooper())

    override fun handles(method: String) = method == "auth.openExternal"

    override fun dispatch(method: String, params: JSONObject, call: AuthCall) {
        val url = params.getString("url")
        ClaudeAuthUrls.authorize(url)
        main.post {
            if (!call.current()) call.fail(HostFailure("AUTH_CANCELLED", "Sign-in cancelled"))
            else try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.done(null)
            } catch (_: Exception) {
                call.fail(HostFailure("AUTH_BROWSER", "No browser could open the sign-in page"))
            }
        }
    }
}
