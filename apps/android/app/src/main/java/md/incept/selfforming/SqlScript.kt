package md.incept.selfforming

/** Split SQLite exec batches without cutting strings, comments or trigger bodies. */
object SqlScript {
    fun statements(sql: String): List<String> {
        val result = ArrayList<String>()
        val leading = ArrayList<String>()
        var start = 0
        var index = 0
        var trigger = false
        var cases = 0
        while (index < sql.length) {
            val c = sql[index]
            if (c == '-' && sql.getOrNull(index + 1) == '-') {
                index += 2
                while (index < sql.length && sql[index] != '\n') index++
            } else if (c == '/' && sql.getOrNull(index + 1) == '*') {
                val end = sql.indexOf("*/", index + 2)
                if (end < 0) throw HostFailure("SQL_INVALID", "Unterminated SQL comment")
                index = end + 2
            } else if (c == '\'' || c == '"' || c == '`' || c == '[') {
                val closing = if (c == '[') ']' else c
                index++
                var closed = false
                while (index < sql.length) {
                    if (sql[index++] != closing) continue
                    if (c != '[' && sql.getOrNull(index) == closing) { index++; continue }
                    closed = true
                    break
                }
                if (!closed) throw HostFailure("SQL_INVALID", "Unterminated SQL quotation")
            } else if (c.isLetter() || c == '_') {
                val tokenStart = index++
                while (index < sql.length && (sql[index].isLetterOrDigit() || sql[index] == '_')) index++
                val token = sql.substring(tokenStart, index).uppercase(java.util.Locale.ROOT)
                if (leading.size < 4) leading.add(token)
                if (token == "BEGIN" && leading.firstOrNull() == "CREATE" && leading.contains("TRIGGER")) trigger = true
                else if (trigger && token == "CASE") cases++
                else if (trigger && token == "END") {
                    if (cases > 0) cases-- else trigger = false
                }
            } else if (c == ';' && !trigger) {
                val part = sql.substring(start, index).trim()
                if (leading.isNotEmpty()) result.add(part)
                index++
                start = index
                leading.clear()
            } else index++
        }
        if (trigger) throw HostFailure("SQL_INVALID", "Unterminated SQL trigger")
        val tail = sql.substring(start).trim()
        if (leading.isNotEmpty()) result.add(tail)
        return result
    }
}
