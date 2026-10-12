package md.incept.selfforming

import android.app.ActivityManager
import android.content.Context
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Synthetic OAuth callback: no account, authorization code, or model request is involved. */
@RunWith(AndroidJUnit4::class)
class SignInLifecycleTest {
    @Test fun callbackArrivesWithActivityInBackgroundAndReturnIntentReusesIt() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val id = UUID.randomUUID().toString()
        val state = "dGhpcy1pcy1hLXJhbmRvbS10ZXN0LXN0YXRl"
        val listener = LoopbackAuth(state, 30_000)
        val ready = CompletableFuture<Unit>()
        val stopped = CompletableFuture<Unit>()
        val returned = CompletableFuture<android.app.Activity>()
        listener.result.whenComplete { _, _ -> SignInService.stop(id) }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            var original: MainActivity? = null
            var lifecycle: android.app.Application.ActivityLifecycleCallbacks? = null
            scenario.onActivity { activity ->
                original = activity
                lifecycle = object : android.app.Application.ActivityLifecycleCallbacks {
                    override fun onActivityStopped(a: android.app.Activity) {
                        if (a === original) stopped.complete(Unit)
                    }
                    override fun onActivityCreated(a: android.app.Activity, b: android.os.Bundle?) {}
                    override fun onActivityStarted(a: android.app.Activity) {}
                    override fun onActivityResumed(a: android.app.Activity) {
                        if (a is MainActivity && stopped.isDone) returned.complete(a)
                    }
                    override fun onActivityPaused(a: android.app.Activity) {}
                    override fun onActivitySaveInstanceState(a: android.app.Activity, b: android.os.Bundle) {}
                    override fun onActivityDestroyed(a: android.app.Activity) {}
                }
                activity.application.registerActivityLifecycleCallbacks(lifecycle!!)
                SignInService.start(context, id, { ready.complete(Unit) }, { ready.completeExceptionally(it) })
            }
            try {
                ready.get(10, TimeUnit.SECONDS)
                assertTrue("The service must be foreground before leaving the app", foreground(context))
                instrumentation.runOnMainSync { assertTrue(original!!.moveTaskToBack(true)) }
                stopped.get(10, TimeUnit.SECONDS)
                assertTrue("Sign-in must remain foreground while the Activity is stopped", foreground(context))
                val response = Socket("127.0.0.1", listener.port).use { socket ->
                    socket.soTimeout = 5000
                    socket.getOutputStream().write(("GET /auth/callback?state=$state&code=synthetic HTTP/1.1\r\n" +
                        "Host: 127.0.0.1:${listener.port}\r\nConnection: close\r\n\r\n").toByteArray())
                    socket.getInputStream().readBytes().toString(Charsets.UTF_8)
                }
                assertTrue(response.startsWith("HTTP/1.1 200"))
                assertTrue(response.contains("Return to Self Forming"))
                assertTrue(response.contains("package=${context.packageName};"))
                assertTrue(listener.result.get(5, TimeUnit.SECONDS).contains("code=synthetic"))
                awaitServiceStopped(context)
                // Shell dispatch models an external user navigation without relying on
                // the background app having permission to launch its own Activity.
                val command = "am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE " +
                    "-d ${BuildConfig.SIGN_IN_SCHEME}://signin-complete -p ${context.packageName}"
                val output = ParcelFileDescriptor.AutoCloseInputStream(
                    instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }
                assertFalse("Return intent failed: $output", output.contains("Error:"))
                assertSame("The return intent must actually resume the existing Activity", original,
                    returned.get(10, TimeUnit.SECONDS))
                instrumentation.waitForIdleSync()
                scenario.onActivity { assertSame("Returning must preserve the live WebView/PKCE owner", original, it) }
            } finally {
                lifecycle?.let { callback -> instrumentation.runOnMainSync {
                    original?.application?.unregisterActivityLifecycleCallbacks(callback)
                } }
                listener.cancel(); SignInService.stop(id)
            }
        }
    }

    @Test fun cancellingSignInStopsTheForegroundService() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val id = UUID.randomUUID().toString()
        val listener = LoopbackAuth("dGhpcy1pcy1hLXJhbmRvbS10ZXN0LXN0YXRl", 30_000)
        val ready = CompletableFuture<Unit>()
        listener.result.whenComplete { _, _ -> SignInService.stop(id) }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                scenario.onActivity { SignInService.start(context, id, { ready.complete(Unit) }, { ready.completeExceptionally(it) }) }
                ready.get(10, TimeUnit.SECONDS)
                assertTrue(foreground(context))
                listener.cancel()
                awaitServiceStopped(context)
            } finally { listener.cancel(); SignInService.stop(id) }
        }
    }

    @Test fun cancellingBeforeServiceStartsSettlesThePendingOpen() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val id = UUID.randomUUID().toString()
        val failure = CompletableFuture<HostFailure>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity {
                // onStartCommand cannot run between these calls on the main thread.
                SignInService.start(context, id, { failure.completeExceptionally(AssertionError("Cancelled startup opened the browser")) },
                    { failure.complete(it) })
                SignInService.stop(id)
            }
            assertEquals("AUTH_CANCELLED", failure.get(5, TimeUnit.SECONDS).code)
            awaitServiceStopped(context)
        }
    }

    @Suppress("DEPRECATION")
    private fun foreground(context: Context): Boolean = context.getSystemService(ActivityManager::class.java)
        .getRunningServices(Int.MAX_VALUE).any { it.service.className == SignInService::class.java.name && it.foreground }

    @Suppress("DEPRECATION")
    private fun serviceRunning(context: Context): Boolean = context.getSystemService(ActivityManager::class.java)
        .getRunningServices(Int.MAX_VALUE).any { it.service.className == SignInService::class.java.name }

    private fun awaitServiceStopped(context: Context) {
        val deadline = SystemClock.elapsedRealtime() + 5000
        while (serviceRunning(context) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20)
        assertFalse("Sign-in service must stop after completion or cancellation", serviceRunning(context))
    }
}
