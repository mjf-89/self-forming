package md.incept.selfforming

import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.READ
import java.nio.file.StandardOpenOption.WRITE
import java.nio.ByteBuffer
import java.util.UUID

/** Persistent backing data for guest hard links; it must remain inside the file API namespace. */
internal object ProotLinkStore {
    @Synchronized
    fun prepare(workspace: Path): Path {
        val root = workspace.toRealPath()
        val directory = root.resolve(".pi-proot-links")
        try { Files.createDirectory(directory) } catch (_: FileAlreadyExistsException) { /* Validate below. */ }
        check(Files.isDirectory(directory, NOFOLLOW_LINKS)) { "The PRoot link store must be a real directory" }
        val canonical = directory.toRealPath()
        check(canonical == directory && canonical.parent == root) { "The PRoot link store must stay inside the workspace" }
        val ignore = canonical.resolve(".gitignore")
        check(!Files.exists(ignore, NOFOLLOW_LINKS) || Files.isRegularFile(ignore, NOFOLLOW_LINKS)) {
            "The PRoot link store ignore file must be a regular file"
        }
        // Nested rules exclude the store even when the workspace itself is a
        // repository, without changing its .gitignore or any Git configuration.
        try {
            Files.newByteChannel(ignore, setOf(CREATE_NEW, WRITE, NOFOLLOW_LINKS)).use { channel ->
                val contents = ByteBuffer.wrap("*\n".toByteArray(Charsets.UTF_8))
                while (contents.hasRemaining()) channel.write(contents)
            }
        } catch (_: FileAlreadyExistsException) { /* Never truncate rules while Git might read them. */ }
        Files.newByteChannel(ignore, setOf(READ, NOFOLLOW_LINKS)).use { channel ->
            val contents = ByteBuffer.allocate(3)
            while (contents.hasRemaining() && channel.read(contents) != -1) { }
            check(contents.position() == 2 && contents[0] == '*'.code.toByte() && contents[1] == '\n'.code.toByte()) {
                "The PRoot link store ignore file must contain its reserved rule"
            }
        }
        // PRoot's names use a process-local counter. Separate persistent leaves
        // prevent concurrent tracers from selecting the same backing filename.
        return Files.createDirectory(canonical.resolve(UUID.randomUUID().toString()))
    }
}
