package md.incept.selfforming

/**
 * Generic plugin credential records (docs/plugins-providers-agent-core.md §F.1). The auth.* bridge
 * methods auth.info/load/save/clear accept `provider: "plugin:<pluginId>:<name>"`; each such
 * credential is ONE separately encrypted AuthStore record with its own Android Keystore key
 * (alias family md.incept.selfforming.plugin.v1.*), stored under no_backup/plugin-auth/.
 * Like ChatGPT/Claude records, the value is readable by app code (trusted plugins), never by
 * agent commands. Names are composition metadata, not an access boundary between plugins.
 */
internal object PluginCredentials {
    data class Key(val pluginId: String, val name: String) {
        /** Relative to Context.noBackupFilesDir. */
        val directory: String get() = "$DIRECTORY/$pluginId/$name"
        /** Plugin ids contain no '.', so the separator is unambiguous. */
        val alias: String get() = "$ALIAS_PREFIX$pluginId.$name"
    }

    const val DIRECTORY = "plugin-auth"
    const val ALIAS_PREFIX = "md.incept.selfforming.plugin.v1."
    val METHODS = setOf("auth.info", "auth.load", "auth.save", "auth.clear")
    private val pattern = Regex("plugin:([a-z][a-z0-9-]{1,63}):([a-z0-9][a-z0-9._-]{0,63})")

    /** Null for anything that is not a well-formed plugin credential provider. */
    fun parse(provider: String): Key? = pattern.matchEntire(provider)?.let { Key(it.groupValues[1], it.groupValues[2]) }

    fun isPluginProvider(provider: String): Boolean = provider.startsWith("plugin:")
}
