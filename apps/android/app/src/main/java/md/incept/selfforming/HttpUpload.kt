package md.incept.selfforming

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.SimpleFileVisitor
import java.nio.file.FileVisitResult
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes

/** Disk-backed upload; limits apply to bridge frames, never to the accumulated body. */
internal class HttpUpload(directory: File) : AutoCloseable {
    val file: File = File.createTempFile("upload-", ".body", directory)
    private var output: FileOutputStream? = FileOutputStream(file)
    @Synchronized fun write(bytes: ByteArray) {
        val stream = output ?: throw HostFailure("HTTP_STATE", "The HTTP upload is already closed")
        stream.write(bytes)
    }
    @Synchronized fun finish(): Long {
        output?.close()
        output = null
        return file.length()
    }
    @Synchronized override fun close() {
        try { output?.close() } finally { output = null; file.delete() }
    }
}

internal object HttpUploadDirectories {
    private val initialized = HashSet<String>()
    /** Once per process, discard only crash leftovers in our private transport directory. */
    @Synchronized fun open(root: File): File {
        val path = root.toPath().toAbsolutePath().normalize()
        if (!initialized.contains(path.toString())) {
            if (Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) delete(path)
            Files.createDirectories(path)
            initialized.add(path.toString())
        }
        return Files.createTempDirectory(path, "client-").toFile()
    }
    fun delete(path: Path) {
        // walkFileTree does not follow symbolic links outside this private directory.
        Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.deleteIfExists(file); return FileVisitResult.CONTINUE
            }
            override fun postVisitDirectory(dir: Path, error: java.io.IOException?): FileVisitResult {
                if (error != null) throw error
                Files.deleteIfExists(dir); return FileVisitResult.CONTINUE
            }
        })
    }
}
