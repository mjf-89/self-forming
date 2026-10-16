package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class ProotLinkStoreTest {
    @Test fun backingDirectoryPersistsAcrossPreparationAndStaysInsideWorkspace() {
        val root = Files.createTempDirectory("pi-proot-links")
        try {
            val directory = ProotLinkStore.prepare(root)
            Files.write(directory.resolve("retained"), byteArrayOf(42))
            val next = ProotLinkStore.prepare(root)
            assertNotEquals(directory, next)
            assertEquals(directory.parent, next.parent)
            assertEquals(root.toRealPath(), directory.parent.parent)
            assertArrayEquals(byteArrayOf(42), Files.readAllBytes(directory.resolve("retained")))
            assertArrayEquals("*\n".toByteArray(), Files.readAllBytes(directory.parent.resolve(".gitignore")))
        } finally { TestFiles.delete(root) }
    }

    @Test fun refusesSymlinksAndFilesWithoutFollowingOrReplacingThem() {
        val root = Files.createTempDirectory("pi-proot-links-invalid")
        val other = Files.createTempDirectory("pi-proot-links-outside")
        try {
            val directory = root.resolve(".pi-proot-links")
            Files.createSymbolicLink(directory, other)
            try { ProotLinkStore.prepare(root); fail("A symlink must not redirect backing files") }
            catch (_: IllegalStateException) { }
            assertTrue(Files.isSymbolicLink(directory))
            assertEquals(0, other.toFile().listFiles()!!.size)
            Files.delete(directory)
            Files.write(directory, byteArrayOf(7))
            try { ProotLinkStore.prepare(root); fail("A regular file must not be replaced") }
            catch (_: IllegalStateException) { }
            assertArrayEquals(byteArrayOf(7), Files.readAllBytes(directory))
        } finally { TestFiles.delete(root); TestFiles.delete(other) }
    }

    @Test fun refusesAnIgnoreSymlinkWithoutTouchingItsTarget() {
        val root = Files.createTempDirectory("pi-proot-links-ignore")
        try {
            val target = root.resolve(".gitignore")
            Files.write(target, "personal-rule\n".toByteArray())
            val directory = Files.createDirectory(root.resolve(".pi-proot-links"))
            Files.createSymbolicLink(directory.resolve(".gitignore"), target)
            try { ProotLinkStore.prepare(root); fail("An ignore symlink must not be followed") }
            catch (_: IllegalStateException) { }
            assertArrayEquals("personal-rule\n".toByteArray(), Files.readAllBytes(target))
        } finally { TestFiles.delete(root) }
    }
}
