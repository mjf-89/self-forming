package md.incept.selfforming.plugin

interface PluginModule {
    fun start(context: PluginContext)
    fun call(method: String, input: org.json.JSONObject): Any?
    fun stop()
}

/**
 * ABI is additive only: the three-argument constructor and the appContext/id/dataDir members are
 * unchanged since api 1 (0.5.x), so modules compiled against the older SDK keep loading.
 *
 * emit (host 0.6.0+, host.info capability pluginEvents) sends an event to this plugin's web
 * facet on the CURRENT page (`ctx.native.on(event, cb)`). Delivery is best effort: events are
 * dropped (and counted) while no page listens to this plugin or when the bounded queue is full;
 * they are never stored for a later page. Returns true when the event was queued for a page.
 * Event names match [A-Za-z][A-Za-z0-9._:-]{0,63}; data is at most 64 KiB as JSON
 * (IllegalArgumentException otherwise). Safe to call from any thread.
 * On an older host this method does not exist (NoSuchMethodError); modules that must also run
 * there catch it.
 */
class PluginContext(
    val appContext: android.content.Context,
    val id: String,
    val dataDir: java.io.File
) {
    private var emitter: ((String, org.json.JSONObject) -> Boolean)? = null

    /** Host-side constructor; plugins never construct their own context. */
    constructor(
        appContext: android.content.Context, id: String, dataDir: java.io.File,
        emitter: (String, org.json.JSONObject) -> Boolean
    ) : this(appContext, id, dataDir) { this.emitter = emitter }

    fun emit(event: String, data: org.json.JSONObject): Boolean {
        require(EVENT.matches(event)) { "Plugin event names match [A-Za-z][A-Za-z0-9._:-]{0,63}" }
        return emitter?.invoke(event, data) ?: false
    }

    private companion object {
        val EVENT = Regex("[A-Za-z][A-Za-z0-9._:-]{0,63}")
    }
}
