package md.incept.selfforming

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.channels.FileChannel

/** This private namespace has no API for creating links or running processes. */
class Workspace(directory: Path) {
    val root: Path

    init {
        Files.createDirectories(directory)
        if (Files.isSymbolicLink(directory)) throw HostFailure("PATH_DENIED", "Workspace cannot be a symbolic link")
        root = directory.toRealPath()
    }

    fun resolve(relative: String): Path {
        if (relative.length > 4096 || relative.indexOf('\u0000') >= 0 || relative.contains('\\') ||
            relative.startsWith('/') || Regex("^[A-Za-z]:").containsMatchIn(relative)) {
            throw HostFailure("PATH_DENIED", "Use a relative workspace path")
        }
        val pieces = relative.split('/').filter { it.isNotEmpty() && it != "." }
        if (pieces.any { it == ".." }) throw HostFailure("PATH_DENIED", "Parent paths are not allowed")
        var path = root
        for (piece in pieces) {
            path = path.resolve(piece)
            if (Files.isSymbolicLink(path)) throw HostFailure("PATH_DENIED", "Symbolic links are not allowed")
        }
        if (!path.normalize().startsWith(root)) throw HostFailure("PATH_DENIED", "Path leaves the workspace")
        return path
    }

    fun read(relative: String): String {
        val path = resolve(relative)
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw HostFailure("NOT_FILE", "The path is not a regular workspace file")
        }
        if (Files.size(path) > MAX_TEXT_BYTES) throw HostFailure("TOO_LARGE", "Text files are limited to 1 MiB")
        Files.newByteChannel(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val buffer = ByteBuffer.allocate(MAX_TEXT_BYTES + 1)
            while (buffer.hasRemaining() && channel.read(buffer) >= 0) { /* bounded read */ }
            if (buffer.position() > MAX_TEXT_BYTES) throw HostFailure("TOO_LARGE", "Text files are limited to 1 MiB")
            buffer.flip()
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(buffer).toString()
        }
    }

    fun write(relative: String, text: String) {
        val data = text.toByteArray(StandardCharsets.UTF_8)
        if (data.size > MAX_TEXT_BYTES) throw HostFailure("TOO_LARGE", "Text files are limited to 1 MiB")
        val target = resolve(relative)
        if (target == root) throw HostFailure("NOT_FILE", "Choose a file inside the workspace")
        Files.createDirectories(target.parent)
        resolve(relative) // Recheck newly created parent components before opening.
        val temporary = Files.createTempFile(target.parent, ".pi-write-", ".tmp")
        try {
            FileChannel.open(temporary, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { channel ->
                val buffer = ByteBuffer.wrap(data)
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
            resolve(relative)
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
    }

    data class Entry(val name: String, val path: String, val directory: Boolean, val size: Long)

    fun list(relative: String): List<Entry> {
        val path = resolve(relative)
        if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) throw HostFailure("NOT_DIRECTORY", "The path is not a directory")
        return Files.newDirectoryStream(path).use { stream ->
            val result = ArrayList<Entry>()
            for (item in stream) {
                if (result.size >= 4096) throw HostFailure("TOO_LARGE", "Directory has more than 4096 entries")
                // Links are neither traversed nor offered as regular files.
                if (Files.isSymbolicLink(item)) continue
                val directory = Files.isDirectory(item, LinkOption.NOFOLLOW_LINKS)
                if (!directory && !Files.isRegularFile(item, LinkOption.NOFOLLOW_LINKS)) continue
                result.add(Entry(item.fileName.toString(), root.relativize(item).toString().replace('\\', '/'),
                    directory, if (directory) 0 else Files.size(item)))
            }
            result.sortedWith(compareByDescending<Entry> { it.directory }.thenBy { it.name })
        }
    }
}
