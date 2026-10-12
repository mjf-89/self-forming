package md.incept.selfforming

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NativeAuthStoreTest {
    @Test fun signingOutOfOneProviderDoesNotInvalidateTheOtherProvider() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val suffix = UUID.randomUUID().toString()
        val directory = File(context.noBackupFilesDir, "provider-auth-test-$suffix")
        val first = AuthStore(File(directory, "chatgpt"), "md.incept.selfforming.test.$suffix.chatgpt")
        val second = AuthStore(File(directory, "claude"), "md.incept.selfforming.test.$suffix.claude")
        try {
            first.save(JSONObject().put("accessToken", "dummy-chatgpt"))
            second.save(JSONObject().put("accessToken", "dummy-claude"))
            assertEquals("dummy-chatgpt", first.load()!!.getString("accessToken"))
            assertEquals("dummy-claude", second.load()!!.getString("accessToken"))
            first.clear()
            assertNull(first.load())
            assertEquals("dummy-claude", second.load()!!.getString("accessToken"))
            first.save(JSONObject().put("accessToken", "dummy-chatgpt-again"))
            second.clear()
            assertEquals("dummy-chatgpt-again", first.load()!!.getString("accessToken"))
        } finally {
            first.clear(); second.clear()
            directory.deleteRecursively()
        }
    }

    @Test fun encryptsCredentialsRejectsTamperingAndKeepsHostIdOnSignOut() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val suffix = UUID.randomUUID().toString()
        val directory = File(context.noBackupFilesDir, "auth-test-$suffix")
        val alias = "md.incept.selfforming.test.$suffix"
        val store = AuthStore(directory, alias)
        try {
            val hostId = store.hostId()
            assertTrue(hostId.startsWith("urn:uuid:"))
            assertEquals(hostId, AuthStore(directory, alias).hostId())
            assertNull(store.load())
            store.save(JSONObject().put("accessToken", "test-secret-access-token"))
            val encryptedFile = File(directory, "credentials.aesgcm")
            val encrypted = encryptedFile.readBytes()
            assertFalse(encrypted.toString(Charsets.UTF_8).contains("test-secret-access-token"))
            assertEquals("test-secret-access-token", AuthStore(directory, alias).load()!!.getString("accessToken"))
            encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
            encryptedFile.writeBytes(encrypted)
            assertEquals("AUTH_STORAGE", assertThrows(HostFailure::class.java) { store.load() }.code)
            store.clear()
            assertNull(store.load())
            assertEquals(hostId, store.hostId())
            assertEquals("AUTH_TOO_LARGE", assertThrows(HostFailure::class.java) {
                store.save(JSONObject().put("oversize", "x".repeat(65_537)))
            }.code)
        } finally {
            store.clear()
            directory.deleteRecursively()
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
        }
    }
}
