package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class RootfsAliasesTest {
    @Test fun aliasesShareTheirTargetAndSurviveAtomicRootActivation() {
        val directory = Files.createTempDirectory("pi-rootfs-aliases")
        try {
            val stage = Files.createDirectory(directory.resolve("installing"))
            val target = stage.resolve("usr/lib/git-core/git")
            Files.createDirectories(target.parent)
            Files.write(target, "shared executable".toByteArray())
            val alias = stage.resolve("usr/bin/git")
            RootfsAliases.install(stage, alias, target)
            assertFalse(Files.readSymbolicLink(alias).isAbsolute)
            assertTrue(Files.isSameFile(target, alias))
            Files.write(target, "updated executable".toByteArray())
            assertEquals("updated executable", String(Files.readAllBytes(alias)))
            val active = directory.resolve("active")
            Files.move(stage, active, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
            assertEquals("updated executable", String(Files.readAllBytes(active.resolve("usr/bin/git"))))
            assertTrue(Files.isSameFile(active.resolve("usr/bin/git"), active.resolve("usr/lib/git-core/git")))
        } finally { TestFiles.delete(directory) }
    }

    @Test fun aliasesRejectTargetsOutsideTheRootAndNonRegularTargets() {
        val directory = Files.createTempDirectory("pi-rootfs-alias-validation")
        try {
            val root = Files.createDirectory(directory.resolve("root"))
            val outside = Files.write(directory.resolve("outside"), byteArrayOf(1))
            val target = Files.write(root.resolve("target"), byteArrayOf(1))
            val symbolic = Files.createSymbolicLink(root.resolve("symbolic"), target.fileName)
            fun rejected(alias: java.nio.file.Path, source: java.nio.file.Path) {
                try { RootfsAliases.install(root, alias, source); fail("Invalid rootfs alias was accepted") }
                catch (_: IllegalArgumentException) { }
                catch (_: IllegalStateException) { }
            }
            rejected(root.resolve("outside-alias"), outside)
            rejected(directory.resolve("outside-alias"), target)
            rejected(root.resolve("symbolic-alias"), symbolic)
            rejected(root.resolve("directory-alias"), root)
            rejected(root.resolve("missing-alias"), root.resolve("missing"))
            rejected(target, target)
        } finally { TestFiles.delete(directory) }
    }
}
