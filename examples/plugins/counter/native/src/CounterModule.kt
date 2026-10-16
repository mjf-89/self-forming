package plugins.counter

import md.incept.selfforming.plugin.PluginContext
import md.incept.selfforming.plugin.PluginModule
import org.json.JSONObject

/** In-memory demonstration: no permissions, files, threads or migrations. */
class CounterModule : PluginModule {
    private var value = 0L
    private var started = false

    @Synchronized
    override fun start(context: PluginContext) {
        check(!started) { "Counter already started" }
        started = true
    }

    @Synchronized
    override fun call(method: String, input: JSONObject): Any? {
        check(started) { "Counter is not started" }
        require(input.length() == 0) { "Counter methods expect an empty object" }
        return when (method) {
            "get" -> value
            "increment" -> {
                check(value < Long.MAX_VALUE) { "Counter overflow" }
                ++value
            }
            else -> throw IllegalArgumentException("Unknown counter method: $method")
        }
    }

    @Synchronized
    override fun stop() {
        started = false
    }
}
