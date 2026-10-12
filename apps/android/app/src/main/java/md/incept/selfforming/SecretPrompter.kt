package md.incept.selfforming

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import javax.crypto.Cipher

/** How a wait for the user ended. */
internal enum class Outcome {
    /** The user authenticated. */ APPROVED,
    /** The user cancelled, or authentication failed for good. */ DENIED,
    /** Nobody answered before the wait expired. */ TIMEOUT,
    /** No prompt could be shown or the key did not accept it. */ UNAVAILABLE,
    /** The caller stopped waiting (command cancelled, client disconnected). */ CANCELLED,
}

/**
 * Queues and shows the system fingerprint prompts that secrets need (one at a time), for the secret
 * broker, for agent commands and for the Settings screen.
 *  - Unlock of the 30-minute key: one shared round; every request that needs it while a round is open
 *    joins the same prompt and gets the same answer.
 *  - Ask-every-time secrets: one prompt per request and secret (the prompt authorises exactly one cipher operation).
 * With MainActivity in the foreground the prompt appears right away; otherwise a high-priority
 * notification asks the user to open the app, and the prompt appears when MainActivity is resumed.
 * Waiters that give up (timeout, cancelled command) withdraw their need; a prompt nobody waits for is dismissed.
 */
internal object SecretPrompter {
    /** MainActivity could not show the prompt because it is not in the foreground. */
    const val NOT_FOREGROUND = "\u0001not-foreground"
    /** The system dismissed the prompt (not the user): show it again when the app is back. */
    const val INTERRUPTED = "\u0001interrupted"
    private const val CHANNEL = "secret-unlock"
    private const val NOTIFICATION = 31
    private const val DEFAULT_SUBTITLE = "Protected secrets stay available for 30 minutes"

    private class Job(val unlock: Boolean, val factory: (() -> Cipher)?) {
        val names = LinkedHashSet<String>()
        val labels = LinkedHashSet<String>()
        var waiters = 0
        val done = CompletableFuture<Outcome>()
        @Volatile var cipher: Cipher? = null
    }

    private val lock = Any()
    private val queue = ArrayDeque<Job>()
    private var active: Job? = null
    private var unlockRound: Job? = null
    private var foreground = false
    private var suspended = false
    private var notified = false
    private val main = Handler(Looper.getMainLooper())
    private val workers = Executors.newCachedThreadPool { Thread(it, "pi-secrets-prompt").apply { isDaemon = true } }

    /** Run [block] off the caller's thread (the bridge calls in on the main thread). */
    fun async(block: () -> Unit) { workers.execute(block) }

    val isForeground: Boolean get() = synchronized(lock) { foreground } && SecretStore.promptRequester != null

    /** MainActivity onStart/onStop. Showing waits for [activityResumed]. */
    fun setForeground(value: Boolean) {
        synchronized(lock) { foreground = value; if (!value) suspended = false }
        if (!value) pump()
    }

    /** MainActivity is resumed or was brought forward (notification tap): show whatever is waiting. */
    fun activityResumed() {
        synchronized(lock) { suspended = false }
        pump()
    }

    // ---------------------------------------------------------------- waiting

    /** Block until the time-bound key is unlocked, the user declines or [timeoutMs] passes. */
    fun awaitUnlock(label: String?, names: Collection<String>, timeoutMs: Long, cancelled: () -> Boolean): Outcome {
        val job = synchronized(lock) {
            val round = unlockRound?.takeIf { !it.done.isDone } ?: Job(true, null).also { unlockRound = it; queue.addLast(it) }
            round.names.addAll(names)
            label?.let { round.labels.add(it) }
            round.waiters++
            round
        }
        pump()
        return wait(job, timeoutMs, cancelled)
    }

    /** Block until the user authorises one cipher operation. [factory] makes the initialised cipher
     * when the prompt is about to be shown; on [Outcome.APPROVED] the cipher is returned, ready for doFinal. */
    fun awaitAsk(label: String, name: String, timeoutMs: Long, cancelled: () -> Boolean, factory: () -> Cipher): Pair<Outcome, Cipher?> {
        val job = Job(false, factory)
        synchronized(lock) { job.names.add(name); job.labels.add(label); job.waiters = 1; queue.addLast(job) }
        pump()
        val outcome = wait(job, timeoutMs, cancelled)
        return outcome to (if (outcome == Outcome.APPROVED) job.cipher else null)
    }

    private fun wait(job: Job, timeoutMs: Long, cancelled: () -> Boolean): Outcome {
        val end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.coerceAtLeast(0))
        try {
            while (true) {
                val left = end - System.nanoTime()
                if (left <= 0) return if (job.done.isDone) job.done.get() else Outcome.TIMEOUT
                try {
                    return job.done.get(minOf(left, TimeUnit.MILLISECONDS.toNanos(200)), TimeUnit.NANOSECONDS)
                } catch (_: TimeoutException) {
                    if (cancelled()) return Outcome.CANCELLED
                }
            }
        } finally { leave(job) }
    }

    private fun leave(job: Job) {
        var abandoned = false
        synchronized(lock) {
            job.waiters--
            if (job.waiters <= 0 && !job.done.isDone) {
                abandoned = true
                queue.remove(job)
                if (unlockRound === job) unlockRound = null
                if (active === job) { active = null; main.post { SecretPrompt.cancel() } }
                job.done.complete(Outcome.CANCELLED)
            }
        }
        if (abandoned) pump()
    }

    // ---------------------------------------------------------------- showing

    private fun pump() {
        var show: Job? = null
        var remind: Job? = null
        synchronized(lock) {
            if (active != null) return
            val next = queue.firstOrNull()
            if (next == null) { cancelNotification(); return }
            if (foreground && !suspended && SecretStore.promptRequester != null) { active = queue.removeFirst(); show = active }
            else remind = next
        }
        show?.let { job -> workers.execute { present(job) } }
        remind?.let { notify(it) }
    }

    private fun present(job: Job) {
        try {
            job.cipher = job.factory?.invoke()
        } catch (_: Exception) {
            return conclude(job, Outcome.UNAVAILABLE)
        }
        val request = synchronized(lock) {
            PromptRequest("Unlock secrets", subtitle(job), job.cipher)
        }
        val requester = SecretStore.promptRequester ?: return result(job, NOT_FOREGROUND)
        cancelNotification()
        try {
            requester(request) { error -> workers.execute { result(job, error) } }
        } catch (_: Exception) {
            conclude(job, Outcome.UNAVAILABLE)
        }
    }

    private fun result(job: Job, error: String?) {
        synchronized(lock) { if (active !== job) return }
        when (error) {
            null -> conclude(job, if (job.unlock) try { SecretStore.completeUnlock(); Outcome.APPROVED } catch (_: Exception) { Outcome.UNAVAILABLE } else Outcome.APPROVED)
            NOT_FOREGROUND, INTERRUPTED -> {
                synchronized(lock) {
                    if (error == NOT_FOREGROUND) foreground = false else suspended = true
                    active = null
                    if (!job.done.isDone) queue.addFirst(job)
                }
                pump()
            }
            else -> conclude(job, Outcome.DENIED)
        }
    }

    private fun conclude(job: Job, outcome: Outcome) {
        synchronized(lock) {
            if (active === job) active = null
            queue.remove(job)
            if (unlockRound === job) unlockRound = null
            job.done.complete(outcome)
        }
        pump()
    }

    private fun subtitle(job: Job): String {
        if (job.labels.isEmpty()) return DEFAULT_SUBTITLE
        return limit("${job.labels.joinToString(" and ")} wants ${job.names.joinToString(", ")}", 140)
    }

    // ---------------------------------------------------------------- notification

    private fun notify(job: Job) {
        val context = SecretStore.appContext() ?: return
        val text = synchronized(lock) {
            if (job.labels.isEmpty()) "Unlock ${limit(job.names.joinToString(", "), 80)}"
            else "Unlock ${limit(job.names.joinToString(", "), 80)} for ${limit(job.labels.joinToString(" and "), 40)}"
        }
        try {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Secret unlock requests", NotificationManager.IMPORTANCE_HIGH))
            val open = PendingIntent.getActivity(context, 31,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra("secretUnlock", true),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            manager.notify(NOTIFICATION, android.app.Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
                .setContentTitle(text).setContentText("Tap to confirm with your fingerprint")
                .setCategory(android.app.Notification.CATEGORY_ALARM)
                .setVisibility(android.app.Notification.VISIBILITY_PRIVATE)
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).setTimeoutAfter(150_000).build())
            synchronized(lock) { notified = true }
        } catch (_: Exception) {
            // Notifications may be blocked; the request then waits until it expires.
        }
    }

    private fun cancelNotification() {
        val context = SecretStore.appContext() ?: return
        val was = synchronized(lock) { notified.also { notified = false } }
        if (was) try { context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION) } catch (_: Exception) {}
    }

    private fun limit(text: String, max: Int) = if (text.length <= max) text else text.substring(0, max - 1) + "\u2026"
}
