package md.incept.selfforming

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.Button
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Exercises the installed app and a real software keyboard; never submits a message or signs in. */
@RunWith(AndroidJUnit4::class)
class KeyboardLayoutTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun softwareKeyboardKeepsTheComposerVisibleAndHidingItRestoresTheViewport() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var webView: WebView
            scenario.onActivity { activity ->
                webView = requireNotNull(findWebView(activity.window.decorView)) { "App WebView is missing" }
            }
            try {
                await("The bundled app must enable its message input", 30_000) {
                    evaluate(webView, """
                        (() => {
                          const prompt = document.getElementById('prompt');
                          return {ready: Boolean(prompt && !prompt.disabled)};
                        })()
                    """.trimIndent()).optBoolean("ready")
                }
                evaluate(webView, """
                    (() => {
                      return {opened: true};
                    })()
                """.trimIndent())
                await("Chat and its enabled message input must be visible before measuring") {
                    geometry(webView).optBoolean("ready")
                }
                hideKeyboard(webView)
                await("The initial viewport must settle with the keyboard hidden") {
                    !nativeGeometry(webView).imeVisible && viewportMatches(webView)
                }
                val before = nativeGeometry(webView)
                val beforePage = geometry(webView)
                assertVisibleComposer(beforePage)
                assertRecoveryRowDoesNotOverlap(webView)

                instrumentation.runOnMainSync { assertTrue(webView.requestFocus()) }
                val focused = evaluate(webView, """
                    (() => {
                      const prompt = document.getElementById('prompt');
                      prompt.focus({preventScroll: true});
                      return {focused: document.activeElement === prompt};
                    })()
                """.trimIndent())
                assertTrue("The actual DOM message input must acquire focus", focused.getBoolean("focused"))
                await("WebView must be the focused editor connected to the input method") {
                    var connected = false
                    instrumentation.runOnMainSync {
                        connected = webView.hasWindowFocus() && webView.hasFocus() &&
                            webView.context.getSystemService(InputMethodManager::class.java).isActive(webView)
                    }
                    connected
                }
                instrumentation.runOnMainSync {
                    webView.context.getSystemService(InputMethodManager::class.java).showSoftInput(webView, 0)
                }
                await("A real software keyboard must appear and resize the WebView") {
                    val native = nativeGeometry(webView)
                    native.imeVisible && native.imeBottom > native.navigationBottom &&
                        native.height < before.height && viewportMatches(webView)
                }
                val shown = nativeGeometry(webView)
                val shownPage = geometry(webView)
                assertEquals("The native viewport must subtract keyboard overlap exactly once",
                    (before.height - shown.imeBottom + before.navigationBottom).toDouble(), shown.height.toDouble(), 3.0)
                assertEquals("The keyboard must not shift the top of the WebView", before.top, shown.top)
                assertEquals("The input must retain focus while the keyboard is visible", "prompt", shownPage.getString("active"))
                assertVisibleComposer(shownPage)
                assertRecoveryRowDoesNotOverlap(webView)

                hideKeyboard(webView)
                await("Hiding the keyboard must restore the native and web viewports") {
                    val native = nativeGeometry(webView)
                    !native.imeVisible && native.height == before.height && viewportMatches(webView) &&
                        kotlin.math.abs(geometry(webView).getDouble("height") - beforePage.getDouble("height")) <= 2
                }
                assertVisibleComposer(geometry(webView))
            } finally {
                hideKeyboard(webView)
            }
        }
    }

    private data class NativeGeometry(val width: Int, val height: Int, val top: Int,
        val imeVisible: Boolean, val imeBottom: Int, val navigationBottom: Int)

    private fun nativeGeometry(webView: WebView): NativeGeometry {
        lateinit var geometry: NativeGeometry
        instrumentation.runOnMainSync {
            // Read the root: the app deliberately zeroes insets before they reach WebView.
            val insets = requireNotNull(ViewCompat.getRootWindowInsets(webView.rootView))
            val position = IntArray(2)
            webView.getLocationOnScreen(position)
            geometry = NativeGeometry(webView.width, webView.height, position[1],
                insets.isVisible(WindowInsetsCompat.Type.ime()),
                insets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
                insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
        }
        return geometry
    }

    private fun viewportMatches(webView: WebView): Boolean {
        val native = nativeGeometry(webView)
        val page = geometry(webView)
        val width = page.optDouble("width")
        if (width <= 0 || !page.optBoolean("ready")) return false
        val pixelsPerCssPixel = native.width / width
        return kotlin.math.abs(page.getDouble("height") * pixelsPerCssPixel - native.height) <= 3 &&
            kotlin.math.abs(page.getDouble("visualHeight") * pixelsPerCssPixel - native.height) <= 3
    }

    private fun assertVisibleComposer(page: JSONObject) {
        val left = page.getDouble("visualLeft")
        val top = page.getDouble("visualTop")
        val right = left + page.getDouble("visualWidth")
        val bottom = top + page.getDouble("visualHeight")
        for (name in listOf("composer", "prompt", "send", "footer")) {
            val rect = page.getJSONObject(name)
            assertTrue("$name must have a visible area: $page", rect.getDouble("width") > 0 && rect.getDouble("height") > 0)
            assertTrue("$name must fit inside the visible viewport: $page",
                rect.getDouble("left") >= left - 2 && rect.getDouble("right") <= right + 2 &&
                    rect.getDouble("top") >= top - 2 && rect.getDouble("bottom") <= bottom + 2)
        }
        assertEquals("The composer panel must sit directly above the model/status footer",
            page.getJSONObject("footer").getDouble("top"), page.getJSONObject("panel").getDouble("bottom"), 2.0)
        assertEquals("The footer must stay at the viewport bottom without a keyboard-sized gap",
            bottom, page.getJSONObject("footer").getDouble("bottom"), 2.0)
    }

    private fun geometry(webView: WebView): JSONObject = evaluate(webView, """
        (() => {
          const prompt = document.getElementById('prompt');
          const chat = document.getElementById('chat-screen');
          if (!prompt || prompt.disabled || !chat || chat.hidden || !prompt.getClientRects().length) return {ready: false};
          const rect = selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height};
          };
          const v = window.visualViewport;
          return {ready:true, active:document.activeElement?.id, width:innerWidth, height:innerHeight,
            visualLeft:v?.offsetLeft ?? 0, visualTop:v?.offsetTop ?? 0,
            visualWidth:v?.width ?? innerWidth, visualHeight:v?.height ?? innerHeight,
            composer:rect('#composer'), prompt:rect('#prompt'), send:rect('#send'), panel:rect('.composer-panel'), footer:rect('#app-footer')};
        })()
    """.trimIndent())

    private fun evaluate(webView: WebView, script: String): JSONObject {
        val result = CompletableFuture<String>()
        instrumentation.runOnMainSync { webView.evaluateJavascript(script) { result.complete(it) } }
        return JSONObject(result.get(5, TimeUnit.SECONDS))
    }

    private fun hideKeyboard(webView: WebView) {
        instrumentation.runOnMainSync {
            webView.context.getSystemService(InputMethodManager::class.java)
                .hideSoftInputFromWindow(webView.windowToken, 0)
        }
    }

    private fun await(message: String, timeoutMillis: Long = 15_000, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        var stableSamples = 0
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) {
                stableSamples++
                if (stableSamples == 3) return
            } else stableSamples = 0
            // This helper runs on the instrumentation thread, never on Android's UI thread.
            SystemClock.sleep(100)
        }
        fail(message)
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            findWebView(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun assertRecoveryRowDoesNotOverlap(webView: WebView) {
        fun find(view: View): Button? {
            if (view is Button && view.text.toString() == "App recovery") return view
            if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
            return null
        }
        instrumentation.runOnMainSync {
            val recovery = requireNotNull(find(webView.rootView)) { "Native app recovery must remain reachable" }
            assertTrue(recovery.isShown && recovery.isEnabled && recovery.height > 0)
            val recoveryPosition = IntArray(2)
            val webPosition = IntArray(2)
            recovery.getLocationOnScreen(recoveryPosition)
            webView.getLocationOnScreen(webPosition)
            assertTrue("Native recovery must occupy its own row above the web content",
                recoveryPosition[1] + recovery.height <= webPosition[1])
        }
    }
}
