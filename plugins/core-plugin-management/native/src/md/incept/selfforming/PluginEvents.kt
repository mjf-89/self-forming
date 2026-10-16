package md.incept.selfforming

import org.json.JSONArray
import org.json.JSONObject

/**
 * Native → page events for plugins (docs/plugins.md §7, Track B). Separate from the PiNative
 * command bridge: the fixed native-host.js validator closes PiNative on unknown events, so plugin
 * traffic uses its own WebMessage listener object, `PiPlugins` (main frame + app origin only).
 *
 * Wire (JSON strings, both directions):
 * - page → host `{"type":"listen","page":"<token>","plugins":["<id>",...]}`: the page (one
 *   document, identified by a random token) names the plugins it has listeners for. Sent again
 *   whenever that set changes. The host answers `{"type":"ready","page":...,"dropped":n}`.
 * - host → page `{"type":"event","page":...,"plugin":id,"hash":hash,"event":name,"data":{...},
 *   "seq":n,"dropped":n}`; `dropped` is the process-wide count of events not delivered so far.
 *
 * Delivery is best effort and never replayed: there is ONE current listener (the current page
 * epoch, an owner token that NativeBridge replaces on every page start); events are dropped and
 * counted while no page listens to the emitting plugin, when the bounded queue is full, or when the
 * page changed before delivery. Process-owned; trusted code, not a security boundary.
 */
internal class PluginEvents(
    private val post: (Runnable) -> Unit,
    private val maxQueue: Int = MAX_QUEUE,
    private val maxQueuedBytes: Int = MAX_QUEUED_BYTES,
) {
    private class Listener(val owner: Any, val page: String, @Volatile var plugins: Set<String>, val sink: (String) -> Boolean)
    private class Queued(val listener: Listener, val plugin: String, val text: String, val bytes: Int)

    private val lock = Any()
    private var current: Listener? = null
    private val queue = ArrayDeque<Queued>()
    private var queuedBytes = 0
    private var scheduled = false
    private var sequence = 0L
    private var unheard = 0L
    private var overflow = 0L
    private var stale = 0L
    private var delivered = 0L

    /** Main thread. Replaces the listener unless the same owner/page only changes its plugin set. */
    fun listen(owner: Any, page: String, plugins: Set<String>, sink: (String) -> Boolean) = synchronized(lock) {
        val existing = current
        if (existing != null && existing.owner === owner && existing.page == page) existing.plugins = plugins
        else current = Listener(owner, page, plugins, sink)
    }

    /** Page epoch ended (page start, renderer loss, Activity destroyed). Queued events are dropped. */
    fun detach(owner: Any) = synchronized(lock) {
        if (current?.owner === owner) current = null
        val before = queue.size
        queue.removeAll { it.listener.owner === owner }
        queuedBytes = queue.sumOf { it.bytes }
        stale += before - queue.size
    }

    /** Any thread. True when queued for the current page. */
    fun emit(plugin: String, hash: String, event: String, data: JSONObject): Boolean {
        require(EVENT.matches(event)) { "Plugin event names match [A-Za-z][A-Za-z0-9._:-]{0,63}" }
        val body = data.toString()
        require(body.toByteArray(Charsets.UTF_8).size <= MAX_DATA_BYTES) { "Plugin event data exceeds 64 KiB" }
        synchronized(lock) {
            val listener = current
            if (listener == null || plugin !in listener.plugins) { unheard++; return false }
            val text = "{\"type\":\"event\",\"page\":${JSONObject.quote(listener.page)},\"plugin\":${JSONObject.quote(plugin)}," +
                "\"hash\":${JSONObject.quote(hash)},\"event\":${JSONObject.quote(event)},\"data\":$body," +
                "\"seq\":${sequence + 1},\"dropped\":${dropped()}}"
            val bytes = text.length * 2
            if (queue.size >= maxQueue || queuedBytes + bytes > maxQueuedBytes) { overflow++; return false }
            sequence++
            queue.addLast(Queued(listener, plugin, text, bytes))
            queuedBytes += bytes
            if (!scheduled) { scheduled = true; post(Runnable { drain() }) }
            return true
        }
    }

    /** Runs on the delivering thread (Android main). Bounded batches keep the UI responsive. */
    internal fun drain() {
        var count = 0
        while (count < BATCH) {
            val item = synchronized(lock) {
                val next = queue.removeFirstOrNull()
                if (next == null) { scheduled = false; return }
                queuedBytes -= next.bytes
                next
            }
            count++
            val currentListener = synchronized(lock) { current }
            // Not delivered if the page changed or stopped listening to this plugin meanwhile.
            val ok = currentListener === item.listener && item.plugin in item.listener.plugins &&
                try { item.listener.sink(item.text) } catch (_: Exception) { false }
            synchronized(lock) { if (ok) delivered++ else stale++ }
        }
        synchronized(lock) {
            if (queue.isEmpty()) scheduled = false else post(Runnable { drain() })
        }
    }

    fun ready(page: String): String = synchronized(lock) {
        JSONObject().put("type", "ready").put("page", page).put("dropped", dropped()).toString()
    }

    fun stats(): JSONObject = synchronized(lock) {
        JSONObject().put("delivered", delivered).put("queued", queue.size).put("dropped", dropped())
            .put("unheard", unheard).put("overflow", overflow).put("stale", stale)
    }

    private fun dropped() = unheard + overflow + stale

    /** A parsed page → host listen message. */
    class Listen(val page: String, val plugins: Set<String>)

    companion object {
        const val MAX_QUEUE = 256
        const val MAX_QUEUED_BYTES = 2 * 1024 * 1024
        const val MAX_DATA_BYTES = 64 * 1024
        const val MAX_LISTEN_BYTES = 64 * 1024
        const val MAX_PLUGINS = 256
        private const val BATCH = 32
        private val EVENT = Regex("[A-Za-z][A-Za-z0-9._:-]{0,63}")
        private val PAGE = Regex("[A-Za-z0-9_-]{8,64}")
        private val ID = Regex("[a-z][a-z0-9-]{1,63}")

        /** Malformed or oversized input is ignored (null), never an exception on the UI thread. */
        fun parseListen(raw: String): Listen? = try {
            if (raw.length > MAX_LISTEN_BYTES) null else {
                val message = JSONObject(raw)
                val page = message.opt("page")
                val list = message.opt("plugins")
                if (message.opt("type") != "listen" || page !is String || !PAGE.matches(page) ||
                    list !is JSONArray || list.length() > MAX_PLUGINS) null
                else {
                    val ids = (0 until list.length()).map { list.get(it) }
                    if (ids.any { it !is String || !ID.matches(it) }) null
                    else Listen(page, ids.map { it as String }.toSet())
                }
            }
        } catch (_: Exception) { null }

        @Volatile private var instance: PluginEvents? = null
        /** Created on first use only (JVM checks construct their own instance). */
        val shared: PluginEvents get() = instance ?: synchronized(this) {
            instance ?: run {
                val main = android.os.Handler(android.os.Looper.getMainLooper())
                PluginEvents({ main.post(it) })
            }.also { instance = it }
        }
        /** Without creating the instance (reset/close before any plugin listened). */
        val existing: PluginEvents? get() = instance
    }
}
