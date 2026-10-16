package md.incept.selfforming

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID

/** Editable sources and served revisions have different roots. No request ever serves the draft.
 * Pure JVM code so staging, activation and recovery can be tested without a running WebView.
 */
class WebAppStore(
    workspace: Path,
    privateDirectory: Path,
    val hostVersion: String,
    editableFiles: Set<String>,
    immutableFiles: Set<String>,
    private val bundled: (String) -> InputStream,
) {
    data class Info(val sourcePath: String, val revision: String, val previousRevision: String?,
                    val hostVersion: String, val notice: String?, val pending: Boolean)
    private data class State(val active: String = ORIGINAL, val previous: String? = null,
                             val pending: Boolean = false, val notice: String? = null)
    private val editable = editableFiles.toSet()
    private val immutable = immutableFiles.toSet()
    // Every revision must contain only the minimal host files (docs/plugins-providers-agent-core.md §J, L2): the
    // page entry points and the plugin bootstrap. Other editable files may move or disappear between revisions.
    private val required = editable.intersect(HOST_FILES)
    private val root: Path
    val source: Path
    private var state: State
    private var selectedFiles: Set<String> = emptySet()

    init {
        if (!hostVersion.matches(Regex("[A-Za-z0-9._-]{1,80}"))) throw HostFailure("APP_INVALID", "Invalid host version")
        if (!editable.contains("index.html") || editable.isEmpty() || editable.intersect(immutable).isNotEmpty())
            throw HostFailure("APP_INVALID", "Invalid editable application manifest")
        (editable + immutable).forEach { relative(it) }
        if (editable.any { locked(it) }) throw HostFailure("APP_INVALID", "Manifest attempts to edit a fixed host module")
        val workspaceRoot = Files.createDirectories(workspace).toRealPath()
        val privateRoot = Files.createDirectories(privateDirectory).toRealPath()
        root = directory(privateRoot, hostVersion)
        source = directory(workspaceRoot, ".self-forming/app/$hostVersion")
        directory(root, "revisions")
        seed()
        state = readState()
        if (state.pending) {
            val fallback = state.previous?.takeIf { validRevision(it) } ?: ORIGINAL
            state = State(fallback, if (fallback != ORIGINAL) ORIGINAL else null, false,
                "The edited app did not finish starting. The previous working app was restored.")
            writeState()
        } else if (!validRevision(state.active)) {
            state = State(notice = "The saved app revision was unavailable. The original app was restored.")
            writeState()
        }
        selectedFiles = if (state.active == ORIGINAL) emptySet() else revisionFiles(state.active)
    }

    @Synchronized fun info() = Info(source.toString(), state.active, state.previous, hostVersion, state.notice, state.pending)

    /** Copy every editable file into a complete private snapshot before publishing its revision id. */
    @Synchronized fun stage(): String {
        val revision = "r-${UUID.randomUUID()}"
        val staging = directory(root, "revisions/.stage-$revision")
        try {
            val files = collectSource()
            val records = Properties().apply { setProperty("hostVersion", hostVersion); setProperty("count", files.size.toString()) }
            var total = 0L
            files.sorted().forEachIndexed { index, name ->
                val input = checkedFile(source, name)
                val before = Files.readAttributes(input, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
                val bytes = readBounded(input, MAX_FILE_BYTES)
                total += bytes.size
                if (total > MAX_REVISION_BYTES) throw HostFailure("APP_TOO_LARGE", "Edited app exceeds 16 MiB")
                val after = Files.readAttributes(input, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
                if (before.fileKey() != after.fileKey() || before.size() != after.size() || before.lastModifiedTime() != after.lastModifiedTime())
                    throw HostFailure("APP_BUSY", "A source file changed while staging. Finish editing and try again.")
                val target = staging.resolve(name)
                target.parent?.let { directory(staging, staging.relativize(it).toString().replace('\\', '/')) }
                writeFile(target, bytes)
                records.setProperty("file.$index", name)
                records.setProperty("sha.$index", digest(bytes))
            }
            val html = staging.resolve("index.html")
            if (!Files.isRegularFile(html, NOFOLLOW_LINKS) || Files.size(html) == 0L)
                throw HostFailure("APP_INVALID", "The edited app must contain a nonempty index.html")
            writeProperties(staging.resolve(METADATA), records)
            Files.move(staging, root.resolve("revisions/$revision"), StandardCopyOption.ATOMIC_MOVE)
            return revision
        } catch (error: Exception) {
            removeTree(staging)
            throw error
        }
    }

    @Synchronized fun activate(revision: String): Info {
        if (state.pending) throw HostFailure("APP_NOT_READY", "Wait for the current app to start or use App recovery")
        if (revision == state.active) return info()
        val files = if (revision == ORIGINAL) emptySet() else validateRevision(revision)
        val next = State(revision, state.active, revision != ORIGINAL)
        writeState(next)
        state = next
        selectedFiles = files
        return info()
    }

    @Synchronized fun ready(revision: String): Info {
        if (revision != state.active) throw HostFailure("APP_STALE", "The startup acknowledgement belongs to another app revision")
        if (state.pending || state.notice != null) {
            val next = state.copy(pending = false, notice = null)
            writeState(next)
            state = next
        }
        return info()
    }

    @Synchronized fun restore(previous: Boolean, notice: String? = null): Info {
        val chosen = if (previous) state.previous?.takeIf { validRevision(it) }
            ?: throw HostFailure("APP_NOT_FOUND", "No previous working app revision is available") else ORIGINAL
        val known = if (!state.pending && state.active != ORIGINAL && state.active != chosen) state.active else null
        val next = State(chosen, known ?: if (chosen != ORIGINAL) ORIGINAL else null, false, notice)
        writeState(next)
        state = next
        selectedFiles = if (chosen == ORIGINAL) emptySet() else revisionFiles(chosen)
        return info()
    }

    @Synchronized fun recoverPending(): Boolean {
        if (!state.pending) return false
        val hasPrevious = state.previous?.let { validRevision(it) } == true
        restore(hasPrevious, "The edited app did not finish starting. A working app was restored.")
        return true
    }

    /** Returns only a complete selected snapshot or an immutable APK asset; never editable workspace bytes. */
    @Synchronized fun open(name: String, revision: String = state.active): InputStream? {
        relative(name)
        if (locked(name)) return if (name in immutable) bundled(name) else null
        if (revision == ORIGINAL) return if (name in editable) bundled(name) else null
        val files = if (revision == state.active) selectedFiles else revisionFiles(revision)
        if (name !in files) return null
        return ByteArrayInputStream(readBounded(checkedFile(root.resolve("revisions/$revision"), name), MAX_FILE_BYTES))
    }

    private fun seed() {
        val marker = root.resolve("draft-seeded")
        if (Files.isRegularFile(marker, NOFOLLOW_LINKS)) return
        editable.forEach { name ->
            val target = source.resolve(name)
            val parent = source.relativize(target.parent).toString().replace('\\', '/')
            directory(source, parent)
            if (!Files.exists(target, NOFOLLOW_LINKS)) {
                val bytes = bundled(name).use { readBounded(it, MAX_FILE_BYTES) }
                writeFile(target, bytes)
            } else checkedFile(source, name)
        }
        writeFile(marker, hostVersion.toByteArray(Charsets.UTF_8))
    }

    private fun collectSource(): Set<String> {
        val result = LinkedHashSet<String>()
        val pending = java.util.ArrayDeque<Path>()
        pending.add(source)
        var directories = 0
        while (pending.isNotEmpty()) {
            val current = pending.removeLast()
            if (++directories > MAX_FILES) throw HostFailure("APP_TOO_LARGE", "Edited app has too many directories")
            Files.newDirectoryStream(current).use { entries -> entries.forEach { entry ->
                if (Files.isSymbolicLink(entry)) throw HostFailure("APP_INVALID", "App source may not contain symbolic links")
                val name = source.relativize(entry).toString().replace('\\', '/')
                relative(name)
                if (locked(name)) throw HostFailure("APP_INVALID", "Fixed host modules cannot be replaced: $name")
                if (Files.isDirectory(entry, NOFOLLOW_LINKS)) pending.add(entry)
                else {
                    checkedFile(source, name)
                    result.add(name)
                    if (result.size > MAX_FILES) throw HostFailure("APP_TOO_LARGE", "Edited app has more than $MAX_FILES files")
                }
            } }
        }
        if (!result.containsAll(required)) throw HostFailure("APP_INVALID", "Required application files are missing")
        return result
    }

    private fun validRevision(revision: String): Boolean = try {
        if (revision != ORIGINAL) validateRevision(revision)
        true
    } catch (_: Exception) { false }

    private fun revisionFiles(revision: String): Set<String> {
        checkRevisionName(revision)
        val metadata = readProperties(checkedFile(root, "revisions/$revision/$METADATA"))
        if (metadata.getProperty("hostVersion") != hostVersion) throw HostFailure("APP_INCOMPATIBLE", "App revision belongs to a different host version")
        val count = metadata.getProperty("count")?.toIntOrNull() ?: 0
        if (count !in 1..MAX_FILES) throw HostFailure("APP_INVALID", "Invalid app revision manifest")
        return (0 until count).map { index ->
            val name = metadata.getProperty("file.$index") ?: throw HostFailure("APP_INVALID", "Invalid app revision entry")
            relative(name)
            if (locked(name)) throw HostFailure("APP_INVALID", "Revision overrides a fixed host module")
            name
        }.toSet().also { if (it.size != count || !it.containsAll(required)) throw HostFailure("APP_INVALID", "Incomplete app revision") }
    }

    private fun validateRevision(revision: String): Set<String> {
        val files = revisionFiles(revision)
        val base = root.resolve("revisions/$revision")
        val records = readProperties(checkedFile(base, METADATA))
        var total = 0L
        for (index in 0 until files.size) {
            val name = records.getProperty("file.$index")
            val bytes = readBounded(checkedFile(base, name), MAX_FILE_BYTES)
            total += bytes.size
            if (total > MAX_REVISION_BYTES || digest(bytes) != records.getProperty("sha.$index"))
                throw HostFailure("APP_INVALID", "App revision is incomplete or has changed")
        }
        return files
    }

    private fun readState(): State = try {
        val file = root.resolve("active.properties")
        if (!Files.exists(file, NOFOLLOW_LINKS)) State() else {
            val data = readProperties(checkedFile(root, "active.properties"))
            State(data.getProperty("active", ORIGINAL), data.getProperty("previous"), data.getProperty("pending") == "true", data.getProperty("notice"))
        }
    } catch (_: Exception) { State(notice = "App selection could not be read. The original app was restored.") }

    private fun writeState(next: State = state) {
        val data = Properties().apply {
            setProperty("active", next.active); setProperty("pending", next.pending.toString())
            next.previous?.let { setProperty("previous", it) }; next.notice?.let { setProperty("notice", it) }
        }
        val file = root.resolve(".active-${UUID.randomUUID()}")
        try {
            writeProperties(file, data)
            Files.move(file, root.resolve("active.properties"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { Files.deleteIfExists(file) }
    }

    private fun locked(name: String) = name in immutable || name == "library" || name.startsWith("library/") ||
        name == "native-host.js" || name == "app-manifest.json" || name == "app-source-README.md" || name == METADATA

    private fun checkRevisionName(revision: String) {
        if (!revision.matches(Regex("r-[a-f0-9-]{36}"))) throw HostFailure("APP_INVALID", "Invalid app revision")
    }

    companion object {
        const val ORIGINAL = "bundled"
        private const val METADATA = ".revision.properties"
        private const val MAX_FILES = 256
        private const val MAX_FILE_BYTES = 4 * 1024 * 1024
        private const val MAX_REVISION_BYTES = 16L * 1024 * 1024
        private val HOST_FILES = setOf("index.html", "app.js", "app.css", "plugin-bootstrap.js", "plugin-runtime.js", "builtin-plugins.js")

        private fun relative(name: String) {
            if (name.isEmpty() || name.length > 1024 || name.contains('\\') || name.contains('\u0000') ||
                name.startsWith('/') || name.contains(':') || name.split('/').any { it.isEmpty() || it == "." || it == ".." })
                throw HostFailure("APP_INVALID", "Invalid application path")
        }
        private fun directory(base: Path, name: String): Path {
            var current = base
            if (name.isEmpty()) return current
            relative(name)
            for (piece in name.split('/')) {
                current = current.resolve(piece)
                if (Files.isSymbolicLink(current)) throw HostFailure("APP_INVALID", "Application directories may not contain symbolic links")
                if (!Files.exists(current, NOFOLLOW_LINKS)) Files.createDirectory(current)
                if (!Files.isDirectory(current, NOFOLLOW_LINKS)) throw HostFailure("APP_INVALID", "Expected an application directory")
            }
            return current
        }
        private fun checkedFile(base: Path, name: String): Path {
            relative(name)
            var current = base
            if (Files.isSymbolicLink(base)) throw HostFailure("APP_INVALID", "Application root may not be a symbolic link")
            for (piece in name.split('/')) {
                current = current.resolve(piece)
                if (Files.isSymbolicLink(current)) throw HostFailure("APP_INVALID", "Application files may not be symbolic links")
            }
            if (!Files.isRegularFile(current, NOFOLLOW_LINKS)) throw HostFailure("APP_INVALID", "Application file is missing or not a regular file: $name")
            return current
        }
        private fun readBounded(path: Path, limit: Int): ByteArray = Files.newInputStream(path, NOFOLLOW_LINKS).use { readBounded(it, limit) }
        private fun readBounded(input: InputStream, limit: Int): ByteArray {
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(16384)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > limit) throw HostFailure("APP_TOO_LARGE", "An application file exceeds 4 MiB")
                output.write(buffer, 0, count)
            }
            return output.toByteArray()
        }
        private fun writeFile(path: Path, data: ByteArray) {
            FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, NOFOLLOW_LINKS).use { channel ->
                val buffer = ByteBuffer.wrap(data)
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
        }
        private fun writeProperties(path: Path, properties: Properties) {
            val bytes = java.io.ByteArrayOutputStream().also { properties.store(it, "Self Forming application revision") }.toByteArray()
            writeFile(path, bytes)
        }
        private fun readProperties(path: Path) = Properties().apply { load(ByteArrayInputStream(readBounded(path, MAX_FILE_BYTES))) }
        private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun removeTree(path: Path) {
            if (Files.isDirectory(path, NOFOLLOW_LINKS)) Files.newDirectoryStream(path).use { entries -> entries.forEach { removeTree(it) } }
            Files.deleteIfExists(path)
        }
    }
}
