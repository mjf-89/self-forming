package md.incept.selfforming

import android.content.Context
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.graphics.Insets
import androidx.core.view.DisplayCutoutCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Typed synthetic IME insets require API 30; real keyboard interaction is a separate device check. */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 30)
class WebViewInsetsTest {
    @Test fun keyboardResizesTheWebViewAndHidingItRestoresTheSafeViewport() = withWebView { container, webView ->
        val handled = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
        var notifications = 0
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, childInsets ->
            notifications++
            assertEquals(Insets.NONE, childInsets.getInsets(handled))
            assertNull(childInsets.displayCutout)
            childInsets
        }
        @Suppress("DEPRECATION")
        val cutout = DisplayCutoutCompat(Rect(0, 120, 0, 0), listOf(Rect(440, 0, 640, 120)))
        fun insets(keyboard: Int): WindowInsetsCompat = WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, 72, 0, 0))
            .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, 96))
            .setDisplayCutout(cutout)
            .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, keyboard))
            .build()

        applyAndLayout(container, insets(0), 1080, 2400)
        assertEquals(120, webView.top)
        assertEquals(2184, webView.height)
        val initialNotifications = notifications
        assertTrue(initialNotifications > 0)

        applyAndLayout(container, insets(800), 1080, 2400)
        assertEquals(800, container.paddingBottom) // max(96, 800), not their sum.
        assertEquals(1480, webView.height)
        assertEquals(1600, webView.bottom)

        applyAndLayout(container, insets(0), 1080, 2400)
        assertEquals(96, container.paddingBottom)
        assertEquals(2184, webView.height)
        assertEquals(initialNotifications + 2, notifications)
        assertEquals(0, webView.paddingLeft)
        assertEquals(0, webView.paddingTop)
        assertEquals(0, webView.paddingRight)
        assertEquals(0, webView.paddingBottom)
    }

    @Test fun landscapeCutoutAndSideNavigationReduceTheActualWebViewWidth() = withWebView { container, webView ->
        @Suppress("DEPRECATION")
        val cutout = DisplayCutoutCompat(Rect(84, 0, 0, 0), listOf(Rect(0, 440, 84, 640)))
        val insets = WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, 32, 0, 0))
            .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 48, 0))
            .setDisplayCutout(cutout)
            .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 400))
            .build()
        applyAndLayout(container, insets, 2400, 1080)
        assertEquals(84, webView.left)
        assertEquals(2352, webView.right)
        assertEquals(2268, webView.width)
        assertEquals(32, webView.top)
        assertEquals(680, webView.bottom)
        assertEquals(648, webView.height)
    }

    private fun applyAndLayout(container: FrameLayout, insets: WindowInsetsCompat, width: Int, height: Int) {
        ViewCompat.dispatchApplyWindowInsets(container, insets)
        container.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        container.layout(0, 0, width, height)
    }

    private fun withWebView(test: (FrameLayout, WebView) -> Unit) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val context = ApplicationProvider.getApplicationContext<Context>()
            val container = FrameLayout(context)
            val webView = WebView(context)
            WebViewInsets.install(container)
            container.addView(webView, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            try { test(container, webView) }
            finally { container.removeAllViews(); webView.destroy() }
        }
    }
}
