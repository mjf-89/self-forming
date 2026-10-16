package md.incept.selfforming

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Opened from Android Settings → Apps → Self Forming → gear (APPLICATION_PREFERENCES).
 * Holds recovery so it never clutters the app itself. Restores only the app's interface
 * and agent code; conversations, sign-in and workspace files are kept.
 */
class SettingsActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var previous: Button
    private lateinit var original: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Self Forming settings"
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(24))
        }
        column.addView(heading("App recovery"))
        column.addView(body("Self Forming reshapes itself as you chat. If a change breaks the app, restore an earlier version here. " +
            "Your conversations, sign-in and files are kept; only the app's interface and agent code are restored."))
        status = body("").apply { setTypeface(Typeface.MONOSPACE); textSize = 13f }
        column.addView(status)
        previous = action("Restore previous version") { confirm(true) }
        original = action("Restore original app") { confirm(false) }
        column.addView(previous); column.addView(original)
        // Built-in halves add their own recovery (e.g. core-plugin-management: "Disable all plugins").
        BuiltinNatives.ALL.flatMap { it.recoveryActions() }.forEach { recovery -> column.addView(action(recovery.label) { recovery.run(this) }) }
        column.addView(action("Open Self Forming") {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            finish()
        })
        val scroll = ScrollView(this).apply { addView(column) }
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
        setContentView(scroll)
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun refresh() {
        val store = AppStoreProvider.get(this)
        val info = store?.info()
        status.text = when {
            info == null -> AppStoreProvider.error ?: "App versions are unavailable."
            info.revision == WebAppStore.ORIGINAL -> "Current: original app" + (info.notice?.let { "\n$it" } ?: "")
            else -> "Current: ${info.revision}" + (info.previousRevision?.let { "\nPrevious: ${if (it == WebAppStore.ORIGINAL) "original app" else it}" } ?: "") +
                (info.notice?.let { "\n$it" } ?: "")
        }
        previous.isEnabled = info?.previousRevision != null
        original.isEnabled = info != null && info.revision != WebAppStore.ORIGINAL
    }

    private fun confirm(toPrevious: Boolean) {
        val what = if (toPrevious) "the previous version" else "the original app"
        AlertDialog.Builder(this).setTitle("Restore $what?")
            .setMessage("Self Forming will reload with $what. Conversations, sign-in and files are kept. Edited source files stay in the workspace.")
            .setPositiveButton("Restore") { _, _ -> restore(toPrevious) }
            .setNegativeButton("Cancel", null).show()
    }

    private fun restore(toPrevious: Boolean) {
        try {
            // MainActivity compares the active revision on its next start and reloads.
            AppStoreProvider.get(this)?.restore(toPrevious, "The app was restored from Android Settings. Edited source files were kept.")
                ?: throw IllegalStateException(AppStoreProvider.error ?: "App versions are unavailable.")
            refresh()
            AlertDialog.Builder(this).setTitle("Restored").setMessage("Open Self Forming to use the restored version.")
                .setPositiveButton("OK", null).show()
        } catch (error: Exception) {
            AlertDialog.Builder(this).setTitle("Could not restore").setMessage(error.message).setPositiveButton("OK", null).show()
        }
    }

    private fun heading(text: String) = TextView(this).apply {
        this.text = text; textSize = 20f; setTypeface(typeface, Typeface.BOLD); setPadding(0, dp(8), 0, dp(8))
    }
    private fun body(text: String) = TextView(this).apply { this.text = text; textSize = 15f; setPadding(0, 0, 0, dp(16)) }
    private fun action(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; gravity = Gravity.CENTER
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) }
        setOnClickListener { onClick() }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
