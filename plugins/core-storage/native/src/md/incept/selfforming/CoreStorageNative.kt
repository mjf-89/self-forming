package md.incept.selfforming

import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * core-storage's Kotlin half (R1, step X3n): the sqlite.* bridge routes over [SqliteStore]. Same method names,
 * JSON shapes and database files as before (noBackupFilesDir/databases/<name>.sqlite, the conversation store is
 * "self-forming"). A fork without plugins/core-storage answers sqlite.* with METHOD_NOT_FOUND.
 */
internal object CoreStorageNative : BuiltinNative {
    override fun attach(scope: BridgeScope): BridgeRoutes = object : BridgeRoutes {
        private val databases = SqliteStore(File(scope.context.noBackupFilesDir, "databases"))

        override fun handles(method: String) = method.startsWith("sqlite.")

        override fun dispatch(call: BridgeCall) = call.on(DatabaseWorker.executor) {
            call.done(sqlite(call.method, call.params))
        }

        private fun sqlite(method: String, params: JSONObject): Any? = when (method) {
            "sqlite.open" -> JSONObject().put("handle", databases.open(params.getString("name"))).put("queryPaging", true)
            "sqlite.exec" -> { databases.exec(params.getString("handle"), params.getString("sql")); null }
            "sqlite.run" -> { databases.run(params.getString("handle"), params.getString("sql"), params.getJSONArray("params")); null }
            "sqlite.all" -> databases.all(params.getString("handle"), params.getString("sql"), params.getJSONArray("params"))
            "sqlite.queryOpen" -> databases.queryOpen(params.getString("handle"), params.getString("sql"), params.getJSONArray("params"))
            "sqlite.queryNext" -> databases.queryNext(params.getString("handle"), params.getString("cursor"))
            "sqlite.queryClose" -> { databases.queryClose(params.getString("handle"), params.getString("cursor")); null }
            "sqlite.close" -> { databases.close(params.getString("handle")); null }
            else -> throw HostFailure("METHOD_NOT_FOUND", "Unknown SQLite method")
        }

        /** Page recreation: admitted database work settles before the queued close. */
        override fun reset() { DatabaseWorker.executor.execute { databases.closeAll() } }
    }
}

/** Shared across Activity recreation: the old page's queued close precedes the new page's open. */
private object DatabaseWorker {
    val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "pi-sqlite") }
}
