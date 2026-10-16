package md.incept.selfforming

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Called exclusively on the bridge's one SQLite worker, including open and close. */
class SqliteStore(private val directory: File) {
    private data class Database(val name: String, val path: String, val connection: SQLiteConnection)
    private val connections = HashMap<String, Database>()
    private data class Query(val handle: String, val statement: SQLiteStatement, var pending: JSONObject? = null)
    private val queries = HashMap<String, Query>()
    private val driver = BundledSQLiteDriver()
    private var owner: Thread? = null

    private fun onWorker() {
        val current = Thread.currentThread()
        if (owner == null) owner = current
        check(owner === current) { "SQLite operations must use the same worker thread" }
    }

    fun open(name: String): String {
        onWorker()
        if (!Regex("[A-Za-z0-9_-]{1,64}").matches(name)) throw HostFailure("INVALID_NAME", "Use a simple database name")
        if (connections.values.any { it.name == name }) throw HostFailure("DATABASE_BUSY", "This database already has an owner")
        if (connections.size >= 8) throw HostFailure("TOO_MANY_HANDLES", "At most eight databases can be open")
        if (!directory.isDirectory && !directory.mkdirs()) throw HostFailure("IO_ERROR", "Cannot create database directory")
        val file = File(directory, "$name.sqlite")
        val path = file.canonicalPath
        if (!owners.add(path)) throw HostFailure("DATABASE_BUSY", "This database already has an owner")
        val connection = try { driver.open(path) } catch (error: Throwable) { owners.remove(path); throw error }
        try {
            execute(connection, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF")
            val id = UUID.randomUUID().toString()
            connections[id] = Database(name, path, connection)
            return id
        } catch (error: Throwable) {
            try { connection.close() } finally { owners.remove(path) }
            throw error
        }
    }

    fun exec(handle: String, sql: String) {
        onWorker()
        execute(connection(handle), sql)
    }

    private fun execute(connection: SQLiteConnection, sql: String) {
        for (part in SqlScript.statements(sql)) {
            checkStatement(part)
            connection.prepare(part).use { statement -> while (statement.step()) { /* drain PRAGMA rows */ } }
        }
    }

    fun run(handle: String, sql: String, parameters: JSONArray) {
        onWorker()
        prepare(handle, sql, parameters).use { statement -> while (statement.step()) { /* drain RETURNING rows */ } }
    }

    fun all(handle: String, sql: String, parameters: JSONArray): JSONArray {
        onWorker()
        val result = JSONArray()
        var bytes = 2
        prepare(handle, sql, parameters).use { statement ->
            while (statement.step()) {
                val row = JSONObject()
                for (index in 0 until statement.getColumnCount()) {
                    val value: Any = when (statement.getColumnType(index)) {
                        1 -> {
                            val number = statement.getLong(index)
                            if (number in -9_007_199_254_740_991L..9_007_199_254_740_991L) number
                            else JSONObject().put("\$bigint", number.toString())
                        }
                        2 -> statement.getDouble(index).also {
                            if (!it.isFinite()) throw HostFailure("SQL_VALUE", "Non-finite SQL numbers cannot cross the bridge")
                        }
                        3 -> statement.getText(index)
                        4 -> JSONObject().put("\$bytes", Base64.getEncoder().encodeToString(statement.getBlob(index)))
                        else -> JSONObject.NULL
                    }
                    row.put(statement.getColumnName(index), value)
                }
                bytes += row.toString().toByteArray(Charsets.UTF_8).size + 1
                if (bytes > MAX_MESSAGE_BYTES - 1024) throw HostFailure("TOO_LARGE", "Query response exceeds bridge limit; page the query")
                result.put(row)
            }
        }
        return result
    }

    // Keep one statement alive across bounded replies. Image-bearing histories
    // can be much larger than the bridge's per-message limit; never rerun SQL
    // with LIMIT/OFFSET, which would break RETURNING statements and snapshots.
    fun queryOpen(handle: String, sql: String, parameters: JSONArray): JSONObject {
        onWorker()
        if (queries.size >= 16) throw HostFailure("TOO_MANY_HANDLES", "Too many open SQLite queries")
        val id = UUID.randomUUID().toString()
        queries[id] = Query(handle, prepare(handle, sql, parameters))
        return queryNext(handle, id)
    }

    fun queryNext(handle: String, id: String): JSONObject {
        onWorker()
        val query = queries[id]?.takeIf { it.handle == handle }
            ?: throw HostFailure("INVALID_HANDLE", "SQLite query is closed or belongs to another database")
        val rows = JSONArray()
        var bytes = 2
        try {
            while (rows.length() < 128) {
                val row = query.pending ?: run {
                    if (!query.statement.step()) {
                        queryClose(handle, id)
                        return JSONObject().put("rows", rows).put("cursor", JSONObject.NULL)
                    }
                    queryRow(query.statement)
                }
                val size = row.toString().toByteArray(Charsets.UTF_8).size + 1
                if (size > QUERY_PAGE_BYTES) throw HostFailure("TOO_LARGE", "A stored record exceeds the SQLite page limit")
                if (bytes + size > QUERY_PAGE_BYTES && rows.length() > 0) {
                    query.pending = row
                    break
                }
                query.pending = null
                rows.put(row)
                bytes += size
            }
            return JSONObject().put("rows", rows).put("cursor", id)
        } catch (error: Throwable) {
            queryClose(handle, id)
            throw error
        }
    }

    private fun queryRow(statement: SQLiteStatement): JSONObject = JSONObject().also { row ->
        for (index in 0 until statement.getColumnCount()) {
            val value: Any = when (statement.getColumnType(index)) {
                1 -> {
                    val number = statement.getLong(index)
                    if (number in -9_007_199_254_740_991L..9_007_199_254_740_991L) number
                    else JSONObject().put("\$bigint", number.toString())
                }
                2 -> statement.getDouble(index).also {
                    if (!it.isFinite()) throw HostFailure("SQL_VALUE", "Non-finite SQL numbers cannot cross the bridge")
                }
                3 -> statement.getText(index)
                4 -> JSONObject().put("\$bytes", Base64.getEncoder().encodeToString(statement.getBlob(index)))
                else -> JSONObject.NULL
            }
            row.put(statement.getColumnName(index), value)
        }
    }

    fun queryClose(handle: String, id: String) {
        onWorker()
        val query = queries[id] ?: return
        if (query.handle != handle) throw HostFailure("INVALID_HANDLE", "SQLite query belongs to another database")
        queries.remove(id)
        query.statement.close()
    }

    private fun prepare(handle: String, sql: String, values: JSONArray): SQLiteStatement {
        val statements = SqlScript.statements(sql)
        if (statements.size != 1) throw HostFailure("SQL_INVALID", "run/all require exactly one SQL statement")
        checkStatement(statements.single())
        val statement = connection(handle).prepare(statements.single())
        try {
            for (index in 0 until values.length()) {
                val value = values.get(index)
                val at = index + 1
                when (value) {
                    JSONObject.NULL -> statement.bindNull(at)
                    is String -> statement.bindText(at, value)
                    is Byte, is Short, is Int, is Long -> statement.bindLong(at, (value as Number).toLong())
                    is Number -> statement.bindDouble(at, value.toDouble().also {
                        if (!it.isFinite()) throw HostFailure("SQL_VALUE", "SQL numbers must be finite")
                    })
                    is JSONObject -> when {
                        value.length() == 1 && value.has("\$bytes") -> statement.bindBlob(at, Base64.getDecoder().decode(value.getString("\$bytes")))
                        value.length() == 1 && value.has("\$bigint") -> statement.bindLong(at,
                            value.getString("\$bigint").toLongOrNull() ?: throw HostFailure("SQL_VALUE", "SQLite integers must fit signed 64 bits"))
                        else -> throw HostFailure("SQL_VALUE", "Unknown SQL value tag")
                    }
                    else -> throw HostFailure("SQL_VALUE", "Unsupported SQL parameter")
                }
            }
            return statement
        } catch (error: Throwable) {
            statement.close()
            throw error
        }
    }

    private fun connection(handle: String): SQLiteConnection = connections[handle]?.connection
        ?: throw HostFailure("INVALID_HANDLE", "Database handle is closed or belongs to a previous page")

    fun close(handle: String) {
        onWorker()
        queries.filterValues { it.handle == handle }.keys.toList().forEach { queryClose(handle, it) }
        val database = connections.remove(handle) ?: throw HostFailure("INVALID_HANDLE", "Database handle is already closed")
        try { database.connection.close() } finally { owners.remove(database.path) }
    }

    fun closeAll() {
        onWorker()
        for ((id, query) in queries.toMap()) {
            try { queryClose(query.handle, id) } catch (_: Exception) { /* Continue teardown. */ }
        }
        val current = connections.values.toList()
        connections.clear()
        for (database in current) {
            try { database.connection.close() } catch (_: Exception) { /* teardown continues closing other handles */ }
            finally { owners.remove(database.path) }
        }
    }

    private fun checkStatement(sql: String) {
        // These operations could bypass sqlite.open's app-private filename boundary.
        val clean = sql.replace(Regex("(?s)/\\*.*?\\*/|--[^\\n]*"), " ").trimStart()
        if (Regex("(?i)^(ATTACH|DETACH|VACUUM)\\b").containsMatchIn(clean)) {
            throw HostFailure("SQL_DENIED", "Database file attachment and relocation are disabled")
        }
        if (Regex("(?i)^PRAGMA\\b").containsMatchIn(clean) &&
            !Regex("(?i)^PRAGMA\\s+(journal_mode|synchronous|busy_timeout|trusted_schema|wal_autocheckpoint|wal_checkpoint|user_version|foreign_keys)\\b").containsMatchIn(clean)) {
            throw HostFailure("SQL_DENIED", "Unsupported SQLite PRAGMA")
        }
    }

    companion object {
        private const val QUERY_PAGE_BYTES = 3 * 1024 * 1024
        private val owners = ConcurrentHashMap.newKeySet<String>()
    }
}
