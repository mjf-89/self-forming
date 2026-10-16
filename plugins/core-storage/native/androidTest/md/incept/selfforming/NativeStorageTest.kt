package md.incept.selfforming

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NativeStorageTest {
    @Test fun imageSizedHistoryPagesWithoutRerunningSqlAndSurvivesReopen() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val directory = File(context.cacheDir, "sqlite-pages-${UUID.randomUUID()}")
        val store = SqliteStore(directory)
        try {
            var handle = store.open("images")
            store.exec(handle, "CREATE TABLE images(id INTEGER PRIMARY KEY, data TEXT)")
            val image = "x".repeat(1200 * 1024)
            for (id in 1..5) store.run(handle, "INSERT INTO images VALUES (?, ?)", JSONArray().put(id).put(image))
            store.close(handle)
            handle = store.open("images")
            var page = store.queryOpen(handle, "SELECT * FROM images ORDER BY id", JSONArray())
            var count = 0
            var pages = 0
            while (true) {
                pages++
                assertTrue(page.toString().toByteArray(Charsets.UTF_8).size < MAX_MESSAGE_BYTES)
                val rows = page.getJSONArray("rows")
                for (index in 0 until rows.length()) {
                    val row = rows.getJSONObject(index)
                    count++
                    assertEquals(count, row.getInt("id"))
                    assertEquals(image, row.getString("data"))
                }
                if (page.isNull("cursor")) break
                page = store.queryNext(handle, page.getString("cursor"))
            }
            assertEquals(5, count)
            assertTrue(pages > 1)
            val pending = store.queryOpen(handle, "SELECT * FROM images", JSONArray()).getString("cursor")
            store.close(handle)
            assertThrows(HostFailure::class.java) { store.queryNext(handle, pending) }
        } finally {
            store.closeAll()
            directory.deleteRecursively()
        }
    }

    @Test fun bundledSqliteCommitsSurviveReopenAndUncommittedWorkRollsBack() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val directory = File(context.cacheDir, "sqlite-test-${UUID.randomUUID()}")
        val store = SqliteStore(directory)
        try {
            var handle = store.open("session")
            store.exec(handle, "CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT CHECK(json_valid(value))) STRICT; BEGIN IMMEDIATE")
            store.run(handle, "INSERT INTO probe VALUES (?, ?)", JSONArray().put(1).put("{\"saved\":true}"))
            store.exec(handle, "COMMIT; BEGIN IMMEDIATE")
            store.run(handle, "INSERT INTO probe VALUES (?, ?)", JSONArray().put(2).put("{}"))
            store.closeAll()
            handle = store.open("session")
            val rows = store.all(handle, "SELECT * FROM probe ORDER BY id", JSONArray())
            assertEquals(1, rows.length())
            assertEquals(1, rows.getJSONObject(0).getInt("id"))
            val values = store.all(handle, "SELECT ? AS big, ? AS blob", JSONArray()
                .put(JSONObject().put("\$bigint", "9223372036854775807"))
                .put(JSONObject().put("\$bytes", "AAEC/w==")))
            assertEquals("9223372036854775807", values.getJSONObject(0).getJSONObject("big").getString("\$bigint"))
            assertEquals("AAEC/w==", values.getJSONObject(0).getJSONObject("blob").getString("\$bytes"))
            assertThrows(HostFailure::class.java) { store.exec(handle, "ATTACH DATABASE '/tmp/outside' AS outside") }
        } finally {
            store.closeAll()
            directory.deleteRecursively()
        }
    }
}
