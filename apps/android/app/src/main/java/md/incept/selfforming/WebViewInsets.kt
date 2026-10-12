package md.incept.selfforming

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Own safe-area and keyboard spacing in the native parent, so the WebView viewport really resizes. */
internal object WebViewInsets {
    private val safeAreaTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    private val handledTypes = safeAreaTypes or WindowInsetsCompat.Type.ime()

    fun install(container: View) {
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, windowInsets ->
            // getInsets unions the types using the maximum on each edge. The keyboard
            // already includes the navigation-bar area, so these must never be added.
            val safe = windowInsets.getInsets(handledTypes)
            if (view.paddingLeft != safe.left || view.paddingTop != safe.top ||
                view.paddingRight != safe.right || view.paddingBottom != safe.bottom) {
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            }

            // Keep dispatching updates, including keyboard hide, with handled dimensions
            // zeroed. CONSUMED would stop WebView notifications and can leave stale padding.
            WindowInsetsCompat.Builder(windowInsets)
                .setInsets(handledTypes, Insets.NONE)
                .setInsetsIgnoringVisibility(safeAreaTypes, Insets.NONE)
                .setDisplayCutout(null)
                .build()
        }
    }
}
