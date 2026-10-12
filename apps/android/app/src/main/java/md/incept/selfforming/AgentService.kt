package md.incept.selfforming

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Keeps Self Forming alive while the agent replies, so the conversation keeps running when the app is
 * in the background (the WebView keeps executing; pi-durable resumes the reply if Android kills us anyway).
 * Shows an ongoing notification with Open and Stop for as long as a reply runs.
 */
class AgentService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            onStopRequested?.invoke()
            return START_NOT_STICKY
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Agent replies", NotificationManager.IMPORTANCE_LOW))
        startForeground(NOTIFICATION, notification(), if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        if (wakeLock == null) wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:agent").apply { setReferenceCounted(false); acquire(30 * 60_000L) }
        return START_NOT_STICKY
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 11, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 12, Intent(this, AgentService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentTitle("Self Forming is replying").setContentText("The agent keeps working in the background. Tap to return.")
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build()).build()
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "agent"
        private const val NOTIFICATION = 9
        private const val ACTION_STOP = "md.incept.selfforming.agent.STOP"
        /** NativeBridge: tell the page to stop the reply. */
        @Volatile var onStopRequested: (() -> Unit)? = null
        @Volatile var running = false
            private set

        fun update(context: Context, busy: Boolean) {
            if (busy == running) return
            running = busy
            val intent = Intent(context, AgentService::class.java)
            try {
                if (busy) context.startForegroundService(intent) else context.stopService(intent)
            } catch (error: Exception) {
                // Android may refuse a start from the background; the reply still continues while the process lives.
                Log.w("SFAgent", "agent service ${if (busy) "start" else "stop"} failed", error)
                if (busy) running = false
            }
        }
    }
}
