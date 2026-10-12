package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

class GuestPathsTest {
    @Test fun mergedUsrAndPersistentToolSymlinksResolveInGuestNamespace() {
        val directory = Files.createTempDirectory("pi-ubuntu-paths")
        try {
            val first = Files.createDirectories(directory.resolve("ubuntu/first"))
            val second = Files.createDirectories(directory.resolve("ubuntu/second"))
            val tools = Files.createDirectories(directory.resolve("toolchains"))
            val workspace = Files.createDirectories(directory.resolve("workspace"))
            for (root in listOf(first, second)) {
                Files.createDirectories(root.resolve("usr/bin"))
                Files.createSymbolicLink(root.resolve("bin"), Paths.get("usr/bin"))
                root.resolve("usr/bin/bash").toFile().apply { writeText("dummy executable"); setExecutable(true) }
            }
            Files.createDirectories(tools.resolve("jdk-17/bin"))
            tools.resolve("jdk-17/bin/java").toFile().apply { writeText("dummy persistent executable"); setExecutable(true) }
            Files.createSymbolicLink(tools.resolve("jdk"), Paths.get("jdk-17"))
            Files.createSymbolicLink(workspace.resolve("java"), Paths.get("/opt/pi-android/jdk/bin/java"))
            Files.createSymbolicLink(workspace.resolve("loop"), Paths.get("loop"))
            val toolsAlias = Paths.get("/data/user/0/md.incept.selfforming/no_backup/toolchains")
            for (root in listOf(first, second)) {
                val paths = GuestPaths(root, listOf(Paths.get("/opt/pi-android") to tools,
                    workspace to workspace, tools to tools, toolsAlias to tools))
                assertTrue(paths.executable(Paths.get("/bin/bash")))
                assertTrue(paths.executable(Paths.get("/opt/pi-android/jdk/bin/java")))
                assertTrue(paths.executable(workspace.resolve("java")))
                assertTrue(paths.executable(tools.resolve("jdk/bin/java")))
                assertTrue(paths.executable(toolsAlias.resolve("jdk/bin/java")))
                assertFalse(paths.executable(workspace.resolve("loop")))
                assertFalse(paths.executable(Paths.get("/usr/bin/not-bundled")))
                assertEquals(tools.resolve("cache"), paths.hostPath(Paths.get("/opt/pi-android/cache")))
                assertEquals(tools.resolve("cache"), paths.hostPath(toolsAlias.resolve("cache")))
                assertEquals(root.resolve("opt/pi-android-other/cache"), paths.hostPath(Paths.get("/opt/pi-android-other/cache")))
            }
        } finally { HttpUploadDirectories.delete(directory) }
    }

    @Test fun defaultsKeepHomeAndTempButPutBuildToolsOutsideVersionedGuest() {
        val defaults = UbuntuEnvironment.defaults("/private/workspace", "/private/temp")
        assertEquals("/private/workspace", defaults["HOME"])
        assertEquals("/private/temp", defaults["TMPDIR"])
        assertTrue(defaults.getValue("PATH").startsWith("/opt/pi-android/bin:"))
        assertEquals("/opt/pi-android/jdk", defaults["JAVA_HOME"])
        assertEquals("/opt/pi-android/sdk", defaults["ANDROID_HOME"])
        assertEquals(defaults["ANDROID_HOME"], defaults["ANDROID_SDK_ROOT"])
        assertEquals("/opt/pi-android/android-user-home", defaults["ANDROID_USER_HOME"])
        assertEquals("/opt/pi-android/gradle-user-home", defaults["GRADLE_USER_HOME"])
        assertEquals("/opt/pi-android", defaults["PI_ANDROID_HOME"])
        assertEquals("/opt/pi-android/x86_64/usr/lib/x86_64-linux-gnu", defaults["BOX64_LD_LIBRARY_PATH"])
        assertEquals("0", defaults["BOX64_LOG"])
        assertEquals("1", defaults["BOX64_NOBANNER"])
        defaults["JAVA_HOME"] = "/custom/jdk"
        assertEquals("/custom/jdk", defaults["JAVA_HOME"])
    }
}
