package md.incept.selfforming

import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.system.Os
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.FileVisitResult
import java.nio.file.attribute.BasicFileAttributes
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/** CI owns the distribution. Android only installs a checked payload and launches PRoot. */
internal class UbuntuRuntime(private val context: Context) {
    data class Launch(val argv: Array<String>, val environment: Array<String>)
    private val abi = Build.SUPPORTED_ABIS.firstOrNull { it == "arm64-v8a" || it == "x86_64" }
        ?: error("This APK requires arm64-v8a or x86_64")

    fun launch(command: List<String>, cwd: Path, workspace: Path, temp: Path, environment: Map<String, String>,
               background: Boolean = false, completionPath: Path? = null, completionToken: String? = null,
               secrets: Map<String, String> = emptyMap()): Launch {
        val root = install()
        val toolsAlias = File(context.noBackupFilesDir, "toolchains").toPath().toAbsolutePath().normalize()
        val tools = Files.createDirectories(toolsAlias).toRealPath()
        val runtimeTemp = Files.createDirectories(temp.resolve(".proot"))
        val sharedMemory = Files.createDirectories(runtimeTemp.resolve("shm"))
        val bindings = listOf(workspace to workspace, temp to temp,
            java.nio.file.Paths.get("/tmp") to temp, java.nio.file.Paths.get("/dev/shm") to sharedMemory,
            java.nio.file.Paths.get(UbuntuEnvironment.TOOLS) to tools, tools to tools,
            // Context paths can use /data/user/0 while real paths use /data/data.
            // Expose both names for this directory, without exposing the rest of app data.
            toolsAlias to tools).distinctBy { it.first }
        // Preserve ExecutionEnv's spawn_error contract before /usr/bin/env is started.
        val paths = GuestPaths(root, bindings)
        val candidates = if (command[0].contains('/')) listOf(cwd.resolve(command[0]))
            else environment.getValue("PATH").split(':').map { cwd.resolve(it.ifEmpty { "." }).resolve(command[0]) }
        if (candidates.none { paths.executable(it) }) throw EnvFailure("spawn_error", "Program is not executable: ${command[0]}")
        val libraries = File(context.applicationInfo.nativeLibraryDir)
        val proot = File(libraries, "libproot.so")
        val loader = File(libraries, "libproot-loader.so")
        check(proot.canExecute() && loader.canExecute()) { "The installed APK is missing its PRoot executable or loader" }
        val links = ProotLinkStore.prepare(workspace)
        // Bind the same host paths so native file APIs, shell output and old workspaces agree.
        val resolver = runtimeTemp.resolve("resolv.conf").toFile()
        synchronized(installLock) {
            val network = context.getSystemService(ConnectivityManager::class.java)
            val servers = network.activeNetwork?.let { network.getLinkProperties(it)?.dnsServers }.orEmpty()
            resolver.writeText(servers.mapNotNull { it.hostAddress }.joinToString("\n", postfix = "\n") { "nameserver $it" })
        }
        val argv = mutableListOf(proot.absolutePath)
        if (!background) argv.add("--kill-on-exit")
        argv.addAll(listOf("--link2symlink", "-0", "-r", root.toString(), "-b", "/dev", "-b", "/proc"))
        for ((guest, host) in bindings) argv.addAll(listOf("-b", "$host:$guest"))
        argv.addAll(listOf("-b", "${resolver.absolutePath}:/etc/resolv.conf", "-w", cwd.toString(), "/usr/bin/env"))
        // Secret values never go on a command line (visible in `ps` for as long as the PRoot tracer lives).
        // Without secrets the guest environment is built exactly as before (`env -i` plus KEY=VALUE).
        // With secrets they travel in PRoot's own process environment, which PRoot hands to the first guest
        // program (that inheritance is why `env -i` exists at all); `env` then unsets the host-only variables
        // below and applies the explicit guest ones, leaving the secrets in place.
        if (secrets.isEmpty()) argv.add("-i") else HOST_ONLY.forEach { argv.addAll(listOf("-u", it)) }
        argv.addAll(environment.filterKeys { it !in secrets }.map { "${it.key}=${it.value}" })
        if (background) {
            require(completionPath != null && completionToken != null)
            // The outer shell reports the foreground program's result, while PRoot continues
            // tracing background descendants. No caller command is interpolated into this script.
            // Each pipe has a binary marker so native output is drained before replying; a
            // separate atomic file carries the exit status even when descendants keep pipes open.
            argv.addAll(listOf("/bin/bash", "-c", CommandProtocol.COMPLETION_SCRIPT, "pi-exec", completionPath.toString(), completionToken))
        }
        argv.addAll(command)
        // Host and guest environments are deliberately separate. Android's LD_* and
        // PATH must never affect Ubuntu's glibc loader; callers cannot replace our loader.
        val hostEnvironment = mutableListOf(
            "PROOT_LOADER=${loader.absolutePath}", "PROOT_TMP_DIR=$runtimeTemp", "PROOT_NO_SECCOMP=1",
            "PROOT_L2S_DIR=$links",
            "PATH=/system/bin", "TMPDIR=$runtimeTemp")
        if (abi == "arm64-v8a") hostEnvironment.add("PROOT_BOX64=/usr/local/bin/box64")
        secrets.forEach { (name, value) -> hostEnvironment.add("$name=$value") }
        return Launch(argv.toTypedArray(), hostEnvironment.toTypedArray())
    }

    private object CommandProtocol {
        const val COMPLETION_SCRIPT = "p=\$1; token=\$2; shift 2; \"\$@\"; result=\$?; " +
            "printf '\\000%s\\000' \"\$token\"; printf '\\000%s\\000' \"\$token\" >&2; " +
            "printf '%s\\n' \"\$result\" > \"\$p.pending\"; /bin/mv -f \"\$p.pending\" \"\$p\"; exit \"\$result\""
    }

    fun install(): Path = synchronized(installLock) {
        val manifest = JSONObject(context.assets.open("runtime/ubuntu-$abi.json").bufferedReader().use { it.readText() })
        check(manifest.getInt("schema") == 1 && manifest.getString("abi") == abi &&
            manifest.getString("distro") == "ubuntu" && manifest.getString("release") == "24.04")
        val digest = manifest.getString("sha256")
        check(Regex("[a-f0-9]{64}").matches(digest))
        // Ubuntu is a new family. Never remove or migrate an existing modified Alpine tree.
        val base = File(context.noBackupFilesDir, "ubuntu").toPath()
        Files.createDirectories(base)
        val root = base.resolve("$abi-$digest")
        if (Files.isRegularFile(root.resolve(".complete"), NOFOLLOW_LINKS)) return@synchronized root
        val stage = base.resolve("installing-$abi")
        removeTree(stage)
        Files.createDirectory(stage)
        try {
            val entries = manifest.getJSONArray("entries")
            val files = HashMap<String, JSONObject>()
            fun target(name: String): Path {
                val path = stage.resolve(name).normalize()
                check(name.isNotEmpty() && !name.startsWith('/') && path.startsWith(stage) && path != stage) { "Invalid rootfs path" }
                return path
            }
            for (i in 0 until entries.length()) {
                val entry = entries.getJSONObject(i)
                val path = target(entry.getString("path"))
                if (entry.getString("kind") == "directory") Files.createDirectories(path)
                if (entry.getString("kind") == "file") check(files.put(entry.getString("path"), entry) == null)
            }
            val hash = MessageDigest.getInstance("SHA-256")
            context.assets.open("runtime/ubuntu-$abi.zip").use { raw ->
                DigestInputStream(raw, hash).use { checked ->
                    // Consume the entire ZIP, including its directory, before checking its digest.
                    val zip = ZipInputStream(checked)
                    var item = zip.nextEntry
                    while (item != null) {
                        val entry = files.remove(item.name) ?: error("Unexpected rootfs file")
                        val path = target(item.name)
                        Files.createDirectories(path.parent)
                        val count = Files.newOutputStream(path).use { zip.copyTo(it) }
                        check(count == entry.getLong("bytes")) { "Incomplete rootfs file" }
                        Os.chmod(path.toString(), entry.getInt("mode"))
                        zip.closeEntry()
                        item = zip.nextEntry
                    }
                    val buffer = ByteArray(8192)
                    while (checked.read(buffer) != -1) { /* Hash the remaining central directory. */ }
                }
            }
            check(files.isEmpty() && hash.digest().joinToString("") { "%02x".format(it) } == digest) { "Rootfs checksum mismatch" }
            // SELinux denies hard links in app data. Relative symbolic aliases preserve
            // command names without duplicating binaries, and survive staging activation.
            for (i in 0 until entries.length()) {
                val entry = entries.getJSONObject(i)
                if (entry.getString("kind") == "hardlink") {
                    val path = target(entry.getString("path"))
                    RootfsAliases.install(stage, path, target(entry.getString("target")))
                }
            }
            // No archive writes can follow links: all links are created after every file.
            for (i in 0 until entries.length()) {
                val entry = entries.getJSONObject(i)
                if (entry.getString("kind") == "symlink") {
                    val path = target(entry.getString("path"))
                    Files.createDirectories(path.parent)
                    Files.createSymbolicLink(path, java.nio.file.Paths.get(entry.getString("target")))
                }
            }
            // Restore directory permissions after extraction, including /tmp's sticky bit.
            for (i in 0 until entries.length()) {
                val entry = entries.getJSONObject(i)
                if (entry.getString("kind") == "directory") Os.chmod(target(entry.getString("path")).toString(), entry.getInt("mode"))
            }
            Files.write(stage.resolve(".complete"), digest.toByteArray())
            Files.move(stage, root, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
            // Downloads and installed build tools live in the separate persistent bind. Keep
            // old guest trees as well: users may have installed or edited additional packages.
            root
        } catch (error: Throwable) {
            removeTree(stage)
            throw error
        }
    }

    companion object {
        private val installLock = Any()
        /** Variables set only for the PRoot tracer; `env -u` removes them before the guest command starts. */
        private val HOST_ONLY = listOf("PROOT_LOADER", "PROOT_TMP_DIR", "PROOT_NO_SECCOMP", "PROOT_L2S_DIR", "PROOT_BOX64",
            "PATH", "TMPDIR", "LD_PRELOAD", "LD_LIBRARY_PATH")
        private fun removeTree(root: Path) {
            if (!Files.exists(root, NOFOLLOW_LINKS)) return
            Files.walkFileTree(root, object : SimpleFileVisitor<Path>() {
                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.delete(file); return FileVisitResult.CONTINUE
                }
                override fun postVisitDirectory(dir: Path, error: java.io.IOException?): FileVisitResult {
                    if (error != null) throw error
                    Files.delete(dir); return FileVisitResult.CONTINUE
                }
            })
        }
    }
}
