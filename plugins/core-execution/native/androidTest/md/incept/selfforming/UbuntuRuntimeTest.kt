package md.incept.selfforming

import android.content.Context
import android.os.Build
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class UbuntuRuntimeTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun withEnv(test: (NativeExecutionEnv) -> Unit) {
        UbuntuRuntime(context).install()
        val base = File(context.cacheDir, "ubuntu-test-${UUID.randomUUID()}")
        NativeExecutionEnv(context, File(base, "workspace").toPath(), File(base, "temp").toPath()).use(test)
    }
    private fun run(env: NativeExecutionEnv, command: Any): Pair<Int, String> {
        val result = CompletableFuture<JSONObject>()
        val output = ByteArrayOutputStream()
        env.dispatch("env.exec", JSONObject().put("id", UUID.randomUUID().toString()).put("command", command).put("timeout", 30),
            { result.complete(it as JSONObject) }, { result.completeExceptionally(it) },
            { event -> if (event.optString("event") == "env.output") synchronized(output) {
                output.write(Base64.decode(event.getString("data"), Base64.DEFAULT))
            } })
        val response = result.get(40, TimeUnit.SECONDS)
        return response.getInt("exitCode") to output.toString("UTF-8")
    }
    private fun call(env: NativeExecutionEnv, method: String, params: JSONObject): Any? {
        val result = CompletableFuture<Any?>()
        env.dispatch(method, params, { result.complete(it) }, { result.completeExceptionally(it) }, {})
        return result.get(10, TimeUnit.SECONDS)
    }
    private fun successful(env: NativeExecutionEnv, command: Any): String {
        val (code, output) = run(env, command)
        var diagnosis = ""
        if (code != 0 && command is String && command.contains("git init")) {
            // Test-only diagnostics; no verbose tracing in the application runtime.
            val launch = UbuntuRuntime(context).launch(listOf("/bin/bash", "-c", "mkdir diagnostic; cd diagnostic; $command"),
                env.root, env.root, env.temp, mapOf("PATH" to "/usr/bin:/bin", "HOME" to env.root.toString(), "GIT_TERMINAL_PROMPT" to "0"))
            val args = launch.argv.toMutableList().apply { addAll(1, listOf("-v", "5")) }
            val trace = File(context.filesDir, "ubuntu-git-trace.log")
            val builder = ProcessBuilder(args).directory(env.root.toFile()).redirectErrorStream(true).redirectOutput(trace)
            builder.environment().apply {
                clear()
                launch.environment.forEach { entry -> put(entry.substringBefore('='), entry.substringAfter('=')) }
            }
            val process = builder.start()
            process.outputStream.close()
            if (!process.waitFor(20, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                process.waitFor(5, TimeUnit.SECONDS)
            }
            diagnosis = "Full PRoot trace: files/ubuntu-git-trace.log\n" +
                trace.readLines().takeLast(60).joinToString("\n")
        }
        assertEquals("$output\n$diagnosis", 0, code)
        return output
    }

    @Test fun bundledLoaderExecutesCopiedBinariesScriptsAndAllFiveCommands() = withEnv { env ->
        val root = UbuntuRuntime(context).install()
        val loader = File(context.applicationInfo.nativeLibraryDir, "libproot-loader.so")
        assertTrue("Loader must be installed executable by the package manager", loader.canExecute())
        assertFalse("Loader must not be in app-writable storage", loader.canonicalPath.startsWith(context.filesDir.canonicalPath))
        val launch = UbuntuRuntime(context).launch(listOf("/bin/bash", "-c", "true"), env.root, env.root, env.temp,
            UbuntuEnvironment.defaults(env.root.toString(), env.temp.toString()))
        val abi = Build.SUPPORTED_ABIS.first { it == "arm64-v8a" || it == "x86_64" }
        val entries = JSONObject(context.assets.open("runtime/ubuntu-$abi.json").bufferedReader().use { it.readText() }).getJSONArray("entries")
        var aliases = 0
        for (i in 0 until entries.length()) {
            val entry = entries.getJSONObject(i)
            if (entry.getString("kind") != "hardlink") continue
            val alias = root.resolve(entry.getString("path"))
            assertTrue("Packaged file aliases must use Android-compatible symbolic links", Files.isSymbolicLink(alias))
            assertFalse("Aliases must survive the staging directory rename", Files.readSymbolicLink(alias).isAbsolute)
            assertTrue(Files.isSameFile(alias, root.resolve(entry.getString("target"))))
            aliases++
        }
        assertTrue("The Ubuntu fixture must exercise packaged hardlink aliases", aliases > 0)
        assertEquals(abi == "arm64-v8a", launch.environment.contains("PROOT_BOX64=/usr/local/bin/box64"))
        assertFalse("Box64 is not a QEMU runner", launch.argv.contains("-q"))
        assertTrue("Guest package managers need hardlink emulation under Android SELinux", launch.argv.contains("--link2symlink"))
        assertFalse("The dispatcher opt-in belongs only to the tracer", launch.argv.any { it.startsWith("PROOT_BOX64=") })
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ProcessBuilder(root.resolve("bin/busybox").toString(), "true").start().waitFor()
                fail("Direct exec from the writable rootfs should be blocked at targetSdk 36")
            } catch (_: java.io.IOException) { /* The PRoot loader must solve this exact failure. */ }
        }
        val output = successful(env, """
            set -euo pipefail
            test -n "${'$'}BASH_VERSION"
            . /etc/os-release
            test "${'$'}ID" = ubuntu
            test "${'$'}VERSION_ID" = 24.04
            test "${'$'}(id -u)" = 0
            getconf GNU_LIBC_VERSION
            apt-get --version
            git --version
            curl --version
            rg --version
            jq --version
            printf linked > linked-source
            ln linked-source linked-alias
            printf preserved >> linked-source
            rm linked-source
            test "${'$'}(cat linked-alias)" = linkedpreserved
            rm linked-alias
            # Perl uses libc unlink(): on x86_64 Android its legacy syscall is
            # trapped and replayed as unlinkat. Link emulation must run once.
            printf legacy > legacy-source
            ln legacy-source legacy-alias
            perl -e 'unlink ${'$'}ARGV[0] or die "unlink: ${'$'}!"' legacy-source
            test ! -e legacy-source
            test ! -L legacy-source
            test "${'$'}(stat -c %h legacy-alias)" = 1
            perl -e 'lstat ${'$'}ARGV[0] or die "lstat: ${'$'}!"; stat ${'$'}ARGV[0] or die "stat: ${'$'}!"' legacy-alias
            test "${'$'}(cat legacy-alias)" = legacy
            rm legacy-alias
            cp /bin/busybox ./busybox
            chmod 755 ./busybox
            ./busybox printf 'nested-exec-ok\n'
            printf '#!/bin/bash\nprintf "script-ok\\n"\n' > ./script.sh
            chmod 755 ./script.sh
            ./script.sh
            printf '{"answer":42}\n' | jq -r .answer | rg '^42${'$'}'
        """.trimIndent())
        assertTrue(output, output.contains("nested-exec-ok"))
        assertTrue(output, output.contains("script-ok"))
        assertTrue(output, output.contains("42"))
        assertEquals("literal args 😀|a b", successful(env, JSONArray(listOf("bash", "-c", "printf '%s|%s' \"\$1\" \"\$2\"", "argv0", "literal args 😀", "a b"))))
    }

    @Test fun persistentToolchainAndPrivateSharedMemoryBindingsAreUsable() = withEnv { env ->
        val tools = File(context.noBackupFilesDir, "toolchains").apply { mkdirs() }
        val name = "runtime-test-${UUID.randomUUID()}"
        val marker = File(tools, name).apply { writeText("persistent tools") }
        try {
            assertEquals("persistent tools", successful(env, "cat /opt/pi-android/$name"))
            assertEquals("persistent tools", successful(env, "cat '${marker.absolutePath}'"))
            assertEquals("persistent tools", successful(env, "cat '${marker.canonicalPath}'"))
            successful(env, """
                set -euo pipefail
                test "${'$'}JAVA_HOME" = /opt/pi-android/jdk
                test "${'$'}ANDROID_HOME" = /opt/pi-android/sdk
                test "${'$'}ANDROID_SDK_ROOT" = /opt/pi-android/sdk
                test "${'$'}ANDROID_USER_HOME" = /opt/pi-android/android-user-home
                test "${'$'}GRADLE_USER_HOME" = /opt/pi-android/gradle-user-home
                test "${'$'}BOX64_LD_LIBRARY_PATH" = /opt/pi-android/x86_64/usr/lib/x86_64-linux-gnu
                printf 'shared memory' > /dev/shm/$name
            """.trimIndent())
            assertEquals("shared memory", env.temp.resolve(".proot/shm/$name").toFile().readText())
        } finally { marker.delete(); env.temp.resolve(".proot/shm/$name").toFile().delete() }
    }

    @Test fun ordinaryGitCanCommitCloneBranchMergeFetchAndPush() = withEnv { env ->
        successful(env, """
            set -euo pipefail
            git init -b main repo
            cd repo
            git config user.name 'Pi Test'
            git config user.email 'pi-test@example.invalid'
            printf first > file.txt
            git add file.txt
            git commit -m first
            git init --bare -b main ../remote.git
            git remote add origin ../remote.git
            git push -u origin main
            git clone ../remote.git ../clone
            git switch -c topic
            printf second > second.txt
            git add second.txt
            git commit -m second
            git switch main
            git merge --ff-only topic
            git push origin main
            git -C ../clone fetch origin
            git -C ../clone merge --ff-only origin/main
            test "${'$'}(cat ../clone/second.txt)" = second
            test -z "${'$'}(git status --porcelain)"
        """.trimIndent())
        assertTrue(env.root.resolve("clone/.git/HEAD").toFile().isFile)
    }

    @Test fun hardlinkedFilesSurviveDirectoryMovesCleanupAndNativeReadsAcrossLaunches() = withEnv { env ->
        successful(env, """
            set -euo pipefail
            mkdir quarantine
            printf 'promoted contents' > quarantine/source
            ln quarantine/source promoted
            mv quarantine moved
            rm -rf moved
            test "${'$'}(cat promoted)" = 'promoted contents'
        """.trimIndent())
        // This second command has a different tracer and backing directory.
        assertEquals("promoted contents", successful(env, "cat promoted"))
        val reader = call(env, "env.openBinaryReader", JSONObject().put("path", "promoted")) as JSONObject
        val id = reader.getString("id")
        try {
            val chunk = call(env, "env.reader.read", JSONObject().put("id", id).put("offset", 0).put("length", 100)) as JSONObject
            assertEquals("promoted contents", String(Base64.decode(chunk.getString("data"), Base64.DEFAULT), Charsets.UTF_8))
        } finally { call(env, "env.reader.close", JSONObject().put("id", id)) }
    }

    @Test fun workspaceRepositoryDoesNotTrackLinkBackingFilesOrChangeUserIgnoreRules() = withEnv { env ->
        val userRules = "# User rules\nprivate-note.txt\n"
        val ignore = env.root.resolve(".gitignore")
        Files.write(ignore, userRules.toByteArray(Charsets.UTF_8))
        val tracked = successful(env, """
            set -euo pipefail
            git init -q -b main .
            printf private > private-note.txt
            printf visible > hello.txt
            git add .
            git ls-files
        """.trimIndent())
        assertEquals(".gitignore\nhello.txt\n", tracked)
        assertArrayEquals(userRules.toByteArray(Charsets.UTF_8), Files.readAllBytes(ignore))
        assertTrue("git add must exercise actual emulated object storage",
            env.root.resolve(".pi-proot-links").toFile().walkTopDown().any { it.isFile && it.name.startsWith(".l2s.") })
    }

    @Test fun curlTransfersBinaryFilesAndPipesJsonThroughJq() = withEnv { env ->
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setBody("{\"result\":42}"))
            assertEquals("42\n", successful(env, "curl --fail --silent --show-error '${server.url("/json")}' | jq -r .result"))
            server.takeRequest(5, TimeUnit.SECONDS)
            val payload = byteArrayOf(0, 1, -1, -2, 42)
            server.enqueue(MockResponse().setBody(okio.Buffer().write(payload)))
            successful(env, "curl --fail --silent --show-error '${server.url("/binary")}' -o downloaded.bin")
            assertArrayEquals(payload, env.root.resolve("downloaded.bin").toFile().readBytes())
            server.takeRequest(5, TimeUnit.SECONDS)
            server.enqueue(MockResponse().setBody("uploaded"))
            assertEquals("uploaded", successful(env, "curl --fail --silent --show-error -X POST --data-binary @downloaded.bin '${server.url("/upload")}'"))
            assertArrayEquals(payload, server.takeRequest(5, TimeUnit.SECONDS)!!.body.readByteArray())
        }
    }

    @Test fun curlVerifiesTlsAndAcceptsOnlyAnExplicitTestCa() = withEnv { env ->
        val certificate = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val certificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        MockWebServer().use { server ->
            server.useHttps(certificates.sslSocketFactory(), false)
            server.start()
            val (code, _) = run(env, "curl --silent --show-error '${server.url("/")}'")
            assertEquals("An untrusted certificate must fail", 60, code)
            env.root.resolve("test-ca.pem").toFile().writeText(certificate.certificatePem())
            server.enqueue(MockResponse().setBody("verified"))
            assertEquals("verified", successful(env, "curl --fail --silent --show-error --cacert test-ca.pem '${server.url("/")}'"))
        }
    }

    @Test fun killingTracerAlsoKillsDetachedGuestDescendants() = withEnv { env ->
        val result = CompletableFuture<Any?>()
        env.dispatch("env.exec", JSONObject().put("id", "detached").put("command",
            "setsid bash -c 'sleep 2; echo leaked > escaped.txt' & touch started; sleep 30"),
            { result.complete(it) }, { result.completeExceptionally(it) }, {})
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!env.root.resolve("started").toFile().exists() && System.nanoTime() < deadline) Thread.sleep(20)
        assertTrue(env.root.resolve("started").toFile().exists())
        env.dispatch("env.exec.cancel", JSONObject().put("id", "detached"), {}, { throw AssertionError(it) }, {})
        try { result.get(5, TimeUnit.SECONDS); fail("Cancellation must fail the command") }
        catch (error: java.util.concurrent.ExecutionException) { assertEquals("aborted", (error.cause as EnvFailure).code) }
        Thread.sleep(2500)
        assertFalse("A detached child must not survive its PRoot tracer", env.root.resolve("escaped.txt").toFile().exists())
    }
}
