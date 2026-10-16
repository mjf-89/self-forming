package md.incept.selfforming

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Real WebView, Bash, PRoot and Android service; no account, model or external network. */
@RunWith(AndroidJUnit4::class)
class BackgroundProcessTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private val owner = "background-test-${UUID.randomUUID()}"
    private val probeClient = "$owner-probe"
    private val folder = ".background-test-${UUID.randomUUID()}"

    @Test fun shellServerSurvivesBackgroundRecreationAndUnrelatedCancellation() {
        assertFalse("The fixture requires unused localhost port 3000", portOpen())
        if (Build.VERSION.SDK_INT >= 33) {
            shell("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
            assertEquals("Allow the real foreground notification without interrupting the fixture with a permission dialog",
                PackageManager.PERMISSION_GRANTED, context.checkSelfPermission("android.permission.POST_NOTIFICATIONS"))
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                var view = installFixture(scenario)
                val initialEnvironment = evaluate(view, "({id: fixture.env.id, background: fixture.env.backgroundExecution})")
                assertTrue("The native adapter must advertise background execution", initialEnvironment.getBoolean("background"))
                // Use the exact user-facing Offline demo recipe, not a second test-only
                // server implementation. Only its generated, isolated directory differs.
                evaluate(view, """
                    (() => {
                      (async () => {
                        for (const result of [
                          await fixture.env.createDir(${JSONObject.quote(folder)}, {recursive:true}, {}),
                          await fixture.env.writeFile(${JSONObject.quote("$folder/server.sh")}, fixture.serverSource, {})
                        ]) if (!result.ok) throw result.error;
                        fixture.result.setup = {written:true};
                      })().catch(error => { fixture.result.setup = {fatal:String(error?.stack ?? error)}; });
                      return {};
                    })()
                """.trimIndent())
                assertTrue(awaitResult(view, "setup").getBoolean("written"))
                start(view, "launch", "/bin/sh '$folder/server.sh' start")
                val launched = awaitResult(view, "launch", 30_000)
                assertExecSuccess(launched)
                assertTrue("The recipe must really start a fresh server: $launched", launched.getString("output").startsWith("STARTED: PID "))
                checkpoint("Bash returned after launching its redirected background child")
                await("The shell server must listen on localhost:3000", 15_000) { portOpen() }
                val first = execute(view, "first-curl", CURL)
                assertSuccess(first, HELLO)
                val identity = execute(view, "first-check", "/bin/sh '$folder/server.sh' check")
                assertExecSuccess(identity)
                assertTrue("The recipe must validate process identity and HTTP run marker: $identity",
                    identity.getString("output").startsWith("PASS: the existing server returned Hello World."))
                assertTrue("The process service must have a foreground notification", foregroundService())
                checkpoint("A second independent exec returned Hello World from port 3000")

                start(view, "cancel-me", "printf 'foreground-started\\n'; sleep 60")
                await("The unrelated foreground command must actually start") {
                    evaluate(view, "({output: fixture.output['cancel-me'] ?? ''})").getString("output").contains("foreground-started")
                }
                evaluate(view, "(() => { fixture.jobs['cancel-me'].abort(); return {}; })()")
                val cancelled = awaitResult(view, "cancel-me")
                assertFalse("Cancellation must fail only that exec", cancelled.getBoolean("ok"))
                assertEquals("aborted", cancelled.getString("code"))
                assertSuccess(execute(view, "after-cancel", CURL), HELLO)
                checkpoint("Cancelling a concurrent foreground exec kept the server alive")

                scenario.onActivity { assertTrue("The Activity must move behind the launcher", it.moveTaskToBack(true)) }
                await("The Activity must really be stopped") { scenario.state == Lifecycle.State.CREATED }
                shell("input keyevent KEYCODE_SLEEP")
                await("The emulator screen must really turn off") { !context.getSystemService(PowerManager::class.java).isInteractive }
                assertTrue("The service must remain foreground while screen is off", foregroundService())
                // Deliberately do not evaluate JavaScript while the WebView is backgrounded.
                // An independent native client asks the same service to execute Alpine curl.
                assertSuccess(nativeExec(CURL), HELLO)
                checkpoint("Activity stopped and screen off: separate native curl returned Hello World")

                wakeAndReturn()
                await("Returning must resume the Activity") { scenario.state == Lifecycle.State.RESUMED }
                val oldView = view
                scenario.recreate()
                view = installFixture(scenario)
                assertNotSame("Recreation must create a new WebView and bridge", oldView, view)
                assertEquals("Reconnection must use the existing service execution environment",
                    initialEnvironment.getString("id"), evaluate(view, "({id: fixture.env.id})").getString("id"))
                assertSuccess(execute(view, "reconnected", CURL), HELLO)
                assertSuccess(execute(view, "same-process", "/bin/sh '$folder/server.sh' check"), identity.getString("output"))
                checkpoint("Activity recreation reconnected to the same running shell server")

                val info = call(view, "service-info", "env.service.info", JSONObject().put("owner", owner))
                assertTrue("At least the HTTP server must remain service-owned: $info", info.getInt("backgroundCommands") >= 1)
                call(view, "stop", "env.service.stop", JSONObject().put("owner", owner))
                await("Explicit stop must terminate the server and close its listening socket") { !portOpen() }
                await("The foreground service must stop when no jobs remain") { !foregroundService() }
                val stopped = execute(view, "after-stop", "curl --silent --show-error --max-time 2 http://127.0.0.1:3000/")
                assertTrue("The curl process itself must complete", stopped.getBoolean("ok"))
                assertTrue("A new exec must fail to reach the stopped server: $stopped", stopped.getInt("exitCode") != 0)
                checkpoint("Explicit service stop closed port 3000; a later curl could not connect")
            } finally {
                // Stop only this generated fixture owner. Never stop another user's jobs.
                runCatching { nativeCall("env.service.stop", JSONObject().put("owner", owner)) }
                    .onFailure { println("Background fixture cleanup: $it") }
                ExecutionService.detach(probeClient)
                runCatching { wakeAndReturn() }.onFailure { println("Background fixture wake: $it") }
                val workspace = File(context.filesDir, "workspace").canonicalFile
                val fixture = File(workspace, folder).canonicalFile
                check(fixture.parentFile == workspace && fixture.name.startsWith(".background-test-"))
                val log = File(fixture, "server.log")
                if (log.isFile) log.inputStream().use { input ->
                    val bytes = ByteArray(16_384)
                    val count = input.read(bytes)
                    if (count > 0) println("Background fixture server.log: ${String(bytes, 0, count, Charsets.UTF_8)}")
                }
                fixture.deleteRecursively()
            }
        }
    }

    /** Replace just the page response; keep MainActivity's production bridge and lifecycle. */
    private fun installFixture(scenario: ActivityScenario<MainActivity>): WebView {
        lateinit var view: WebView
        scenario.onActivity { activity ->
            view = requireNotNull(findWebView(activity.window.decorView))
            val original = view.webViewClient
            view.webViewClient = object : WebViewClient() {
                override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) = original.onPageStarted(v, url, favicon)
                override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? {
                    if (request.isForMainFrame && request.url.toString() == PAGE) return WebResourceResponse(
                        "text/html", "UTF-8", 200, "OK", mapOf("Cache-Control" to "no-store",
                            "Content-Security-Policy" to "default-src 'none'; script-src 'self'; connect-src 'none'"),
                        ByteArrayInputStream("<!doctype html><title>Background service fixture</title><p>Testing local server.</p>".toByteArray()))
                    return original.shouldInterceptRequest(v, request)
                }
            }
            view.loadUrl(PAGE)
        }
        await("The isolated test document must load") {
            evaluate(view, "({loaded: document.title === 'Background service fixture' && document.readyState === 'complete'})").optBoolean("loaded")
        }
        evaluate(view, """
            (() => {
              window.fixture = {ready:false, result:{}, output:{}, jobs:{}};
              Promise.all([
                import('${MainActivity.ORIGIN}/assets/web/native-host.js'),
                import('${MainActivity.ORIGIN}/assets/web/background-server.js')
              ]).then(async ([native, recipe]) => {
                const f = window.fixture;
                f.serverSource = recipe.SERVER_SOURCE;
                f.bridge = native.createNativeBridge();
                f.env = await native.openNativeExecutionEnv(f.bridge, undefined, {owner:${JSONObject.quote(owner)}});
                f.start = (name, command) => {
                  f.output[name] = '';
                  const controller = f.jobs[name] = new AbortController();
                  f.env.exec(command, {timeout:30, onOutput: text => { f.output[name] += text; }},
                    {abortSignal:controller.signal}).then(result => {
                      f.result[name] = result.ok ? {ok:true, ...result.value, output:f.output[name]}
                        : {ok:false, code:result.error.code, message:result.error.message, output:f.output[name]};
                    }).catch(error => { f.result[name] = {fatal:String(error?.stack ?? error)}; });
                };
                f.ready = true;
              }).catch(error => { fixture.fatal = String(error?.stack ?? error); });
              return {};
            })()
        """.trimIndent())
        await("The actual native-host adapter must connect", 30_000) {
            val state = evaluate(view, "({ready:fixture.ready, fatal:fixture.fatal})")
            assertFalse("Fixture boot failed: $state", state.has("fatal"))
            state.optBoolean("ready")
        }
        return view
    }

    private fun start(view: WebView, name: String, command: String) {
        evaluate(view, "(() => { fixture.start(${JSONObject.quote(name)}, ${JSONObject.quote(command)}); return {}; })()")
    }

    private fun execute(view: WebView, name: String, command: String): JSONObject {
        start(view, name, command)
        return awaitResult(view, name)
    }

    private fun call(view: WebView, name: String, method: String, params: JSONObject): JSONObject {
        evaluate(view, """
            (() => {
              fixture.bridge.call(${JSONObject.quote(method)}, $params).then(value => {
                fixture.result[${JSONObject.quote(name)}] = {value};
              }).catch(error => { fixture.result[${JSONObject.quote(name)}] = {fatal:String(error?.stack ?? error)}; });
              return {};
            })()
        """.trimIndent())
        return awaitResult(view, name).optJSONObject("value") ?: JSONObject()
    }

    private fun awaitResult(view: WebView, name: String, timeout: Long = 15_000): JSONObject {
        var result = JSONObject()
        await("Native request '$name' must complete", timeout) {
            result = evaluate(view, "fixture.result[${JSONObject.quote(name)}] ?? {}")
            result.length() > 0
        }
        assertFalse("Native request '$name' threw: $result", result.has("fatal"))
        return result
    }

    private fun nativeExec(command: String): JSONObject {
        val output = ByteArrayOutputStream()
        val result = nativeCall("env.exec", JSONObject().put("id", UUID.randomUUID().toString())
            .put("owner", owner).put("command", command).put("timeout", 15)) { event ->
            if (event.optString("event") == "env.output") synchronized(output) {
                output.write(Base64.decode(event.getString("data"), Base64.DEFAULT))
            }
        }
        return result.put("ok", true).put("output", output.toString("UTF-8"))
    }

    private fun nativeCall(method: String, params: JSONObject, event: (JSONObject) -> Unit = {}): JSONObject {
        val result = CompletableFuture<Any?>()
        instrumentation.runOnMainSync {
            ExecutionService.dispatch(context, probeClient, method, params, { result.complete(it) }, { result.completeExceptionally(it) }, event)
        }
        return result.get(25, TimeUnit.SECONDS) as? JSONObject ?: JSONObject()
    }

    private fun assertSuccess(result: JSONObject, expected: String) {
        assertExecSuccess(result)
        assertEquals(expected, result.getString("output"))
    }

    private fun assertExecSuccess(result: JSONObject) {
        assertTrue("Exec must complete successfully: $result", result.optBoolean("ok"))
        assertEquals("Exec must exit zero: $result", 0, result.getInt("exitCode"))
    }

    private fun evaluate(view: WebView, script: String): JSONObject {
        val value = CompletableFuture<String>()
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { value.complete(it) } }
        return JSONObject(value.get(10, TimeUnit.SECONDS))
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findWebView(view.getChildAt(i))?.let { return it }
        return null
    }

    private fun shell(command: String) = ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }

    private fun wakeAndReturn() {
        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")
        val output = shell("am start -W -n ${context.packageName}/${MainActivity::class.java.name}")
        assertFalse("Returning to the app failed: $output", output.contains("Error:"))
    }

    @Suppress("DEPRECATION")
    private fun foregroundService() = context.getSystemService(ActivityManager::class.java)
        .getRunningServices(Int.MAX_VALUE).any { it.service.className == ExecutionService::class.java.name && it.foreground }

    private fun portOpen(): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", 3000), 250) }
        true
    } catch (_: java.io.IOException) { false }

    private fun await(description: String, timeout: Long = 10_000, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        do { if (predicate()) return; SystemClock.sleep(100) } while (SystemClock.elapsedRealtime() < deadline)
        fail(description)
    }

    private fun checkpoint(message: String) = println("Background process: PASS: $message")

    companion object {
        private const val PAGE = "${MainActivity.ORIGIN}/assets/web/index.html"
        private const val CURL = "curl --fail --silent --retry 4 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:3000/"
        private const val HELLO = "Hello World\n"
    }
}
