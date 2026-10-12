package md.incept.selfforming

import android.content.Context
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Run in two separate instrumentation processes around an actual `adb install -r`. */
@RunWith(AndroidJUnit4::class)
class UpgradePersistenceTest {
    @Test fun dataAndKeystoreSurvivePackageReplacement() {
        val arguments = InstrumentationRegistry.getArguments()
        val phase = arguments.getString("upgradePhase")
        // Ordinary connected tests must neither seed nor remove the two-phase fixture.
        assumeTrue("Only the explicit upgrade-install check runs this test", phase != null)
        require(phase == "seed" || phase == "verify") { "Unknown upgrade test phase" }
        val expectedVersion = requireNotNull(arguments.getString("expectedVersionCode")?.toLongOrNull()) {
            "The upgrade test requires an expected version code"
        }
        val context = ApplicationProvider.getApplicationContext<Context>()
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        val installedVersion = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        assertEquals("The expected APK must be installed for this phase", expectedVersion, installedVersion)

        val directory = File(context.noBackupFilesDir, "upgrade-persistence-test")
        val snapshot = File(directory, "baseline.json")
        val auth = AuthStore(File(directory, "auth"), "md.incept.selfforming.test.upgrade.v1")
        val database = SqliteStore(File(directory, "databases"))
        val workspaceDirectory = File(context.filesDir, "workspace/upgrade-persistence-test")
        val workspace = Workspace(workspaceDirectory.toPath())
        try {
            if (phase == "seed") {
                assertFalse("Use a fresh emulator for the upgrade fixture", snapshot.exists())
                val hostId = auth.hostId()
                auth.save(JSONObject().put("accessToken", SYNTHETIC_TOKEN))
                workspace.write("retained.txt", WORKSPACE_TEXT)
                val handle = database.open("upgrade")
                database.exec(handle, "CREATE TABLE messages(id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT; BEGIN IMMEDIATE")
                database.run(handle, "INSERT INTO messages VALUES (?, ?)", JSONArray().put(1).put(MESSAGE_TEXT))
                database.exec(handle, "COMMIT")
                snapshot.writeText(JSONObject().put("versionCode", installedVersion).put("hostId", hostId).toString())
            } else {
                assertTrue("The baseline data must survive installation", snapshot.isFile)
                val baseline = JSONObject(snapshot.readText())
                assertTrue("The installed version must increase", installedVersion > baseline.getLong("versionCode"))
                assertTrue("The host identity must survive the update", baseline.getString("hostId") == auth.hostId())
                // The ciphertext alone is insufficient: this also proves the Android Keystore key survived.
                assertTrue("The saved credential must remain decryptable", auth.load()?.optString("accessToken") == SYNTHETIC_TOKEN)
                assertEquals("Workspace files must survive the update", WORKSPACE_TEXT, workspace.read("retained.txt"))
                val handle = database.open("upgrade")
                val rows = database.all(handle, "SELECT id, text FROM messages ORDER BY id", JSONArray())
                assertEquals("The saved database row must survive the update", 1, rows.length())
                assertEquals(1, rows.getJSONObject(0).getInt("id"))
                assertEquals(MESSAGE_TEXT, rows.getJSONObject(0).getString("text"))
                database.closeAll()
                auth.clear()
                assertTrue("Remove only this successful test's fixture", directory.deleteRecursively())
                assertTrue("Remove only this successful test's workspace", workspaceDirectory.deleteRecursively())
            }
        } finally {
            database.closeAll()
        }
    }

    companion object {
        private const val SYNTHETIC_TOKEN = "synthetic-upgrade-test-credential"
        private const val WORKSPACE_TEXT = "This workspace file belongs to the APK upgrade regression test."
        private const val MESSAGE_TEXT = "A saved conversation must remain available after updating the APK."
    }
}
