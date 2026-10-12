package md.incept.selfforming

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.File
import org.json.JSONObject

class MainActivity : Activity() {
    private var webView: WebView? = null
    private var bridge: NativeBridge? = null
    private var fileChooser: WebFileChooser? = null
    private var appStore: WebAppStore? = null
    @Volatile private var documentRevision = WebAppStore.ORIGINAL
    private val main = Handler(Looper.getMainLooper())
    private var foreground = false
    private var notificationsRequested = false
    private var watchdogRevision: String? = null
    private var watchdogRemaining = STARTUP_TIMEOUT_MS
    private var watchdogStarted = 0L
    private val watchdog = Runnable {
        watchdogStarted = 0
        val store = appStore
        if (foreground && store != null && store.info().revision == documentRevision && store.recoverPending()) {
            reloadApp()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        window.apply {
            statusBarColor = Color.TRANSPARENT
            navigationBarColor = Color.TRANSPARENT
        }
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showError("Update Android System WebView to use Self Forming.")
            return
        }
        appStore = AppStoreProvider.get(this)
        SelfSource.installAsync(this)
        documentRevision = appStore?.info()?.revision ?: WebAppStore.ORIGINAL
        val view = WebView(this)
        view.setBackgroundColor(Color.parseColor("#F6F6F3")) // paper, so there is no white flash before the page paints
        val host = NativeBridge(applicationContext, appStore, onExecutionStart = { requestExecutionNotification() }) { updateWatchdog() }
        host.onBackHandler = { enabled -> setPageBack(enabled) }
        webView = view
        bridge = host
        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            // Local HTTP previews are embedded under the HTTPS asset origin.
            // CSP and request checks below still restrict them to loopback.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = true
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // Keep agent replies running while other apps are in front.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        // Fingerprint prompts for secrets (also those a Linux helper or an agent command asked for): only while in front.
        SecretStore.promptRequester = { request, callback ->
            main.post { if (foreground) SecretPrompt.show(this, request, callback) else callback(SecretPrompter.NOT_FOREGROUND) }
        }
        WebViewCompat.addWebMessageListener(view, "PiNative", setOf(ORIGIN)) { _, message, origin, mainFrame, reply ->
            if (mainFrame && allowedOrigin(origin) && message.type == WebMessageCompat.TYPE_STRING) {
                message.data?.let { host.receive(it, reply) }
            }
        }
        val chooser = WebFileChooser(
            launch = { intent ->
                @Suppress("DEPRECATION")
                startActivityForResult(intent, FILE_CHOOSER_REQUEST)
            },
            hasReadGrant = { uri -> checkUriPermission(uri, Process.myPid(), Process.myUid(),
                Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED },
            documentIsCurrent = { webView === view && !isFinishing && !isDestroyed &&
                view.url?.let { allowedPage(Uri.parse(it)) } == true },
        )
        fileChooser = chooser
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams): Boolean {
                if (!foreground || webView !== view) {
                    callback.onReceiveValue(null)
                    return true
                }
                return chooser.show(callback, params)
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.isForMainFrame && request.hasGesture() && openExternalLink(request.url)) return true
                return !((request.isForMainFrame && allowedPage(request.url)) || (!request.isForMainFrame && allowedLoopback(request.url)))
            }

            @Deprecated("Legacy WebView callback")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                openExternalLink(Uri.parse(url)) || !allowedPage(Uri.parse(url))

            /**
             * A link the user tapped to any http(s) website (chat links, the welcome credit, the SDK License): open it in the
             * default browser. The WebView itself never navigates away from the app page; the app's own origin stays inside.
             */
            private fun openExternalLink(uri: Uri): Boolean {
                if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrEmpty() || allowedOrigin(uri)) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (_: Exception) {}
                return true
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                // Origin is browser-controlled for CORS requests. A local preview cannot
                // acquire this permission by being inside the app's WebView.
                val origin = request.requestHeaders.entries.firstOrNull { it.key.equals("origin", ignoreCase = true) }?.value
                if (!request.isForMainFrame && BrowserConnections.allowed(request.url.toString(), request.method, origin)) return null
                // Local pages stay in child frames. Never grant them the app origin
                // or PiNative bridge; the message listener remains main-frame-only.
                if (!request.isForMainFrame && allowedLoopback(request.url)) return null
                if (!allowedAsset(request.url) || request.method != "GET") return forbidden()
                // Activation changes the next document. Existing modules keep reading their pinned
                // revision until the main document is requested again.
                if (request.isForMainFrame && allowedPage(request.url)) documentRevision = appStore?.info()?.revision ?: WebAppStore.ORIGINAL
                val response = try {
                    val store = appStore
                    if (store == null) loader.shouldInterceptRequest(request.url) else {
                        val name = request.url.path!!.removePrefix("/assets/web/")
                        store.open(name, documentRevision)?.let { input -> WebResourceResponse(mimeType(name), "UTF-8", input) }
                    }
                } catch (_: Exception) { null } ?: return forbidden()
                response.responseHeaders = (response.responseHeaders ?: emptyMap()) + mapOf(
                    "Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
                        "img-src 'self' data:; font-src 'self'; " +
                        "connect-src https://api.openai.com https://api.anthropic.com http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; " +
                        "frame-src http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*; " +
                        "base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
                    "X-Content-Type-Options" to "nosniff",
                    "Referrer-Policy" to "no-referrer",
                    "Cache-Control" to "no-store",
                )
                return response
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                chooser.cancelDocument()
                host.reset()
                documentRevision = appStore?.info()?.revision ?: WebAppStore.ORIGINAL
                updateWatchdog()
                if (!allowedPage(Uri.parse(url))) {
                    view.stopLoading()
                    host.close()
                    showError("Navigation outside the app was blocked.")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                chooser.close()
                host.close()
                showError("The app renderer stopped. Reopen Self Forming, or restore a version from Android Settings, to resume saved work.")
                view.destroy()
                webView = null
                bridge = null
                return true
            }
        }
        view.setDownloadListener { _, _, _, _, _ -> /* No native downloads in this capability surface. */ }
        showContent(view)
        view.loadUrl("$ORIGIN/assets/web/index.html")
    }

    private fun showContent(content: View) {
        val container = FrameLayout(this)
        WebViewInsets.install(container)
        // No recovery bar: recovery lives in Android Settings (SettingsActivity).
        container.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(container)
        container.post { ViewCompat.requestApplyInsets(container) }
    }

    private fun showError(message: String) {
        showContent(TextView(this).apply { text = message; textSize = 18f; setPadding(32, 64, 32, 32) })
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        SecretPrompter.setForeground(true)
        bridge?.setForeground(true)
        // A restore from Android Settings changes the active revision while we were stopped.
        val active = appStore?.info()?.revision
        if (active != null && webView != null && active != documentRevision) reloadApp()
        updateWatchdog()
    }

    private fun requestExecutionNotification() {
        if (Build.VERSION.SDK_INT < 33 || notificationsRequested || !foreground) return
        notificationsRequested = true
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 301)
    }

    override fun onStop() {
        foreground = false
        SecretPrompter.setForeground(false)
        pauseWatchdog()
        bridge?.setForeground(false)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // A "Unlock ... for ..." notification tap: show the waiting fingerprint prompt.
        main.post { SecretPrompter.activityResumed() }
        // The callback page/notification only brings the existing task forward.
        // Never reload the WebView or take auth data from external intents.
    }

    @Deprecated("Activity result callback is used without an additional Activity dependency")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_REQUEST) fileChooser?.receive(resultCode, data)
        else super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onResume() {
        super.onResume()
        // A secret request may be waiting for the app to come forward (see SecretPrompter).
        main.post { SecretPrompter.activityResumed() }
    }

    // ---------- Android back for the page (closing the conversations drawer) ----------
    private var pageWantsBack = false
    private var backCallback: Any? = null // android.window.OnBackInvokedCallback on API 33+

    private fun setPageBack(enabled: Boolean) {
        pageWantsBack = enabled
        if (Build.VERSION.SDK_INT >= 33) {
            val dispatcher = onBackInvokedDispatcher
            val existing = backCallback as? android.window.OnBackInvokedCallback
            if (enabled && existing == null) {
                val callback = android.window.OnBackInvokedCallback { bridge?.dispatchBack() }
                dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
                backCallback = callback
            } else if (!enabled && existing != null) {
                dispatcher.unregisterOnBackInvokedCallback(existing)
                backCallback = null
            }
        }
    }

    @Deprecated("Back before Android 13; newer versions use the OnBackInvokedCallback above")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (pageWantsBack) bridge?.dispatchBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        main.removeCallbacks(watchdog)
        SecretPrompter.setForeground(false)
        SecretStore.promptRequester = null
        SecretPrompt.cancel()
        fileChooser?.close()
        fileChooser = null
        bridge?.close()
        webView?.apply { (parent as? ViewGroup)?.removeView(this); stopLoading(); destroy() }
        bridge = null
        webView = null
        super.onDestroy()
    }

    private fun pauseWatchdog() {
        main.removeCallbacks(watchdog)
        if (watchdogStarted != 0L) {
            watchdogRemaining = (watchdogRemaining - (SystemClock.elapsedRealtime() - watchdogStarted)).coerceAtLeast(0)
            watchdogStarted = 0
        }
    }

    private fun updateWatchdog() {
        val info = appStore?.info()
        if (info == null || !info.pending || info.revision != documentRevision) {
            pauseWatchdog(); watchdogRevision = null; watchdogRemaining = STARTUP_TIMEOUT_MS
            return
        }
        if (watchdogRevision != documentRevision) {
            pauseWatchdog(); watchdogRevision = documentRevision; watchdogRemaining = STARTUP_TIMEOUT_MS
        }
        if (foreground && watchdogStarted == 0L) {
            watchdogStarted = SystemClock.elapsedRealtime()
            main.postDelayed(watchdog, watchdogRemaining)
        }
    }

    private fun reloadApp() {
        fileChooser?.cancelDocument()
        pauseWatchdog()
        documentRevision = appStore?.info()?.revision ?: WebAppStore.ORIGINAL
        val view = webView
        if (view != null) view.loadUrl("$ORIGIN/assets/web/index.html") else recreate()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun mimeType(name: String): String = when (name.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "application/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "woff2" -> "font/woff2"
        "ttf" -> "font/ttf"
        "otf" -> "font/otf"
        "woff" -> "font/woff"
        "txt", "md" -> "text/plain"
        else -> "application/octet-stream"
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        private const val STARTUP_TIMEOUT_MS = 30_000L
        private const val FILE_CHOOSER_REQUEST = 302
        fun allowedOrigin(uri: Uri): Boolean = uri.scheme == "https" && uri.host == HOST &&
            (uri.port == -1 || uri.port == 443) && uri.userInfo == null
        /** Exact names only: no LAN addresses, credentials or lookalike domains. */
        internal fun allowedLoopback(uri: Uri): Boolean =
            uri.scheme in setOf("http", "https") &&
                uri.host in setOf("localhost", "127.0.0.1") &&
                uri.userInfo == null && (uri.port == -1 || uri.port in 1..65535)
        private fun allowedAsset(uri: Uri): Boolean = allowedOrigin(uri) && uri.path?.startsWith("/assets/web/") == true
        private fun allowedPage(uri: Uri): Boolean = allowedOrigin(uri) && uri.path == "/assets/web/index.html"
        private fun forbidden(): WebResourceResponse = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
            emptyMap(), ByteArrayInputStream("Blocked".toByteArray()))
    }
}
