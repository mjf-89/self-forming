package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.nio.file.Path

class WebAppStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val editable = setOf("index.html", "app.js", "app.css")
    private val immutable = setOf("native-host.js", "library/pi.js", "app-manifest.json")
    private val assets = mapOf("index.html" to "<html>original</html>", "app.js" to "export const app = 'original';",
        "app.css" to "body { color: black; }", "native-host.js" to "fixed native bridge", "library/pi.js" to "fixed upstream",
        "app-manifest.json" to "fixed manifest")

    private class Fixture(val workspace: Path, val storage: Path)
    private fun fixture() = Fixture(temporary.newFolder("workspace").toPath(), temporary.newFolder("private").toPath())
    private fun store(fixture: Fixture, version: String = "0.4.0") = WebAppStore(fixture.workspace, fixture.storage, version,
        editable, immutable) { ByteArrayInputStream(requireNotNull(assets[it]).toByteArray(Charsets.UTF_8)) }
    private fun read(store: WebAppStore, path: String, revision: String = store.info().revision) =
        requireNotNull(store.open(path, revision)).bufferedReader(Charsets.UTF_8).use { it.readText() }
    private fun edit(store: WebAppStore, path: String, text: String) {
        val target = store.source.resolve(path)
        Files.createDirectories(target.parent)
        Files.write(target, text.toByteArray(Charsets.UTF_8))
    }

    @Test fun sourcesAreSeededOnceAndUnstagedEditsNeverChangeServedCode() {
        val fixture = fixture()
        val first = store(fixture)
        assertEquals(assets["app.js"], String(Files.readAllBytes(first.source.resolve("app.js")), Charsets.UTF_8))
        edit(first, "app.js", "export const app = 'edited';")
        assertEquals(assets["app.js"], read(first, "app.js"))
        val reopened = store(fixture)
        assertEquals("export const app = 'edited';", String(Files.readAllBytes(reopened.source.resolve("app.js")), Charsets.UTF_8))
        assertEquals(assets["app.js"], read(reopened, "app.js"))
    }

    @Test fun stagedSnapshotsAndPinnedDocumentsStayStableWhenTheDraftOrSelectionChanges() {
        val store = store(fixture())
        edit(store, "app.js", "export const app = 'first';")
        edit(store, "widgets/new.js", "export const widget = true;")
        val first = store.stage()
        assertEquals(WebAppStore.ORIGINAL, store.info().revision)
        store.activate(first)
        assertTrue(store.info().pending)
        assertEquals("export const app = 'first';", read(store, "app.js"))
        assertEquals("export const widget = true;", read(store, "widgets/new.js"))
        assertEquals(assets["app.js"], read(store, "app.js", WebAppStore.ORIGINAL))
        store.ready(first)
        edit(store, "app.js", "export const app = 'second';")
        val second = store.stage()
        store.activate(second)
        assertEquals("export const app = 'first';", read(store, "app.js", first))
        assertEquals("export const app = 'second';", read(store, "app.js", second))
        assertEquals("fixed native bridge", read(store, "native-host.js"))
        assertEquals("fixed upstream", read(store, "library/pi.js"))
        assertNull(store.open("not-in-revision.js"))
    }

    @Test fun unacknowledgedRevisionRollsBackOnNextLaunchWithoutTouchingUserDataOrDraft() {
        val fixture = fixture()
        val store = store(fixture)
        Files.write(fixture.workspace.resolve("user.txt"), "important".toByteArray())
        edit(store, "app.js", "first"); val first = store.stage(); store.activate(first); store.ready(first)
        edit(store, "app.js", "broken second"); val second = store.stage(); store.activate(second)
        val relaunched = store(fixture)
        assertEquals(first, relaunched.info().revision)
        assertFalse(relaunched.info().pending)
        assertNotNull(relaunched.info().notice)
        assertEquals("first", read(relaunched, "app.js"))
        assertEquals("broken second", String(Files.readAllBytes(relaunched.source.resolve("app.js")), Charsets.UTF_8))
        assertEquals("important", String(Files.readAllBytes(fixture.workspace.resolve("user.txt")), Charsets.UTF_8))
    }

    @Test fun startupWatchdogRecoversAndAStaleAcknowledgementCannotApproveAnotherRevision() {
        val store = store(fixture())
        val revision = store.stage()
        store.activate(revision)
        assertThrows(HostFailure::class.java) { store.ready(WebAppStore.ORIGINAL) }
        assertTrue(store.info().pending)
        assertTrue(store.recoverPending())
        assertEquals(WebAppStore.ORIGINAL, store.info().revision)
        assertFalse(store.recoverPending())
        store.activate(revision)
        store.ready(revision)
        assertFalse(store.recoverPending())
    }

    @Test fun rejectsMissingFilesFixedModuleOverridesLinksAndOversizedSources() {
        val fixture = fixture()
        val store = store(fixture)
        Files.delete(store.source.resolve("app.js"))
        assertThrows(HostFailure::class.java) { store.stage() }
        edit(store, "app.js", "restored")
        edit(store, "native-host.js", "override")
        assertThrows(HostFailure::class.java) { store.stage() }
        Files.delete(store.source.resolve("native-host.js"))
        Files.write(store.source.resolve("huge.js"), ByteArray(4 * 1024 * 1024 + 1))
        assertEquals("APP_TOO_LARGE", assertThrows(HostFailure::class.java) { store.stage() }.code)
        Files.delete(store.source.resolve("huge.js"))
        try { Files.createSymbolicLink(store.source.resolve("linked.js"), store.source.resolve("app.js")) }
        catch (error: Exception) { org.junit.Assume.assumeNoException("Host cannot create symbolic links", error) }
        assertThrows(HostFailure::class.java) { store.stage() }
        assertEquals(WebAppStore.ORIGINAL, store.info().revision)
        Files.newDirectoryStream(fixture.storage.resolve("0.4.0/revisions")).use { assertFalse(it.iterator().hasNext()) }
    }

    @Test fun tamperedRevisionsAndTraversalAreRejectedBeforeSelectionChanges() {
        val fixture = fixture()
        val store = store(fixture)
        val revision = store.stage()
        Files.write(fixture.storage.resolve("0.4.0/revisions/$revision/app.js"), "tampered".toByteArray())
        assertThrows(HostFailure::class.java) { store.activate(revision) }
        assertEquals(WebAppStore.ORIGINAL, store.info().revision)
        for (path in listOf("../secret", "/secret", "library/../app.js", "safe\\bad.js", "a//b", "bad\u0000.js")) {
            assertThrows(HostFailure::class.java) { store.open(path) }
        }
        assertThrows(HostFailure::class.java) { store.activate("../../other-version") }
    }

    @Test fun hostVersionsHaveSeparateDraftsRevisionsAndSelections() {
        val fixture = fixture()
        val first = store(fixture, "0.4.0")
        edit(first, "app.js", "old host draft")
        val revision = first.stage(); first.activate(revision); first.ready(revision)
        val next = store(fixture, "0.5.0")
        assertNotEquals(first.info().sourcePath, next.info().sourcePath)
        assertEquals(WebAppStore.ORIGINAL, next.info().revision)
        assertEquals(assets["app.js"], read(next, "app.js"))
        assertThrows(HostFailure::class.java) { next.activate(revision) }
        assertEquals(revision, store(fixture, "0.4.0").info().revision)
    }

    @Test fun restoringOriginalKeepsTheEditedSourcesAndConfirmedRevisionAvailable() {
        val store = store(fixture())
        edit(store, "app.js", "edited")
        val revision = store.stage(); store.activate(revision); store.ready(revision)
        store.restore(false)
        assertEquals(WebAppStore.ORIGINAL, store.info().revision)
        assertEquals(revision, store.info().previousRevision)
        assertEquals("edited", String(Files.readAllBytes(store.source.resolve("app.js")), Charsets.UTF_8))
        store.restore(true)
        assertEquals(revision, store.info().revision)
        assertEquals("edited", read(store, "app.js"))
    }
}
