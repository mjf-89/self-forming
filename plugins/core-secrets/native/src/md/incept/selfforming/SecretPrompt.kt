package md.incept.selfforming

import android.app.Activity
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher

/** What the system prompt should say, and (for ask-every-time secrets) the initialised cipher it must authorise. */
internal class PromptRequest(val title: String, val subtitle: String, val cipher: Cipher? = null)

/** The system fingerprint / screen-lock prompt that authorises the time-bound secrets key, or one
 * cipher operation of the per-use key. Framework API only. */
internal object SecretPrompt {
    private var signal: CancellationSignal? = null

    /** Main thread. [callback] gets null on success, otherwise a message for the user (or one of the
     * [SecretPrompter] sentinels when the prompt was interrupted by the system). Called exactly once. */
    fun show(activity: Activity, request: PromptRequest, callback: (String?) -> Unit) {
        val finished = AtomicBoolean()
        val finish = { error: String? -> if (finished.compareAndSet(false, true)) { signal = null; callback(error) } }
        try {
            val executor = activity.mainExecutor
            val builder = BiometricPrompt.Builder(activity)
                .setTitle(request.title)
                .setSubtitle(request.subtitle)
            when {
                // A cipher operation can only be authorised by a strong biometric (no screen lock fallback).
                request.cipher != null -> {
                    if (Build.VERSION.SDK_INT >= 30) builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    builder.setNegativeButton("Cancel", executor) { _, _ -> finish("Unlock was cancelled") }
                }
                Build.VERSION.SDK_INT >= 30 -> builder.setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                @Suppress("DEPRECATION")
                Build.VERSION.SDK_INT == 29 -> builder.setDeviceCredentialAllowed(true)
                // API 28 has no screen-lock option in this prompt.
                else -> builder.setNegativeButton("Cancel", executor) { _, _ -> finish("Unlock was cancelled") }
            }
            val cancel = CancellationSignal()
            signal?.cancel()
            signal = cancel
            val callbacks = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) = finish(null)
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                    finish(when (errorCode) {
                        BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED -> "Unlock was cancelled"
                        // The system dismissed it (screen off, app left the foreground): the request may be shown again.
                        BiometricPrompt.BIOMETRIC_ERROR_CANCELED -> SecretPrompter.INTERRUPTED
                        else -> "Unlock failed: ${errString ?: "unknown error"}"
                    })
                }
                // A wrong finger is not final: the system keeps the prompt open.
            }
            val prompt = builder.build()
            if (request.cipher != null) prompt.authenticate(BiometricPrompt.CryptoObject(request.cipher), cancel, executor, callbacks)
            else prompt.authenticate(cancel, executor, callbacks)
        } catch (error: Exception) {
            finish("Unlock is not available right now")
        }
    }

    fun cancel() {
        signal?.cancel()
        signal = null
    }
}
