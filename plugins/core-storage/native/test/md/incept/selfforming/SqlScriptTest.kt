package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test

class SqlScriptTest {
    @Test fun preservesSemicolonsInValuesIdentifiersAndComments() {
        val sql = "-- ; ignored\nCREATE TABLE [a;b] (value TEXT); INSERT INTO [a;b] VALUES ('one; it''s two'); /* ; */ SELECT \"value\" FROM [a;b];"
        val parts = SqlScript.statements(sql)
        assertEquals(3, parts.size)
        assertTrue(parts[1].contains("'one; it''s two'"))
    }

    @Test fun keepsTriggerBodyAndCaseExpressionsTogether() {
        val sql = "CREATE TRIGGER sample AFTER INSERT ON t BEGIN INSERT INTO audit VALUES (CASE WHEN 1 THEN 'yes;' ELSE 'no' END); UPDATE t SET value=2; END; SELECT 1;"
        assertEquals(2, SqlScript.statements(sql).size)
        assertTrue(SqlScript.statements(sql)[0].endsWith("END"))
    }

    @Test fun discardsEmptyStatementsAndComments() {
        assertEquals(listOf("SELECT 1"), SqlScript.statements("; /* 'empty' */ ; SELECT 1; -- trailing"))
    }

    @Test fun rejectsUnterminatedInputBeforeExecutingAnyPart() {
        assertThrows(HostFailure::class.java) { SqlScript.statements("INSERT INTO t VALUES (1); SELECT 'never") }
        assertThrows(HostFailure::class.java) { SqlScript.statements("SELECT 1; /* never") }
    }
}
