package md.incept.selfforming

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import java.util.Locale

/** One system picker belongs to one WebView document. All calls run on the UI thread. */
internal class WebFileChooser(
    private val launch: (Intent) -> Unit,
    private val hasReadGrant: (Uri) -> Boolean,
    private val documentIsCurrent: () -> Boolean,
) {
    private data class Request(val callback: ValueCallback<Array<Uri>>, val multiple: Boolean)
    private var pending: Request? = null
    private var pickerInFlight = false
    private var closed = false

    fun show(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        if (closed || pickerInFlight || !documentIsCurrent() ||
            (params.mode != FileChooserParams.MODE_OPEN && params.mode != FileChooserParams.MODE_OPEN_MULTIPLE)) {
            callback.onReceiveValue(null)
            return true
        }
        val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
        val types = acceptedTypes(params.acceptTypes)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = types.singleOrNull() ?: "*/*"
            if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        pending = Request(callback, multiple)
        pickerInFlight = true
        try {
            launch(intent)
        } catch (_: ActivityNotFoundException) {
            pickerInFlight = false
            cancelDocument()
        } catch (_: SecurityException) {
            pickerInFlight = false
            cancelDocument()
        }
        return true
    }

    fun receive(resultCode: Int, data: Intent?) {
        if (!pickerInFlight) return
        pickerInFlight = false
        val request = pending ?: return
        pending = null
        val selection = if (!closed && documentIsCurrent() && resultCode == Activity.RESULT_OK && data != null) {
            selectedUris(data, request.multiple)
        } else null
        request.callback.onReceiveValue(selection)
    }

    /** Do not call this onStop: showing the picker normally backgrounds the Activity. */
    fun cancelDocument() {
        val request = pending
        pending = null
        request?.callback?.onReceiveValue(null)
        // Keep the launch reserved until its result arrives, even if the page has changed.
        // Otherwise that stale result could complete a new page's file input.
    }

    fun close() {
        closed = true
        cancelDocument()
    }

    private fun selectedUris(data: Intent, multiple: Boolean): Array<Uri>? {
        return try {
            val uris = linkedSetOf<Uri>()
            val clip = data.clipData
            if (clip != null) {
                for (index in 0 until clip.itemCount) {
                    val uri = clip.getItemAt(index).uri ?: return null
                    uris.add(uri)
                }
            } else data.data?.let { uris.add(it) }
            // Never hand WebView arbitrary paths or app-private content from a picker result.
            // checkUriPermission checks an explicit grant, not the app's general provider access.
            if (uris.isEmpty() || (!multiple && uris.size != 1) || uris.any {
                it.scheme != "content" || it.authority.isNullOrBlank() || !hasReadGrant(it)
            }) null else uris.toTypedArray()
        } catch (_: RuntimeException) { null }
    }

    private fun acceptedTypes(accept: Array<String>): List<String> {
        val types = accept.flatMap { it.split(',') }.mapNotNull { value ->
            val normalized = value.trim().lowercase(Locale.ROOT)
            if (normalized.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(normalized.drop(1))
            else normalized.takeIf { MIME.matches(it) }
        }.distinct()
        return if (types.isEmpty() || "*/*" in types) listOf("*/*") else types
    }

    private companion object {
        val MIME = Regex("(?:[a-z0-9!#$&^_.+-]+/(?:[a-z0-9!#$&^_.+-]+|\\*)|\\*/\\*)")
    }
}
