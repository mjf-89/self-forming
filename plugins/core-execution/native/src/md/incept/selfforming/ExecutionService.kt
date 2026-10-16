package md.incept.selfforming

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.util.concurrent.Executors

/** The UI binds as a client. Started foreground ownership lasts only while commands run. */
class ExecutionService : Service() {
    private val binder = Binder()
    private var promoted = false
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        active = this
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            // Even a cancelled queued start must satisfy Android's foreground deadline.
            promote()
            if (intent?.action == STOP) {
                cancelQueued(null)
                runtime?.stopCommands()
            } else {
                val admitted = queued.values.toList()
                queued.clear()
                admitted.forEach { request -> request.launch() }
            }
            updateState()
        } catch (error: Exception) {
            val waiting = queued.values.toList(); queued.clear()
            waiting.forEach { it.fail(EnvFailure("spawn_error", "Could not keep commands active: ${error.message}")) }
            runtime?.stopCommands()
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    private fun promote() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Active commands", NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(this, NOTIFICATION, notification(),
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        promoted = true
    }

    private fun notification(): android.app.Notification {
        val open = PendingIntent.getActivity(this, 1,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 2, Intent(this, ExecutionService::class.java).setAction(STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val count = runtime?.serviceInfo()?.optInt("commands") ?: 0
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_manage).setContentTitle("Self Forming is working")
            .setContentText(if (count == 1) "One command is active. Tap to return." else "$count commands are active. Tap to return.")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_media_pause, "Stop commands", stop).build()
    }

    private fun updateState() {
        val running = runtime?.serviceInfo()?.optBoolean("running") == true || queued.isNotEmpty()
        if (running) {
            if (!promoted) return // An admitted foreground start will promote before launching.
            if (wakeLock == null) wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:execution").apply { setReferenceCounted(false) }
            if (wakeLock?.isHeld != true) wakeLock?.acquire()
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
        } else {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (promoted) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            promoted = false
            stopSelf()
        }
    }

    override fun onDestroy() {
        if (active === this) {
            active = null
            // An idle, stopped instance may be destroyed while a fresh start is queued.
            // Only a foreground instance owns running commands at this point.
            if (promoted) runtime?.stopCommands()
        }
        if (wakeLock?.isHeld == true) wakeLock?.release()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "pi-execution"
        private const val NOTIFICATION = 2
        private const val STOP = "md.incept.selfforming.STOP_EXECUTION"
        private val main = Handler(Looper.getMainLooper())
        private val stops = Executors.newSingleThreadExecutor { Thread(it, "pi-execution-stop") }
        private var active: ExecutionService? = null
        private var runtime: NativeExecutionEnv? = null
        private val clients = mutableMapOf<String, Pair<Context, ServiceConnection>>()
        private val queued = linkedMapOf<String, Pending>()
        private data class Pending(val client: String, val owner: String, val launch: () -> Unit, val fail: (Throwable) -> Unit)

        private fun environment(context: Context): NativeExecutionEnv = runtime ?: NativeExecutionEnv(
            context.applicationContext, backgroundCommands = true,
            onCommandsChanged = { main.post { active?.updateState() } },
        ).also { runtime = it }

        private fun attach(context: Context, client: String) {
            if (clients.containsKey(client)) return
            val app = context.applicationContext
            val connection = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName?, service: IBinder?) {}
                override fun onServiceDisconnected(name: ComponentName?) {}
            }
            if (!app.bindService(Intent(app, ExecutionService::class.java), connection, Context.BIND_AUTO_CREATE))
                throw EnvFailure("spawn_error", "Could not connect to execution service")
            clients[client] = app to connection
        }

        /** Direct native entry also used by focused instrumentation; every callback is document scoped. */
        fun dispatch(context: Context, client: String, method: String, params: JSONObject,
                     done: (Any?) -> Unit, fail: (Throwable) -> Unit, event: (JSONObject) -> Unit) {
            main.post {
                try {
                    attach(context, client)
                    val env = environment(context)
                    val p = JSONObject(params.toString()).put("_client", client)
                    val owner = p.optString("owner", client)
                    if (owner.isEmpty() || owner.length > 160) throw EnvFailure("invalid", "Invalid environment owner")
                    p.put("owner", owner)
                    val prefix = "$client:"
                    if (p.has("requestId")) p.put("requestId", prefix + p.getString("requestId"))
                    val namedRequest = method in setOf("env.exec", "env.exec.cancel", "env.watch", "env.watch.close")
                    if (namedRequest) p.put("id", prefix + p.getString("id"))
                    val reply: (Any?) -> Unit = { result ->
                        if (method == "env.watch" && result is JSONObject) result.put("id", result.getString("id").removePrefix(prefix))
                        done(result)
                    }
                    val events: (JSONObject) -> Unit = { value ->
                        value.put("id", value.getString("id").removePrefix(prefix)); event(value)
                    }
                    when (method) {
                        "env.service.info" -> done(info(context, owner))
                        "env.service.batterySettings" -> {
                            context.applicationContext.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            done(null)
                        }
                        "env.service.stop" -> {
                            val selected = if (params.has("owner")) owner else null
                            cancelQueued(selected)
                            env.stopCommands(selected)
                            stops.execute {
                                val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5)
                                while (env.commandCount(selected) > 0 && System.nanoTime() < deadline) Thread.sleep(20)
                                main.post { active?.updateState(); done(info(context, owner)) }
                            }
                        }
                        "env.exec.cancel" -> {
                            val cancelled = queued.remove(p.getString("id"))
                            if (cancelled != null) cancelled.fail(EnvFailure("aborted", "Command cancelled before starting"))
                            env.dispatch(method, p, reply, fail, events)
                        }
                        "env.cleanup" -> {
                            cancelQueued(owner)
                            env.dispatch(method, p, reply, fail, events)
                        }
                        "env.exec" -> {
                            if (active?.promoted == true) {
                                env.dispatch(method, p, reply, fail, events)
                            } else {
                                val id = p.getString("id")
                                if (queued.size >= 8 || queued.containsKey(id)) throw EnvFailure("spawn_error", "Too many pending commands or duplicate identifier")
                                queued[id] = Pending(client, owner, { env.dispatch(method, p, reply, fail, events) }, fail)
                                try {
                                    context.applicationContext.startForegroundService(Intent(context, ExecutionService::class.java))
                                } catch (error: Exception) {
                                    queued.remove(id)
                                    throw EnvFailure("spawn_error", "Return to Self Forming to start commands: ${error.message}")
                                }
                            }
                        }
                        else -> env.dispatch(method, p, reply, fail, events)
                    }
                } catch (error: Exception) { fail(error) }
            }
        }

        private fun info(context: Context, owner: String): JSONObject = environment(context).serviceInfo(owner)
            .put("batteryOptimizationsIgnored", context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName))

        private fun cancelQueued(owner: String?) {
            queued.entries.filter { owner == null || it.value.owner == owner }.map { it.key }.forEach { id ->
                queued.remove(id)?.fail?.invoke(EnvFailure("aborted", "Command stopped before starting"))
            }
        }

        fun detach(client: String) {
            main.post {
                queued.entries.filter { it.value.client == client }.map { it.key }.forEach { id ->
                    queued.remove(id)?.fail?.invoke(EnvFailure("aborted", "Client detached before starting"))
                }
                runtime?.detach(client)
                clients.remove(client)?.let { (context, connection) -> context.unbindService(connection) }
            }
        }
    }
}
