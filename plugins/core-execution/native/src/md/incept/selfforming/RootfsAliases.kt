package md.incept.selfforming

import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path

/** Android app SELinux policy denies hard links, so packaged file aliases use relative links. */
internal object RootfsAliases {
    fun install(root: Path, alias: Path, target: Path) {
        val base = root.toAbsolutePath().normalize()
        val link = alias.toAbsolutePath().normalize()
        val source = target.toAbsolutePath().normalize()
        require(link.startsWith(base) && link != base && source.startsWith(base) && source != base && link != source)
        // The installer calls this after regular-file extraction and before creating any
        // manifest symbolic links. The packager resolves hardlink chains to regular files.
        check(Files.isRegularFile(source, NOFOLLOW_LINKS)) { "Rootfs alias target must be a regular file" }
        Files.createDirectories(link.parent)
        Files.createSymbolicLink(link, link.parent.relativize(source))
    }
}
