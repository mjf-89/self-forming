package md.incept.selfforming

import android.content.Context
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NativeExecutionEnvTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun withEnv(test: (NativeExecutionEnv) -> Unit) {
        val base = File(context.cacheDir, "native-env-test-${UUID.randomUUID()}")
        UbuntuRuntime(context).install()
        NativeExecutionEnv(context, File(base, "workspace").toPath(), File(base, "temp").toPath()).use { env ->
            try { test(env) } finally { env.reset() }
        }
        // Do not delete until the asynchronous resource-close queue has settled; Android cleans test cache.
    }
    private fun request(env: NativeExecutionEnv, method: String, p: JSONObject = JSONObject(),
                        event: (JSONObject) -> Unit = {}): CompletableFuture<Any?> {
        val future = CompletableFuture<Any?>()
        env.dispatch(method, p, { future.complete(it) }, { future.completeExceptionally(it) }, event)
        return future
    }
    private fun call(env: NativeExecutionEnv, method: String, p: JSONObject = JSONObject()): Any? =
        request(env, method, p).get(10, TimeUnit.SECONDS)
    private fun json(vararg fields: Pair<String, Any>) = JSONObject().also { value -> fields.forEach { value.put(it.first, it.second) } }
    private fun failure(future: CompletableFuture<Any?>): EnvFailure = try {
        future.get(10, TimeUnit.SECONDS); throw AssertionError("Expected native error")
    } catch (error: ExecutionException) { error.cause as EnvFailure }
    private fun output(env: NativeExecutionEnv, command: Any, extra: JSONObject = JSONObject()): Pair<JSONObject, ByteArray> {
        val bytes = ByteArrayOutputStream()
        extra.put("id", UUID.randomUUID().toString()).put("command", command)
        val result = request(env, "env.exec", extra) { event ->
            if (event.optString("event") == "env.output") synchronized(bytes) { bytes.write(Base64.decode(event.getString("data"), Base64.DEFAULT)) }
        }.get(15, TimeUnit.SECONDS) as JSONObject
        return result to bytes.toByteArray()
    }

    @Test fun binaryHandlesPreserveOpenedInodesAndWritersSupportChunks() = withEnv { env ->
        val writer = call(env, "env.openWriter", json("path" to "sub/data.bin")) as JSONObject
        val id = writer.getString("id")
        call(env, "env.writer.write", json("id" to id, "data" to "AAH/"))
        call(env, "env.writer.write", json("id" to id, "data" to "AgM="))
        call(env, "env.writer.close", json("id" to id))
        val reader = call(env, "env.openBinaryReader", json("path" to "sub/data.bin")) as JSONObject
        val readerId = reader.getString("id")
        call(env, "env.renameFile", json("sourcePath" to "sub/data.bin", "destinationPath" to "sub/renamed.bin"))
        call(env, "env.writeFile", json("path" to "sub/data.bin", "text" to "replacement"))
        val metadata = call(env, "env.reader.info", json("id" to readerId)) as JSONObject
        assertEquals(5, metadata.getInt("size"))
        val read = call(env, "env.reader.read", json("id" to readerId, "offset" to 1, "length" to 100)) as JSONObject
        assertArrayEquals(byteArrayOf(1, -1, 2, 3), Base64.decode(read.getString("data"), Base64.DEFAULT))
        call(env, "env.reader.close", json("id" to readerId))
        call(env, "env.reader.close", json("id" to readerId))
        assertEquals("invalid", failure(request(env, "env.reader.info", json("id" to readerId))).code)
    }

    @Test fun shellRunsUbuntuBashAndArgvPreservesLiteralUnicode() = withEnv { env ->
        val hostile = "it's \$(touch pwned) `touch pwned` *; π 🐱"
        val (result, bytes) = output(env, JSONArray(listOf("/bin/bash", "-c", "printf '%s|%s' \"\$1\" \"\$2\"", "argv0", hostile, "a b")))
        assertEquals(0, result.getInt("exitCode"))
        assertEquals("$hostile|a b", bytes.toString(Charsets.UTF_8))
        assertEquals(false, call(env, "env.exists", json("path" to "pwned")))
        call(env, "env.createDir", json("path" to "sub"))
        val (exit, _) = output(env, "printf x > made.txt; exit 3", json("cwd" to "sub"))
        assertEquals(3, exit.getInt("exitCode"))
        assertEquals("x", String(Files.readAllBytes(env.root.resolve("sub/made.txt")), Charsets.UTF_8))
        assertEquals("spawn_error", failure(request(env, "env.exec", json("id" to UUID.randomUUID().toString(), "command" to JSONArray(listOf("pi-no-such-program"))))).code)
    }

    @Test fun timeoutKillsOnlyItsGuestProcessesAndPreservesSpilledRawBytes() = withEnv { env ->
        val survivor = request(env, "env.exec", json("id" to "survivor", "command" to "sleep 2.5; printf alive > survivor.txt"))
        // The timeout includes PRoot/Bash startup. Allow startup on a loaded emulator;
        // both delayed writes still happen after timeout, so cleanup remains observable.
        val timed = request(env, "env.exec", json("id" to "timeout", "command" to "printf '\\377\\376abc\\n'; (sleep 4; printf leaked > child.txt) & sleep 10",
            "timeout" to 2.0, "spill" to json("afterBytes" to 2, "afterLines" to 10)))
        val error = failure(timed)
        assertEquals("timeout", error.code)
        assertNotNull("The output prefix must be captured before timeout", error.spillPath)
        assertArrayEquals(byteArrayOf(-1, -2, 97, 98, 99, 10), Files.readAllBytes(java.nio.file.Paths.get(error.spillPath!!)))
        assertEquals(0, (survivor.get(10, TimeUnit.SECONDS) as JSONObject).getInt("exitCode"))
        Thread.sleep(2500)
        assertEquals(false, call(env, "env.exists", json("path" to "child.txt")))
        assertEquals(true, call(env, "env.exists", json("path" to "survivor.txt")))
        val aborted = request(env, "env.exec", json("id" to "abort-immediately", "command" to "sleep 10"))
        call(env, "env.exec.cancel", json("id" to "abort-immediately"))
        assertEquals("aborted", failure(aborted).code)
    }

    @Test fun filesystemFollowsSafeLinksAndRejectsEscapes() = withEnv { env ->
        call(env, "env.writeFile", json("path" to "data/target.txt", "text" to "target"))
        val (result, _) = output(env, "ln -s data dirlink; ln -s data/target.txt linked; ln -s /system outside")
        assertEquals(0, result.getInt("exitCode"))
        val reader = call(env, "env.openBinaryReader", json("path" to "dirlink/target.txt", "noFollow" to true)) as JSONObject
        call(env, "env.reader.close", json("id" to reader.getString("id")))
        assertEquals("invalid", failure(request(env, "env.openBinaryReader", json("path" to "linked", "noFollow" to true))).code)
        assertEquals("permission_denied", failure(request(env, "env.openBinaryReader", json("path" to "outside/build.prop"))).code)
        assertEquals("symlink", (call(env, "env.fileInfo", json("path" to "outside")) as JSONObject).getString("kind"))
        call(env, "env.remove", json("path" to "outside"))
        assertEquals(false, call(env, "env.exists", json("path" to "outside")))
    }

    @Test fun pollingWatchSeesShellChangesAndStopsBeforeCloseReturns() = withEnv { env ->
        val events = CopyOnWriteArrayList<JSONObject>()
        val watch = request(env, "env.watch", json("id" to "watch", "targets" to JSONArray().put(json("path" to "nested", "recursive" to true)))) { events.add(it) }
            .get(10, TimeUnit.SECONDS) as JSONObject
        assertEquals("polling", watch.getString("mode"))
        output(env, "mkdir -p nested/a; printf x > nested/a/file.txt")
        val deadline = System.currentTimeMillis() + 3000
        while (events.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertTrue("Shell changes must be reported", events.isNotEmpty())
        call(env, "env.watch.close", json("id" to "watch"))
        val count = events.size
        output(env, "printf y > nested/a/file.txt")
        Thread.sleep(350)
        assertEquals(count, events.size)
    }

    @Test fun ownerCleanupReturnsKilledExitStatusAndLeavesOtherCommandsRunning() = withEnv { env ->
        val owned = request(env, "env.exec", json("id" to "owned", "owner" to "one", "command" to "touch started; sleep 60"))
        val other = request(env, "env.exec", json("id" to "other", "owner" to "two", "command" to "sleep 0.4; printf alive > other.txt"))
        val deadline = System.currentTimeMillis() + 3000
        while (!Files.exists(env.root.resolve("started")) && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertTrue("Command must be running before cleanup", Files.exists(env.root.resolve("started")))
        call(env, "env.cleanup", json("owner" to "one"))
        assertTrue("Cleanup is a process termination, not an aborted request", (owned.get(3, TimeUnit.SECONDS) as JSONObject).getInt("exitCode") != 0)
        assertEquals(0, (other.get(3, TimeUnit.SECONDS) as JSONObject).getInt("exitCode"))
        assertTrue(Files.exists(env.root.resolve("other.txt")))
    }

    @Test fun detachedChildHoldingPipesDoesNotPreventShellExitFromSettling() = withEnv { env ->
        val started = System.nanoTime()
        val (result, bytes) = output(env,
            "setsid /bin/bash -c 'echo \$\$ > detached.pid; sleep 10' & " +
                "while [ ! -s detached.pid ]; do sleep 0.01; done; printf shell-exited")
        assertEquals(0, result.getInt("exitCode"))
        assertEquals("shell-exited", bytes.toString(Charsets.UTF_8))
        assertTrue("PRoot must dispose of detached children and close inherited pipes", System.nanoTime() - started < TimeUnit.SECONDS.toNanos(3))
    }
}
