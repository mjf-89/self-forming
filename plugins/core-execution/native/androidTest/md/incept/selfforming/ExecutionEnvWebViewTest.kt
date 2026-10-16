package md.incept.selfforming

import android.annotation.SuppressLint
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Upstream's browser-safe conformance cases cross an actual Android WebView message bridge. */
@RunWith(AndroidJUnit4::class)
class ExecutionEnvWebViewTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @SuppressLint("SetJavaScriptEnabled")
    @Test fun upstreamEnvironmentConformancePassesInTheInstalledWebView() {
        assertTrue("WebView must support the app's actual bridge", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var webView: WebView
            lateinit var host: NativeBridge
            val loaded = CompletableFuture<Unit>()
            scenario.onActivity { activity ->
                // This visible window avoids background timer throttling. A fresh WebView
                // has its own PiNative port and does not load the production app controller.
                webView = WebView(activity)
                host = NativeBridge(activity.applicationContext)
                val loader = WebViewAssetLoader.Builder().setDomain(MainActivity.HOST)
                    .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(activity)).build()
                webView.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = false
                    allowFileAccess = false
                    allowContentAccess = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                }
                WebViewCompat.addWebMessageListener(webView, "PiNative", setOf(MainActivity.ORIGIN)) { _, message, origin, mainFrame, reply ->
                    if (mainFrame && MainActivity.allowedOrigin(origin) && message.type == WebMessageCompat.TYPE_STRING) {
                        message.data?.let { host.receive(it, reply) }
                    }
                }
                webView.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.url.toString() != PAGE

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                        if (!MainActivity.allowedOrigin(request.url) || request.method != "GET") return blocked()
                        if (request.url.toString() == PAGE) return WebResourceResponse("text/html", "UTF-8", 200, "OK", HEADERS,
                            ByteArrayInputStream("<!doctype html><html><head><meta charset=\"utf-8\"><title>Environment conformance</title></head><body>Running native environment checks.</body></html>".toByteArray()))
                        if (request.url.path?.startsWith("/assets/web/") != true) return blocked()
                        val response = loader.shouldInterceptRequest(request.url) ?: return blocked()
                        response.responseHeaders = (response.responseHeaders ?: emptyMap()) + HEADERS
                        return response
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        if (url == PAGE) loaded.complete(Unit)
                    }
                }
                activity.setContentView(webView)
                webView.loadUrl(PAGE)
            }
            try {
                loaded.get(30, TimeUnit.SECONDS)
                evaluate(webView, """
                    (() => {
                      window.__envConformance = {running:true};
                      // evaluateJavascript can give import() an about:blank script
                      // base. Use the fixed trusted asset origin explicitly.
                      Promise.all([
                        import('${MainActivity.ORIGIN}/assets/web/native-host.js'),
                        import('${MainActivity.ORIGIN}/assets/web/env-conformance.js')
                      ]).then(async ([native, suite]) => {
                        window.__envConformance.progress = suite.envConformanceProgress;
                        const bridge = native.createNativeBridge();
                        try { window.__envConformance.result = await suite.runNativeEnvConformance(bridge); }
                        finally { bridge.close(); }
                      }).catch(error => {
                        window.__envConformance.fatal = String(error?.stack ?? error);
                      }).finally(() => { window.__envConformance.running = false; });
                      return {started:true};
                    })()
                """.trimIndent())
                val deadline = SystemClock.elapsedRealtime() + 180_000
                var state = JSONObject()
                var previous = ""
                while (SystemClock.elapsedRealtime() < deadline) {
                    state = evaluate(webView, "window.__envConformance ?? {}")
                    val progress = state.optJSONObject("progress")
                    val current = "${progress?.optInt("completed")}/${progress?.optInt("total")}: ${progress?.optString("current")}"
                    if (current != previous) { println("ExecutionEnv conformance: $current"); previous = current }
                    if (!state.optBoolean("running", true)) break
                    SystemClock.sleep(250)
                }
                assertFalse("Conformance did not finish within 180 seconds: $state", state.optBoolean("running", true))
                assertFalse("Conformance runner failed: $state", state.has("fatal"))
                val report = state.getJSONObject("result")
                println("ExecutionEnv conformance report: ${report.toString(2)}")
                assertTrue("The upstream suite must contain cases", report.getInt("total") > 0)
                assertEquals("Every upstream case must be recorded", report.getInt("total"), report.getJSONArray("cases").length())
                assertEquals("No upstream case may be silently skipped", 0, report.getInt("skipped"))
                assertEquals("Upstream environment conformance failures: $report", 0, report.getInt("failed"))
                assertEquals(report.getInt("total"), report.getInt("passed"))
            } finally {
                instrumentation.runOnMainSync {
                    host.close()
                    (webView.parent as? ViewGroup)?.removeView(webView)
                    webView.stopLoading()
                    WebViewCompat.removeWebMessageListener(webView, "PiNative")
                    webView.destroy()
                }
            }
        }
    }

    private fun evaluate(view: WebView, script: String): JSONObject {
        val result = CompletableFuture<String>()
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { result.complete(it) } }
        return JSONObject(result.get(10, TimeUnit.SECONDS))
    }

    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", HEADERS, ByteArrayInputStream(ByteArray(0)))

    companion object {
        private const val PAGE = "${MainActivity.ORIGIN}/assets/web/env-test.html"
        private val HEADERS = mapOf(
            "Content-Security-Policy" to "default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'; frame-src 'none'",
            "X-Content-Type-Options" to "nosniff",
            "Cache-Control" to "no-store",
        )
    }
}
