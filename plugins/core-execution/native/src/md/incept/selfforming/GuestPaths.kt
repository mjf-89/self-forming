package md.incept.selfforming

import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.Paths

/** Resolve executables through the guest's symlinks and bind mounts, never Android's /usr. */
internal class GuestPaths(private val root: Path, bindings: List<Pair<Path, Path>>) {
    private val bindings = bindings.sortedByDescending { it.first.nameCount }
    fun hostPath(guest: Path): Path {
        val path = guest.normalize()
        val bind = bindings.firstOrNull { path.startsWith(it.first) }
        return if (bind != null) bind.second.resolve(bind.first.relativize(path))
            else root.resolve(path.toString().removePrefix("/"))
    }
    fun executable(candidate: Path): Boolean {
        var guest = candidate.normalize()
        repeat(40) {
            var prefix = Paths.get("/")
            var replaced = false
            for ((index, part) in guest.withIndex()) {
                prefix = prefix.resolve(part)
                val host = hostPath(prefix)
                if (Files.isSymbolicLink(host)) {
                    val link = Files.readSymbolicLink(host)
                    val next = if (link.isAbsolute) link else prefix.parent.resolve(link)
                    guest = if (index + 1 < guest.nameCount) next.resolve(guest.subpath(index + 1, guest.nameCount)).normalize() else next.normalize()
                    replaced = true
                    break
                }
            }
            if (!replaced) return Files.isRegularFile(hostPath(guest), NOFOLLOW_LINKS) && Files.isExecutable(hostPath(guest))
        }
        return false
    }
}

internal object UbuntuEnvironment {
    const val TOOLS = "/opt/pi-android"
    fun defaults(home: String, temp: String): LinkedHashMap<String, String> = linkedMapOf(
        "PATH" to "$TOOLS/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG" to "C.UTF-8", "SHELL" to "/bin/bash", "GIT_TERMINAL_PROMPT" to "0",
        "HOME" to home, "TMPDIR" to temp,
        "JAVA_HOME" to "$TOOLS/jdk", "ANDROID_HOME" to "$TOOLS/sdk", "ANDROID_SDK_ROOT" to "$TOOLS/sdk",
        "ANDROID_USER_HOME" to "$TOOLS/android-user-home",
        "GRADLE_USER_HOME" to "$TOOLS/gradle-user-home", "PI_ANDROID_HOME" to TOOLS,
        "BOX64_LD_LIBRARY_PATH" to "$TOOLS/x86_64/usr/lib/x86_64-linux-gnu",
        "BOX64_LOG" to "0", "BOX64_NOBANNER" to "1")
}
