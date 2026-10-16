package md.incept.selfforming

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The shared credential store (host, X5): one AES-GCM record per provider or plugin credential, each with its own
 * Android Keystore key ([keyAlias]). Authentication records never enter SQLite, workspace files, browser storage or logs.
 */
internal class AuthStore(private val directory: File, private val keyAlias: String) {
    private val recordFile get() = AtomicFile(File(directory, "credentials.aesgcm"))
    private val hostFile get() = AtomicFile(File(directory, "host-id"))

    fun hostId(): String = synchronized(lock) {
        guard {
            ensureDirectory()
            if (exists(hostFile)) {
                val saved = hostFile.openRead().use { input ->
                    val buffer = ByteArray(128)
                    var count = 0
                    while (count < buffer.size) {
                        val read = input.read(buffer, count, buffer.size - count)
                        if (read == -1) break
                        count += read
                    }
                    if (count <= 0 || count == buffer.size) invalid()
                    String(buffer, 0, count, Charsets.US_ASCII)
                }
                if (!Regex("urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(saved)) invalid()
                saved
            } else {
                val created = "urn:uuid:${UUID.randomUUID()}"
                write(hostFile, created.toByteArray(Charsets.US_ASCII))
                created
            }
        }
    }

    fun load(): JSONObject? = synchronized(lock) {
        guard {
            if (!exists(recordFile)) return@guard null
            val encrypted = recordFile.openRead().use { input ->
                val buffer = ByteArray(MAX_AUTH_BYTES + 128)
                var count = 0
                while (count < buffer.size) {
                    val read = input.read(buffer, count, buffer.size - count)
                    if (read == -1) break
                    count += read
                }
                if (count == buffer.size || count < MAGIC.size + 12 + 16) invalid()
                buffer.copyOf(count)
            }
            if (!encrypted.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) invalid()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, encrypted.copyOfRange(MAGIC.size, MAGIC.size + 12)))
            cipher.updateAAD(MAGIC)
            val plaintext = cipher.doFinal(encrypted, MAGIC.size + 12, encrypted.size - MAGIC.size - 12)
            if (plaintext.size > MAX_AUTH_BYTES) invalid()
            JSONObject(plaintext.toString(Charsets.UTF_8))
        }
    }

    fun save(record: JSONObject) = synchronized(lock) {
        val plaintext = record.toString().toByteArray(Charsets.UTF_8)
        if (plaintext.size > MAX_AUTH_BYTES) throw HostFailure("AUTH_TOO_LARGE", "Saved sign-in record exceeds 64 KiB")
        guard {
            ensureDirectory()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
            cipher.updateAAD(MAGIC)
            if (cipher.iv.size != 12) invalid()
            write(recordFile, MAGIC + cipher.iv + cipher.doFinal(plaintext))
        }
    }

    /** Whether a record file exists (it may still fail to decrypt). */
    fun saved(): Boolean = synchronized(lock) { exists(recordFile) }

    fun clear() = synchronized(lock) { guard {
        recordFile.delete()
        if (exists(recordFile)) invalid()
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(keyAlias) }
    } }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        if (!create) invalid()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }

    private fun ensureDirectory() {
        if (!directory.isDirectory && !directory.mkdirs()) invalid()
    }

    // Older Android AtomicFile uses .bak; openRead restores it after an interrupted write.
    private fun exists(file: AtomicFile): Boolean = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()

    private fun write(file: AtomicFile, bytes: ByteArray) {
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }

    private fun <T> guard(operation: () -> T): T = try { operation() }
        catch (error: HostFailure) { throw error }
        catch (_: Exception) { invalid() }

    private fun invalid(): Nothing = throw HostFailure("AUTH_STORAGE", "Saved sign-in data is unavailable; clear it and sign in again")

    companion object {
        private val lock = Any()
        private const val MAX_AUTH_BYTES = 64 * 1024
        private val MAGIC = "PIAUTH01".toByteArray(Charsets.US_ASCII)
    }
}
