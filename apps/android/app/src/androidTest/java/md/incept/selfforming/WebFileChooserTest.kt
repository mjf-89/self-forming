package md.incept.selfforming

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** System-picker contract tests; no real document, storage permission, or account is used. */
@RunWith(AndroidJUnit4::class)
class WebFileChooserTest {
    private val first = Uri.parse("content://test.documents/document/first")
    private val second = Uri.parse("content://test.documents/document/second")

    @Test fun multipleFilesUseReadOnlyDocumentPickerAndReturnDistinctUris() {
        var launched: Intent? = null
        val replies = Replies()
        val chooser = WebFileChooser({ launched = it }, { true }, { true })
        assertTrue(chooser.show(replies, params(FileChooserParams.MODE_OPEN_MULTIPLE,
            arrayOf("image/png,image/jpeg", " image/png "))))
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, launched!!.action)
        assertTrue(launched!!.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("*/*", launched!!.type)
        assertArrayEquals(arrayOf("image/png", "image/jpeg"), launched!!.getStringArrayExtra(Intent.EXTRA_MIME_TYPES))
        assertTrue(launched!!.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, launched!!.flags)
        assertTrue(replies.values.isEmpty()) // Starting another Activity must not cancel the callback.
        chooser.receive(Activity.RESULT_OK, selected(first, second, first))
        assertEquals(listOf(listOf(first, second)), replies.values)
        chooser.receive(Activity.RESULT_OK, selected(second))
        assertEquals(1, replies.values.size)
    }

    @Test fun acceptFiltersSupportWildcardsExtensionsAndUnrestrictedInputs() {
        for ((accept, expected) in listOf(
            arrayOf("image/*") to "image/*",
            arrayOf(".png") to "image/png",
            emptyArray<String>() to "*/*",
            arrayOf("", "invalid value") to "*/*",
            arrayOf("image/png", "*/*") to "*/*",
        )) {
            var launched: Intent? = null
            val chooser = WebFileChooser({ launched = it }, { true }, { true })
            chooser.show(Replies(), params(accept = accept))
            assertEquals(expected, launched!!.type)
            assertFalse(launched!!.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true))
            chooser.close()
        }
    }

    @Test fun navigationCancelsOnceAndAnOldResultCannotFillTheNewDocument() {
        var launches = 0
        val chooser = WebFileChooser({ launches++ }, { true }, { true })
        val old = Replies()
        chooser.show(old, params())
        chooser.cancelDocument()
        chooser.cancelDocument()
        assertEquals(listOf<List<Uri>?>(null), old.values)
        val blocked = Replies()
        chooser.show(blocked, params())
        assertEquals(listOf<List<Uri>?>(null), blocked.values)
        assertEquals(1, launches)
        chooser.receive(Activity.RESULT_OK, selected(first))
        assertEquals(1, old.values.size)
        val fresh = Replies()
        chooser.show(fresh, params())
        chooser.receive(Activity.RESULT_OK, selected(second))
        assertEquals(listOf(listOf(second)), fresh.values)
        assertEquals(2, launches)
    }

    @Test fun cancellationCloseAndMissingPickerAlwaysSettleTheCallback() {
        val replies = Replies()
        val chooser = WebFileChooser({}, { true }, { true })
        chooser.show(replies, params())
        chooser.receive(Activity.RESULT_CANCELED, selected(first))
        assertEquals(listOf<List<Uri>?>(null), replies.values)
        val destroyed = Replies()
        chooser.show(destroyed, params())
        chooser.close()
        chooser.receive(Activity.RESULT_OK, selected(first))
        assertEquals(listOf<List<Uri>?>(null), destroyed.values)
        val afterClose = Replies()
        chooser.show(afterClose, params())
        assertEquals(listOf<List<Uri>?>(null), afterClose.values)
        val missing = Replies()
        WebFileChooser({ throw ActivityNotFoundException() }, { true }, { true }).show(missing, params())
        assertEquals(listOf<List<Uri>?>(null), missing.values)
    }

    @Test fun unsafeOrUngrantedUrisAndUnexpectedMultipleSelectionAreRejected() {
        for (selection in listOf(selected(Uri.parse("file:///data/private")),
            selected(Uri.parse("https://example.test/image.png")), selected(second), selected(first, second), Intent())) {
            val replies = Replies()
            val chooser = WebFileChooser({}, { it == first }, { true })
            chooser.show(replies, params())
            chooser.receive(Activity.RESULT_OK, selection)
            assertEquals(listOf<List<Uri>?>(null), replies.values)
        }
    }

    @Test fun untrustedDocumentAndSaveRequestsNeverLaunchOrReceiveFiles() {
        var trusted = false
        var launches = 0
        val chooser = WebFileChooser({ launches++ }, { true }, { trusted })
        val replies = Replies()
        chooser.show(replies, params())
        assertEquals(0, launches)
        assertEquals(listOf<List<Uri>?>(null), replies.values)
        trusted = true
        chooser.show(Replies(), params(FileChooserParams.MODE_SAVE))
        assertEquals(0, launches)
        val changed = Replies()
        chooser.show(changed, params())
        trusted = false
        chooser.receive(Activity.RESULT_OK, selected(first))
        assertEquals(listOf<List<Uri>?>(null), changed.values)
    }

    private class Replies : ValueCallback<Array<Uri>> {
        val values = mutableListOf<List<Uri>?>()
        override fun onReceiveValue(value: Array<Uri>?) { values.add(value?.toList()) }
    }

    private fun selected(vararg uris: Uri): Intent = Intent().apply {
        if (uris.size == 1) data = uris[0]
        else clipData = ClipData.newRawUri("Test files", uris[0]).apply {
            uris.drop(1).forEach { addItem(ClipData.Item(it)) }
        }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private fun params(mode: Int = FileChooserParams.MODE_OPEN, accept: Array<String> = emptyArray()): FileChooserParams =
        object : FileChooserParams() {
            override fun getMode(): Int = mode
            override fun getAcceptTypes(): Array<String> = accept
            override fun isCaptureEnabled(): Boolean = false
            override fun getTitle(): CharSequence? = null
            override fun getFilenameHint(): String? = null
            override fun createIntent(): Intent = Intent()
        }
}
