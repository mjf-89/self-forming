package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

class WorkspaceTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun roundTripsUtf8AndListsOnlyWorkspaceFiles() {
        val workspace = Workspace(temporary.newFolder("workspace").toPath())
        workspace.write("notes/session.txt", "A café and a cat 🐈\n")
        assertEquals("A café and a cat 🐈\n", workspace.read("notes/session.txt"))
        assertEquals(listOf("notes"), workspace.list("").map { it.path })
        assertEquals(listOf("notes/session.txt"), workspace.list("notes").map { it.path })
    }

    @Test fun rejectsEscapesAndAbsolutePaths() {
        val workspace = Workspace(temporary.newFolder("workspace").toPath())
        for (path in listOf("../secret", "safe/../../secret", "/etc/passwd", "C:/secret", "safe\\..\\secret", "bad\u0000name")) {
            val error = assertThrows(HostFailure::class.java) { workspace.write(path, "not written") }
            assertEquals("PATH_DENIED", error.code)
        }
    }

    @Test fun rejectsLinksEvenWhenTheirTargetIsInsideWorkspace() {
        val workspace = Workspace(temporary.newFolder("workspace").toPath())
        workspace.write("real/file.txt", "unchanged")
        try { Files.createSymbolicLink(workspace.root.resolve("link"), workspace.root.resolve("real")) }
        catch (error: Exception) { org.junit.Assume.assumeNoException("Host cannot create symbolic links", error) }
        assertThrows(HostFailure::class.java) { workspace.read("link/file.txt") }
        assertThrows(HostFailure::class.java) { workspace.write("link/file.txt", "bad") }
        assertEquals("unchanged", workspace.read("real/file.txt"))
    }

    @Test fun textLimitCountsUtf8Bytes() {
        val workspace = Workspace(temporary.newFolder("workspace").toPath())
        assertThrows(HostFailure::class.java) { workspace.write("huge.txt", "é".repeat(MAX_TEXT_BYTES / 2 + 1)) }
        assertFalse(Files.exists(workspace.root.resolve("huge.txt")))
    }
}
