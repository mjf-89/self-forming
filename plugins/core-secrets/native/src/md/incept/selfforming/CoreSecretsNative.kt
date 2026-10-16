package md.incept.selfforming

import android.app.Activity
import android.content.Context
import org.json.JSONObject

/**
 * core-secrets' Kotlin half (R1, step X5): Settings → Secrets storage ([SecretStore]: Android Keystore keys
 * sf-secrets / sf-secrets-bio / sf-secrets-ask, noBackupFilesDir/secrets.json), the loopback [SecretBroker] for the
 * agent/terminal/servers scopes, fingerprint prompts ([SecretPrompter], [SecretPrompt]) and output [Redaction].
 * Offers the secrets.* routes with the `secrets`/`secretBroker` flags, [CommandSecrets] for core-execution and
 * MainActivity's [ActivityHooks]; scope, biometric and redaction rules are unchanged. A fork without
 * plugins/core-secrets has neither flag, answers secrets.* with METHOD_NOT_FOUND, and commands get no secrets.
 */
internal object CoreSecretsNative : BuiltinNative {
    override fun capabilities(into: JSONObject) { into.put("secrets", true).put("secretBroker", true) }

    override fun attach(scope: BridgeScope): BridgeRoutes = object : BridgeRoutes {
        override fun handles(method: String) = method.startsWith("secrets.")
        override fun dispatch(call: BridgeCall) = SecretStore.dispatch(scope.context, call.method, call.params, call.done, call.fail)
    }

    override val commandSecrets: CommandSecrets = object : CommandSecrets {
        override fun attach(context: Context) = SecretStore.attach(context)
        override fun resolve(scope: String?, cancelled: () -> Boolean): CommandInjection =
            SecretStore.resolve(scope, cancelled).let { CommandInjection(it.values, it.locked, it.redaction) }
        override fun release(redaction: CommandRedaction?) = SecretStore.release(redaction as? Redaction)
    }

    override val activityHooks: ActivityHooks = object : ActivityHooks {
        // Fingerprint prompts for secrets (also those a Linux helper or an agent command asked for): only while in front.
        override fun created(activity: Activity, foreground: () -> Boolean, post: (Runnable) -> Unit) {
            SecretStore.promptRequester = { request, callback ->
                post(Runnable { if (foreground()) SecretPrompt.show(activity, request, callback) else callback(SecretPrompter.NOT_FOREGROUND) })
            }
        }
        override fun foreground(value: Boolean) = SecretPrompter.setForeground(value)
        // A "Unlock ... for ..." notification tap, or a request waiting for the app to come forward.
        override fun resumed() = SecretPrompter.activityResumed()
        override fun destroyed() {
            SecretPrompter.setForeground(false)
            SecretStore.promptRequester = null
            SecretPrompt.cancel()
        }
    }
}
