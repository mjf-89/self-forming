package md.incept.selfforming

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/** Keeps the loopback callback reachable while the user signs in in their browser.
 * This service never persists an attempt and cannot restart one after process death. */
class SignInService : Service() {
    private var runningId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "ChatGPT sign-in", NotificationManager.IMPORTANCE_LOW))
            val returnToApp = PendingIntent.getActivity(this, 0,
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val notification = NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("Signing in to ChatGPT")
                .setContentText("Waiting for your browser. Tap to return to Self Forming.")
                .setContentIntent(returnToApp).setOngoing(true).setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW).build()
            ServiceCompat.startForeground(this, 1, notification,
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
            // Even a cancelled queued start must fulfil startForegroundService's
            // contract before stopping, otherwise Android can terminate the app.
            val lease = active
            if (lease == null || intent?.getStringExtra("attemptId") != lease.id) {
                stopSelf(startId)
                return START_NOT_STICKY
            }
            runningId = lease.id
            // The browser must not open until Android has promoted the service.
            lease.started = true
            lease.ready()
        } catch (_: Exception) {
            active?.let { finish(it.id, "Could not keep sign-in active. Return to the app and try again.") }
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        runningId?.let { finish(it, "Sign-in stopped. Please try again.") }
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "chatgpt-sign-in"
        private val main = Handler(Looper.getMainLooper())
        private data class Lease(val id: String, val context: Context, val ready: () -> Unit,
            val failed: (HostFailure) -> Unit, val timeout: Runnable, var started: Boolean = false)
        // Accessed only on the main thread. No URLs, codes, or credentials enter service intents.
        private var active: Lease? = null

        internal fun start(context: Context, id: String, ready: () -> Unit, failed: (HostFailure) -> Unit) {
            check(Looper.myLooper() == Looper.getMainLooper())
            if (active != null) { failed(HostFailure("AUTH_BUSY", "Another sign-in is already in progress")); return }
            val timeout = Runnable { finish(id, "Sign-in timed out; start again") }
            active = Lease(id, context.applicationContext, ready, failed, timeout)
            main.postDelayed(timeout, 5 * 60_000L)
            try {
                context.startForegroundService(Intent(context, SignInService::class.java).putExtra("attemptId", id))
            } catch (_: Exception) { finish(id, "Return to the app and start sign-in again.") }
        }

        internal fun stop(id: String) {
            if (Looper.myLooper() == Looper.getMainLooper()) finish(id, null)
            else main.post { finish(id, null) }
        }

        private fun finish(id: String, message: String?) {
            val lease = active?.takeIf { it.id == id } ?: return
            active = null
            main.removeCallbacks(lease.timeout)
            // A pending start will promote then stop itself in onStartCommand.
            // Stopping it here can leave Android's foreground promotion timer armed.
            if (lease.started) lease.context.stopService(Intent(lease.context, SignInService::class.java))
            if (message != null) lease.failed(HostFailure("AUTH_SERVICE", message))
            else if (!lease.started) lease.failed(HostFailure("AUTH_CANCELLED", "Sign-in cancelled"))
        }
    }
}
