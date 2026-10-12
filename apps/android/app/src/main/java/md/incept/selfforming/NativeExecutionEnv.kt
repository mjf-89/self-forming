package md.incept.selfforming

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.AccessDeniedException
import java.nio.file.DirectoryNotEmptyException
import java.nio.file.DirectoryStream
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.NotDirectoryException
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class EnvFailure(val code: String, message: String, val path: String? = null, val spillPath: String? = null) :
    Exception(message)

/** Android files and an Ubuntu/PRoot shell. Production ownership belongs to ExecutionService.
 * Filesystem APIs accept the private workspace and temporary namespace. Shell commands are trusted
 * app-UID processes: the working directory is NOT a sandbox and cannot confine arbitrary shell code.
 */
class NativeExecutionEnv(
    context: Context,
    workspaceDirectory: Path = File(context.filesDir, "workspace").toPath(),
    temporaryDirectory: Path = File(context.cacheDir, "execution").toPath(),
    private val backgroundCommands: Boolean = false,
    private val onCommandsChanged: () -> Unit = {},
) : Closeable {
    val root: Path = Files.createDirectories(workspaceDirectory).toRealPath()
    val temp: Path = Files.createDirectories(temporaryDirectory).toRealPath()
    private val runtime = UbuntuRuntime(context.applicationContext)
    init { SecretStore.attach(context) }
    private val namespace = "android:${context.packageName}:${root}"
    private val files = Executors.newSingleThreadExecutor { Thread(it, "pi-environment-files") }
    private val commands = Executors.newCachedThreadPool { Thread(it, "pi-environment-command") }
    private val clock = Executors.newScheduledThreadPool(2) { Thread(it, "pi-environment-watch") }
    private val epoch = AtomicLong()
    private val closed = AtomicBoolean()
    private val pending = ConcurrentHashMap<String, AtomicBoolean>()
    private val pendingClients = ConcurrentHashMap<String, String>()
    private val detachedClients = ConcurrentHashMap.newKeySet<String>()
    private val readers = ConcurrentHashMap<String, Handle>()
    private val running = ConcurrentHashMap<String, Command>()
    private val watchers = ConcurrentHashMap<String, Watch>()

    private interface Handle : Closeable { val owner: String; val client: String }
    private class Binary(val path: Path, val file: FileInputStream, override val owner: String, override val client: String) : Handle {
        override fun close() = file.close()
    }
    private class Writer(val channel: FileChannel, override val owner: String, override val client: String) : Handle {
        override fun close() = channel.close()
    }
    private class Directory(val path: Path, val directory: DirectoryStream<Path>, override val owner: String, override val client: String) : Handle {
        val iterator = directory.iterator()
        override fun close() = directory.close()
    }

    fun dispatch(method: String, params: JSONObject, done: (Any?) -> Unit, fail: (Throwable) -> Unit,
                 event: (JSONObject) -> Unit) {
        if (closed.get()) { fail(EnvFailure("invalid", "Execution environment is closed")); return }
        try {
            if (params.optString("_client") in detachedClients) throw EnvFailure("aborted", "Client was detached")
            when (method) {
                "env.info" -> done(JSONObject().put("id", namespace).put("cwd", root.toString())
                    .put("home", root.toString()).put("temp", temp.toString()).put("backgroundExecution", backgroundCommands))
                "env.exec" -> start(params, done, fail, event)
                "env.exec.cancel" -> { running[params.getString("id")]?.cancel("aborted"); done(null) }
                "env.cancel" -> { pending[params.getString("requestId")]?.set(true); done(null) }
                "env.watch.close" -> { watchers.remove(params.getString("id"))?.close(); done(null) }
                "env.cleanup" -> {
                    val owner = params.optString("owner")
                    running.values.filter { it.owner == owner }.forEach { it.terminate() }
                    watchers.entries.filter { it.value.owner == owner }.forEach { if (watchers.remove(it.key, it.value)) it.value.close() }
                    files.execute {
                        try {
                            readers.entries.filter { it.value.owner == owner }.forEach { if (readers.remove(it.key, it.value)) it.value.close() }
                            done(null)
                        } catch (error: Exception) { fail(fileFailure(error)) }
                    }
                }
                else -> {
                    val admitted = epoch.get()
                    val request = params.optString("requestId", UUID.randomUUID().toString())
                    val cancelled = AtomicBoolean()
                    if (pending.putIfAbsent(request, cancelled) != null) throw EnvFailure("invalid", "Duplicate filesystem request")
                    pendingClients[request] = params.optString("_client")
                    files.execute {
                        var result: Any? = null
                        try {
                            val check = {
                                if (closed.get() || epoch.get() != admitted || cancelled.get() || params.optString("_client") in detachedClients) throw EnvFailure("aborted", "Operation aborted")
                            }
                            check()
                            result = operation(method, params, event, check)
                            check()
                            done(result)
                        } catch (error: Exception) {
                            // Reset/abort may arrive while an open or watcher snapshot is in progress.
                            (result as? JSONObject)?.optString("id")?.takeIf { it.isNotEmpty() }?.let { id ->
                                try { readers.remove(id)?.close() } catch (_: Exception) {}
                                watchers.remove(id)?.close()
                            }
                            fail(fileFailure(error, params.optString("path").ifEmpty { null }))
                        }
                        finally { pending.remove(request, cancelled); pendingClients.remove(request) }
                    }
                }
            }
        } catch (error: Exception) { fail(error) }
    }

    /** Lexical paths are stable; following links is checked separately for each actual file operation. */
    private fun absolute(value: String, cwd: String = root.toString()): Path {
        if (value.indexOf('\u0000') >= 0 || value.length > 32768 || cwd.indexOf('\u0000') >= 0) throw EnvFailure("invalid", "Invalid path", value)
        val expanded = when { value == "~" -> root.toString(); value.startsWith("~/") -> root.resolve(value.substring(2)).toString(); else -> value }
        val base = Paths.get(cwd).let { if (it.isAbsolute) it else root.resolve(it) }
        val path = Paths.get(expanded).let { if (it.isAbsolute) it else base.resolve(it) }.normalize()
        if (!allowed(path)) throw EnvFailure("permission_denied", "Path is outside the private workspace and temporary directory", path.toString())
        return path
    }
    private fun allowed(path: Path) = path.startsWith(root) || path.startsWith(temp)
    private fun secure(path: Path, followFinal: Boolean = true): Path {
        // Resolve existing ancestors too: a missing leaf must not allow a symlinked parent to escape.
        var current = if (followFinal || path == root || path == temp) path else path.parent ?: path
        while (!Files.exists(current, NOFOLLOW_LINKS)) current = current.parent ?: throw EnvFailure("permission_denied", "Invalid file namespace")
        val real = current.toRealPath()
        if (!allowed(real)) throw EnvFailure("permission_denied", "Symbolic link leaves the private file namespace", path.toString())
        return path
    }
    private fun path(p: JSONObject, key: String = "path", follow: Boolean = true): Path =
        secure(absolute(p.getString(key), p.optString("cwd", root.toString())), follow)
    private fun number(p: JSONObject, key: String, positive: Boolean = false): Long {
        val value = p.getDouble(key)
        if (!value.isFinite() || value < (if (positive) 1 else 0) || value > 9007199254740991.0 || value != Math.floor(value))
            throw EnvFailure("invalid", "$key must be a ${if (positive) "positive" else "non-negative"} safe integer")
        return value.toLong()
    }
    private fun identifier(p: JSONObject): String = p.getString("id").also {
        if (it.isEmpty() || it.length > 512) throw EnvFailure("invalid", "Invalid resource identifier")
    }
    private fun add(handle: Handle): JSONObject {
        if (readers.size >= 128) { handle.close(); throw EnvFailure("invalid", "Too many open filesystem handles") }
        val id = UUID.randomUUID().toString()
        readers[id] = handle
        return JSONObject().put("id", id)
    }
    private fun bytes(p: JSONObject): ByteArray = if (p.has("data")) Base64.decode(p.getString("data"), Base64.DEFAULT)
        else p.getString("text").toByteArray(Charsets.UTF_8)
    private fun binary(data: ByteArray) = JSONObject().put("data", Base64.encodeToString(data, Base64.NO_WRAP))
    private fun info(path: Path, attrs: BasicFileAttributes): JSONObject {
        val kind = when { attrs.isSymbolicLink -> "symlink"; attrs.isDirectory -> "directory"; attrs.isRegularFile -> "file"; else -> throw EnvFailure("invalid", "Unsupported file kind", path.toString()) }
        return JSONObject().put("name", path.fileName.toString()).put("path", path.toString()).put("kind", kind)
            .put("size", attrs.size()).put("mtimeMs", attrs.lastModifiedTime().toMillis())
    }
    private fun info(path: Path) = info(path, Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS))
    private fun requireRegular(path: Path) {
        val attrs = Files.readAttributes(path, BasicFileAttributes::class.java)
        if (attrs.isDirectory) throw EnvFailure("is_directory", "Expected a regular file", path.toString())
        if (!attrs.isRegularFile) throw EnvFailure("invalid", "Expected a regular file", path.toString())
    }
    private fun prefix(p: JSONObject, key: String, fallback: String): String = p.optString(key, fallback).also {
        if (it.contains('/') || it.contains('\\') || it.indexOf('\u0000') >= 0 || it.length > 128) throw EnvFailure("invalid", "Invalid temporary file name")
    }

    private fun operation(method: String, p: JSONObject, event: (JSONObject) -> Unit, check: () -> Unit): Any? {
        val owner = p.optString("owner")
        val client = p.optString("_client")
        when (method) {
            "env.absolutePath" -> return absolute(p.getString("path"), p.optString("cwd", root.toString())).toString()
            "env.joinPath" -> {
                val parts = p.getJSONArray("parts")
                val text = (0 until parts.length()).map { parts.getString(it) }.filter { it.isNotEmpty() }.joinToString("/")
                return Paths.get(text.ifEmpty { "." }).normalize().toString().ifEmpty { "." }
            }
            "env.openBinaryReader" -> {
                val target = path(p, follow = !p.optBoolean("noFollow"))
                if (p.optBoolean("noFollow") && Files.isSymbolicLink(target)) throw EnvFailure("invalid", "Final symbolic link is not allowed", target.toString())
                val fd = Os.open(target.toString(), OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NONBLOCK or
                    (if (p.optBoolean("noFollow")) OsConstants.O_NOFOLLOW else 0), 0)
                try {
                    val stat = Os.fstat(fd)
                    if (OsConstants.S_ISDIR(stat.st_mode)) throw EnvFailure("is_directory", "Expected a regular file", target.toString())
                    if (!OsConstants.S_ISREG(stat.st_mode)) throw EnvFailure("invalid", "Expected a regular file", target.toString())
                } catch (error: Exception) { try { Os.close(fd) } catch (_: Exception) {}; throw error }
                return add(Binary(target, FileInputStream(fd), owner, client))
            }
            "env.reader.info" -> {
                val handle = readers[identifier(p)] as? Binary ?: throw EnvFailure("invalid", "Binary reader is closed")
                // fstat describes the opened inode even if its original path has since been replaced.
                val stat = Os.fstat(handle.file.fd)
                return JSONObject().put("name", handle.path.fileName.toString()).put("path", handle.path.toString())
                    .put("kind", "file").put("size", stat.st_size).put("mtimeMs", stat.st_mtime * 1000)
            }
            "env.reader.read" -> {
                val handle = readers[identifier(p)] as? Binary ?: throw EnvFailure("invalid", "Binary reader is closed")
                val offset = number(p, "offset")
                val length = number(p, "length")
                if (length > MAX_CHUNK) throw EnvFailure("invalid", "Read chunks are limited to $MAX_CHUNK bytes")
                val buffer = ByteBuffer.allocate(length.toInt())
                while (buffer.hasRemaining()) { check(); if (handle.file.channel.read(buffer, offset + buffer.position()) < 0) break }
                return binary(buffer.array().copyOf(buffer.position()))
            }
            "env.reader.close", "env.writer.close" -> { readers.remove(identifier(p))?.close(); return null }
            "env.openWriter" -> {
                val target = path(p)
                if (Files.isDirectory(target)) throw EnvFailure("is_directory", "Expected a file", target.toString())
                Files.createDirectories(target.parent); secure(target); check()
                val channel = FileChannel.open(target, StandardOpenOption.WRITE, StandardOpenOption.CREATE,
                    if (p.optBoolean("append")) StandardOpenOption.APPEND else StandardOpenOption.TRUNCATE_EXISTING)
                return add(Writer(channel, owner, client))
            }
            "env.writer.write" -> {
                val handle = readers[identifier(p)] as? Writer ?: throw EnvFailure("invalid", "Writer is closed")
                val buffer = ByteBuffer.wrap(bytes(p))
                while (buffer.hasRemaining()) { check(); handle.channel.write(buffer) }
                return null
            }
            "env.writeFile", "env.appendFile" -> {
                val target = path(p)
                if (Files.isDirectory(target)) throw EnvFailure("is_directory", "Expected a file", target.toString())
                Files.createDirectories(target.parent); secure(target); check()
                Files.write(target, bytes(p), StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                    if (method == "env.appendFile") StandardOpenOption.APPEND else StandardOpenOption.TRUNCATE_EXISTING)
                return null
            }
            "env.truncateFile" -> {
                val target = path(p); val size = number(p, "size"); requireRegular(target)
                RandomAccessFile(target.toFile(), "rw").use { it.setLength(size) }; return null
            }
            "env.flushFile" -> {
                val target = path(p); requireRegular(target)
                RandomAccessFile(target.toFile(), "rw").use { it.fd.sync() }; return null
            }
            "env.renameFile" -> {
                val source = path(p, "sourcePath", false); val destination = path(p, "destinationPath", false)
                protectRoot(source); protectRoot(destination)
                Files.move(source, destination, StandardCopyOption.REPLACE_EXISTING); return null
            }
            "env.fileInfo" -> return info(path(p, follow = false))
            "env.canonicalPath" -> return path(p).toRealPath().toString()
            "env.exists" -> return try { info(path(p, follow = false)); true } catch (_: NoSuchFileException) { false }
            "env.createDir" -> { val target = path(p); if (p.optBoolean("recursive", true)) Files.createDirectories(target) else Files.createDirectory(target); return null }
            "env.remove" -> {
                val target = path(p, follow = false); protectRoot(target)
                if (p.optBoolean("recursive")) removeTree(target, check, p.optBoolean("force"))
                else if (p.optBoolean("force")) Files.deleteIfExists(target) else Files.delete(target)
                return null
            }
            "env.createTempDir" -> return Files.createTempDirectory(temp, prefix(p, "prefix", "tmp-")).toString()
            "env.createTempFile" -> return Files.createTempFile(temp, prefix(p, "prefix", ""), prefix(p, "suffix", "")).toString()
            "env.listDir", "env.openDirReader" -> {
                val target = path(p)
                if (!Files.isDirectory(target)) {
                    if (!Files.exists(target)) throw NoSuchFileException(target.toString())
                    throw NotDirectoryException(target.toString())
                }
                val directory = Directory(target, Files.newDirectoryStream(target), owner, client)
                if (method == "env.openDirReader") return add(directory)
                directory.use {
                    val result = JSONArray()
                    while (it.iterator.hasNext()) {
                        check(); val child = it.iterator.next()
                        try { result.put(info(child)) } catch (_: NoSuchFileException) {} catch (e: EnvFailure) { if (e.code != "invalid") throw e }
                        if (result.length() > 10000) throw EnvFailure("invalid", "Directory is too large for one bridge response; use a directory reader")
                    }
                    return result
                }
            }
            "env.reader.next" -> {
                val handle = readers[identifier(p)] as? Directory ?: throw EnvFailure("invalid", "Directory reader is closed")
                val count = number(p, "maxEntries", true)
                if (count > 2048) throw EnvFailure("invalid", "Directory pages are limited to 2048 entries")
                val result = JSONArray()
                while (result.length() < count && handle.iterator.hasNext()) {
                    check(); val child = handle.iterator.next()
                    try { result.put(info(child)) } catch (_: NoSuchFileException) {} catch (e: EnvFailure) { if (e.code != "invalid") throw e }
                }
                return JSONObject().put("entries", result).put("done", !handle.iterator.hasNext())
            }
            "env.watch" -> {
                if (watchers.size >= 32) throw EnvFailure("invalid", "Too many active watchers")
                val id = identifier(p)
                val watch = Watch(id, owner, p, event)
                if (watchers.putIfAbsent(id, watch) != null) throw EnvFailure("invalid", "Duplicate watcher identifier")
                try { watch.start() } catch (error: Exception) { watchers.remove(id); watch.close(); throw error }
                return JSONObject().put("id", id).put("mode", "polling")
            }
            else -> throw EnvFailure("invalid", "Unknown environment operation: $method")
        }
    }

    private fun protectRoot(path: Path) { if (path == root || path == temp) throw EnvFailure("permission_denied", "Cannot remove or rename a namespace root", path.toString()) }
    private fun removeTree(path: Path, check: () -> Unit, force: Boolean) {
        check()
        if (Files.isDirectory(path, NOFOLLOW_LINKS)) Files.newDirectoryStream(path).use { directory ->
            directory.forEach { removeTree(it, check, force) }
        }
        check()
        if (force) Files.deleteIfExists(path) else Files.delete(path)
    }
    private fun fileFailure(error: Exception, path: String? = null): EnvFailure {
        if (error is EnvFailure) return error
        val code = when (error) {
            is NoSuchFileException -> "not_found"
            is AccessDeniedException, is SecurityException -> "permission_denied"
            is NotDirectoryException -> "not_directory"
            is InvalidPathException, is IllegalArgumentException, is FileAlreadyExistsException, is DirectoryNotEmptyException -> "invalid"
            is ErrnoException -> when (error.errno) {
                OsConstants.ENOENT -> "not_found"
                OsConstants.EACCES, OsConstants.EPERM -> "permission_denied"
                OsConstants.ENOTDIR -> "not_directory"
                OsConstants.EISDIR -> "is_directory"
                OsConstants.ELOOP, OsConstants.EINVAL, OsConstants.EBADF -> "invalid"
                else -> "unknown"
            }
            else -> "unknown"
        }
        return EnvFailure(code, error.message ?: code, path)
    }

    private inner class Watch(val id: String, val owner: String, params: JSONObject, val event: (JSONObject) -> Unit) : Closeable {
        val client = params.optString("_client")
        private val targets = params.getJSONArray("targets").let { array -> (0 until array.length()).map {
            val target = array.getJSONObject(it)
            Target(absolute(target.getString("path"), params.optString("cwd", root.toString())), target.optBoolean("recursive"), target.optJSONObject("exclude"))
        } }
        private var previous = emptyMap<String, String>()
        private var stopped = false
        private var task: ScheduledFuture<*>? = null
        @Synchronized fun start() {
            previous = snapshot()
            task = clock.scheduleWithFixedDelay({ tick() }, 150, 150, TimeUnit.MILLISECONDS)
        }
        private fun snapshot(): Map<String, String> {
            val result = LinkedHashMap<String, String>()
            for (target in targets) {
                val stack = java.util.ArrayDeque<Pair<Path, Int>>()
                stack.add(target.path to 0)
                while (stack.isNotEmpty()) {
                    val (path, depth) = stack.removeLast()
                    if (depth > 0 && target.excluded(path.fileName.toString())) continue
                    if (result.size > 20000) throw EnvFailure("invalid", "Watched tree exceeds 20,000 entries", target.path.toString())
                    try {
                        secure(path, depth == 0)
                        val attrs = if (depth == 0) Files.readAttributes(path, BasicFileAttributes::class.java)
                            else Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
                        result[path.toString()] = "${attrs.fileKey()}:${attrs.size()}:${attrs.lastModifiedTime().to(TimeUnit.NANOSECONDS)}:${attrs.isDirectory}"
                        if (attrs.isDirectory && (depth == 0 || target.recursive)) Files.newDirectoryStream(path).use { children ->
                            children.forEach { stack.add(it to depth + 1) }
                        }
                    } catch (_: NoSuchFileException) { result[path.toString()] = "missing" }
                }
            }
            return result
        }
        @Synchronized private fun tick() {
            if (stopped) return
            try {
                val next = snapshot()
                val changed = (previous.keys + next.keys).filter { previous[it] != next[it] }
                previous = next
                if (changed.isNotEmpty()) event(JSONObject().put("event", "env.watch").put("id", id)
                    .put("change", if (changed.size <= 512) JSONObject().put("paths", JSONArray(changed)) else JSONObject().put("overflow", true)))
            } catch (error: Exception) {
                val failure = fileFailure(error)
                event(JSONObject().put("event", "env.watch").put("id", id).put("change", JSONObject().put("error",
                    JSONObject().put("code", failure.code).put("message", failure.message).put("path", failure.path))))
                close(); watchers.remove(id, this)
            }
        }
        @Synchronized override fun close() { stopped = true; task?.cancel(false) }
    }
    private class Target(val path: Path, val recursive: Boolean, val exclude: JSONObject?) {
        fun excluded(name: String): Boolean {
            if (exclude?.optBoolean("hidden") == true && name.startsWith('.')) return true
            val names = exclude?.optJSONArray("names") ?: return false
            return (0 until names.length()).any { names.getString(it) == name }
        }
    }

    private fun start(p: JSONObject, done: (Any?) -> Unit, fail: (Throwable) -> Unit, event: (JSONObject) -> Unit) {
        val id = identifier(p)
        if (running.size >= 8) throw EnvFailure("spawn_error", "At most eight commands may run concurrently")
        val command = Command(id, p.optString("owner"), p, done, fail, event)
        if (running.putIfAbsent(id, command) != null) throw EnvFailure("spawn_error", "Duplicate command identifier")
        onCommandsChanged()
        // Registration is synchronous so an immediate cancellation cannot race command admission.
        commands.execute { command.run() }
    }
    private inner class Command(val id: String, val owner: String, val p: JSONObject, done: (Any?) -> Unit,
                                fail: (Throwable) -> Unit, event: (JSONObject) -> Unit) {
        val client = p.optString("_client")
        private val gate = Any()
        private var done: ((Any?) -> Unit)? = done
        private var fail: ((Throwable) -> Unit)? = fail
        private var event: ((JSONObject) -> Unit)? = event
        private var process: Process? = null
        @Volatile private var reason: String? = null
        private var terminated = false
        @Volatile var settled = false
            private set
        private var spillFile: Path? = null
        private var stagingFile: Path? = null
        private var spill: FileOutputStream? = null
        private var bytes = 0L
        private var newlines = 0L
        // Secrets injected into this command: output is redacted before it reaches JavaScript or the spill file.
        private var redaction: Redaction? = null
        private var redactors: Map<String, Redaction.Stream> = emptyMap()
        private var lockedSecrets: List<String> = emptyList()
        fun cancel(code: String) = synchronized(gate) {
            if (!settled) { if (reason == null) reason = code; terminate() }
        }
        /** Owner cleanup kills the process, without pretending its request context was aborted. */
        fun terminate() = synchronized(gate) {
            terminated = true
            process?.destroy()
        }
        private fun output(stream: String, chunk: ByteArray) = synchronized(gate) {
            if (settled) return@synchronized
            val config = p.optJSONObject("spill")
            if (config != null) {
                // Keep the prefix on disk, never in an unbounded heap buffer. The staging file is
                // retained/reported only after a threshold is exceeded; otherwise it is deleted.
                if (spill == null) {
                    stagingFile = Files.createTempFile(temp, "pi-output-", ".log")
                    spill = FileOutputStream(stagingFile!!.toFile())
                }
                bytes += chunk.size
                newlines += chunk.count { it == 10.toByte() }
                val lines = newlines + if (chunk.lastOrNull() == 10.toByte()) 0 else 1
                if (bytes > config.getDouble("afterBytes") || lines > config.getDouble("afterLines")) spillFile = stagingFile
                spill!!.write(chunk)
            }
            event?.invoke(JSONObject().put("event", "env.output").put("id", id).put("stream", stream)
                .put("data", Base64.encodeToString(chunk, Base64.NO_WRAP)))
        }
        private fun releaseCallbacks() { done = null; fail = null; event = null }
        private fun complete(exitCode: Int) = synchronized(gate) {
            if (settled) return@synchronized
            spill?.fd?.sync(); spill?.close(); spill = null
            reason?.let { throw EnvFailure(it, if (it == "timeout") "Command timed out" else "Command aborted", spillPath = spillFile?.toString()) }
            settled = true
            val callback = done
            releaseCallbacks()
            val skipped = lockedSecrets
            SecretStore.release(redaction)
            callback?.invoke(JSONObject().put("exitCode", exitCode).also { result ->
                spillFile?.let { result.put("spillPath", it.toString()) }
                if (skipped.isNotEmpty()) result.put("lockedSecrets", JSONArray(skipped))
            })
        }
        fun run() {
            var timeout: ScheduledFuture<*>? = null
            var control: Path? = null
            try {
                val cwd = absolute(p.optString("cwd", root.toString()), p.optString("baseCwd", root.toString()))
                secure(cwd)
                if (!Files.isDirectory(cwd)) throw EnvFailure("spawn_error", "Command working directory does not exist", cwd.toString())
                val command = p.get("command")
                val argv = if (command is JSONArray) (0 until command.length()).map { command.getString(it) }
                    else if (command is String) listOf("/bin/bash", "-c", command)
                    else throw EnvFailure("spawn_error", "Expected a command string or argv array")
                if (argv.isEmpty() || argv[0].isEmpty() || argv.any { it.indexOf('\u0000') >= 0 }) throw EnvFailure("spawn_error", "Invalid command arguments")
                val environment = UbuntuEnvironment.defaults(root.toString(), temp.toString())
                var secretScope: String? = null
                p.optJSONObject("env")?.let { values -> values.keys().forEach { key ->
                    val value = values.getString(key)
                    if (key.isEmpty() || key.contains('=') || key.indexOf('\u0000') >= 0 || value.indexOf('\u0000') >= 0) throw EnvFailure("spawn_error", "Invalid environment variable")
                    // The scope marker selects stored secrets; it is never exported itself.
                    if (key == SecretStore.SCOPE_VARIABLE) secretScope = value else environment[key] = value
                } }
                // Agent commands may wait up to 60 s here for a fingerprint; a cancelled command stops waiting.
                val scopeName = secretScope
                val injection = SecretStore.resolve(scopeName) { reason != null || terminated }
                // Secrets are handed to the launcher separately: they must never become command-line arguments.
                lockedSecrets = injection.locked
                redaction = injection.redaction
                redactors = injection.redaction?.let { r -> mapOf("stdout" to r.stream(), "stderr" to r.stream()) } ?: emptyMap()
                val seconds = if (p.has("timeout")) p.getDouble("timeout") else null
                if (seconds != null && (!seconds.isFinite() || seconds <= 0 || seconds > 2147483.647)) throw EnvFailure("timeout", "Timeout must be positive seconds, at most 2147483.647")
                p.optJSONObject("spill")?.let { config ->
                    for (key in listOf("afterBytes", "afterLines")) { val value = config.getDouble(key); if (!value.isFinite() || value < 0) throw EnvFailure("unknown", "Invalid spill threshold") }
                }
                val token = "pi-complete-${UUID.randomUUID()}"
                if (backgroundCommands) control = Files.createTempDirectory(temp, ".pi-command-")
                val statusPath = control?.resolve("status")
                val launch = runtime.launch(argv, cwd, root, temp, environment, backgroundCommands, statusPath, token, injection.values)
                val started = synchronized(gate) {
                    reason?.let { throw EnvFailure(it, "Command cancelled before starting") }
                    if (terminated) { complete(137); return }
                    ProcessBuilder(launch.argv.toList()).directory(cwd.toFile()).apply {
                        environment().apply {
                            clear()
                            launch.environment.forEach { entry -> put(entry.substringBefore('='), entry.substringAfter('=')) }
                        }
                    }.start().also { process = it }
                }
                started.outputStream.close()
                if (seconds != null) timeout = clock.schedule({ cancel("timeout") }, Math.max(1L, (seconds * 1000).toLong()), TimeUnit.MILLISECONDS)
                val drained = CountDownLatch(2)
                val marker = if (backgroundCommands) byteArrayOf(0) + token.toByteArray(Charsets.US_ASCII) + byteArrayOf(0) else null
                val stdout = commands.submit { pump(started.inputStream, "stdout", marker, drained) }
                val stderr = commands.submit { pump(started.errorStream, "stderr", marker, drained) }
                var foregroundExit: Int? = null
                if (statusPath != null) {
                    while (true) {
                        if (Files.isRegularFile(statusPath, NOFOLLOW_LINKS)) {
                            if (Files.size(statusPath) > 16) throw EnvFailure("unknown", "Invalid command completion")
                            val value = String(Files.readAllBytes(statusPath), Charsets.US_ASCII).trim().toIntOrNull()
                            if (value == null || value !in 0..255) throw EnvFailure("unknown", "Invalid command completion")
                            foregroundExit = value
                            break
                        }
                        if (started.waitFor(20, TimeUnit.MILLISECONDS)) {
                            if (Files.isRegularFile(statusPath, NOFOLLOW_LINKS)) {
                                if (Files.size(statusPath) > 16) throw EnvFailure("unknown", "Invalid command completion")
                                val value = String(Files.readAllBytes(statusPath), Charsets.US_ASCII).trim().toIntOrNull()
                                if (value == null || value !in 0..255) throw EnvFailure("unknown", "Invalid command completion")
                                foregroundExit = value
                            }
                            break
                        }
                    }
                }
                if (foregroundExit != null) {
                    // Markers precede the atomic status file. Wait for the two pumps to deliver
                    // every preceding byte, never for descendant-held pipes to reach EOF.
                    if (!drained.await(10, TimeUnit.SECONDS)) throw EnvFailure("unknown", "Command output did not settle")
                    complete(foregroundExit)
                    timeout?.cancel(false); timeout = null
                    onCommandsChanged()
                }
                val exitCode = started.waitFor()
                stdout.get(); stderr.get()
                synchronized(gate) { process = null }
                complete(exitCode)
            } catch (error: Throwable) {
                synchronized(gate) {
                    process?.destroy(); process = null
                    try { spill?.close() } catch (_: Exception) {}
                    if (!settled) {
                        settled = true
                        val actual = reason ?: if (error is EnvFailure) error.code else "spawn_error"
                        val callback = fail
                        releaseCallbacks()
                        callback?.invoke(EnvFailure(actual, error.message ?: actual, spillPath = spillFile?.toString()))
                    }
                }
            } finally {
                timeout?.cancel(false); running.remove(id, this)
                SecretStore.release(redaction)
                if (spillFile == null) try { stagingFile?.let { Files.deleteIfExists(it) } } catch (_: Exception) {}
                control?.let { directory -> try {
                    Files.deleteIfExists(directory.resolve("status")); Files.deleteIfExists(directory.resolve("status.pending")); Files.deleteIfExists(directory)
                } catch (_: Exception) {} }
                onCommandsChanged()
            }
        }
        private fun pump(input: InputStream, stream: String, marker: ByteArray?, drained: CountDownLatch) {
            var reported = false
            val redactor = redactors[stream]
            // Redact before the bytes reach the spill file or the page; a value split across reads is held back.
            val emit = { bytes: ByteArray -> val safe = redactor?.process(bytes) ?: bytes; if (safe.isNotEmpty()) output(stream, safe) }
            val release = { redactor?.flush()?.let { rest -> if (rest.isNotEmpty()) output(stream, rest) }; Unit }
            val parser = marker?.let { CommandOutput(it) { bytes -> emit(bytes) } }
            try {
                input.use {
                    val buffer = ByteArray(16384)
                    while (true) {
                        val count = it.read(buffer)
                        if (count < 0) break
                        if (count > 0) {
                            if (parser == null) emit(buffer.copyOf(count)) else parser.write(buffer.copyOf(count))
                            if (!reported && parser?.completed == true) { reported = true; release(); drained.countDown() }
                        }
                    }
                }
            } catch (error: Exception) {
                // Process.destroy() may close streams while a pump reads.
                if (!synchronized(gate) { terminated || reason != null }) {
                    if (settled) terminate() else cancel("unknown")
                    throw error
                }
            } finally {
                try { parser?.finish(); release() } finally { if (!reported) drained.countDown() }
            }
        }
    }

    fun serviceInfo(owner: String = ""): JSONObject {
        val active = running.values.toList()
        return JSONObject().put("supported", backgroundCommands).put("running", active.isNotEmpty())
            .put("commands", active.size).put("backgroundCommands", active.count { it.settled }).put("owner", owner)
    }

    fun stopCommands(owner: String? = null) {
        running.values.filter { owner == null || it.owner == owner }.forEach { it.terminate() }
    }

    fun commandCount(owner: String? = null): Int = running.values.count { owner == null || it.owner == owner }

    /** A document is a client, not the owner of a completed background launch. */
    fun detach(client: String) {
        detachedClients.add(client)
        pendingClients.filterValues { it == client }.keys.forEach { pending[it]?.set(true) }
        running.values.filter { it.client == client && !it.settled }.forEach { it.cancel("aborted") }
        watchers.entries.filter { it.value.client == client }.forEach { if (watchers.remove(it.key, it.value)) it.value.close() }
        if (!closed.get()) files.execute {
            readers.entries.filter { it.value.client == client }.forEach { if (readers.remove(it.key, it.value)) try { it.value.close() } catch (_: Exception) {} }
        }
    }

    fun reset() {
        epoch.incrementAndGet()
        pending.values.forEach { it.set(true) }
        running.values.forEach { it.cancel("aborted"); it.terminate() }
        watchers.values.forEach { it.close() }; watchers.clear()
        files.execute { readers.values.forEach { try { it.close() } catch (_: Exception) {} }; readers.clear() }
    }
    override fun close() {
        if (closed.compareAndSet(false, true)) {
            reset(); files.shutdown(); commands.shutdown(); clock.shutdown()
        }
    }
    companion object { const val MAX_CHUNK = 512 * 1024 }
}
