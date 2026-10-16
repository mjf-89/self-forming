package md.incept.selfforming

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * User secrets for commands. Values are AES-256-GCM encrypted with non-exportable Android Keystore keys:
 * "sf-secrets" (no authentication), "sf-secrets-bio" (needs a fingerprint/screen-lock unlock, valid for 30
 * minutes) and "sf-secrets-ask" (needs a strong-biometric authentication for every single use).
 * Ciphertext, IV and metadata live in noBackupFilesDir/secrets.json. Plaintext exists only briefly in
 * native memory and in the environment of the processes it is injected into or handed to through the
 * secret broker; it is never returned to JavaScript, logged, or put into an exception message.
 */
object SecretStore {
    /** Marker environment variable from the page: names the scope (agent|terminal|servers). Never exported. */
    const val SCOPE_VARIABLE = SECRET_SCOPE_VARIABLE
    private const val KEY_PLAIN = "sf-secrets"
    private const val KEY_BIO = "sf-secrets-bio"
    private const val KEY_ASK = "sf-secrets-ask"
    private const val UNLOCK_SECONDS = 1800
    private const val MAX_VALUE_BYTES = 16 * 1024
    private const val MAX_SECRETS = 64
    private const val FILE = "secrets.json"
    private const val AGENT_LABEL = "Your AI agent's command"
    private const val AGENT_WAIT_MS = 60_000L
    private const val SETTINGS_WAIT_MS = 120_000L
    private val NAME = Regex("[A-Z_][A-Z0-9_]{0,63}")
    private val RESERVED = setOf("PATH", "HOME", "TMPDIR", "SHELL", "USER", "LANG", "TERM")
    private val RESERVED_PREFIXES = listOf("LD_", "PROOT_", "PI_", "BOX64_", "SF_SECRETS_")

    /** MainActivity: show the system prompt. The callback gets null on success, otherwise a user-facing reason
     * (or a [SecretPrompter] sentinel when the system interrupted the prompt / the activity is not in front). */
    @Volatile internal var promptRequester: ((request: PromptRequest, callback: (String?) -> Unit) -> Unit)? = null

    private val io = Executors.newSingleThreadExecutor { Thread(it, "pi-secrets") }
    private val lock = Any()
    @Volatile private var app: Context? = null
    @Volatile private var unlockedUntilMs = 0L
    // Short-lived decrypted copy of every redact=true secret readable without a prompt (the redaction safety net).
    // Ask-every-time secrets are never part of it.
    private const val NET_SECONDS = 60L
    private val cacheLock = Any()
    private var netCache: List<Pair<String, ByteArray>>? = null
    private var netTimer: java.util.concurrent.ScheduledFuture<*>? = null
    private var netGeneration = 0L
    private val timer = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { Thread(it, "pi-secrets-cache").apply { isDaemon = true } }
    // Redactions of the commands that are running now: values the broker hands out are added to them.
    private val live: MutableSet<Redaction> = Collections.newSetFromMap(ConcurrentHashMap())

    private class Entry(val name: String, val agent: Boolean, val terminal: Boolean, val servers: Boolean,
                        val redact: Boolean, val biometric: Boolean, val ask: Boolean, val updatedAt: Long,
                        val iv: ByteArray, val data: ByteArray) {
        fun enabled(scope: String?) = when (scope) { "agent" -> agent; "terminal" -> terminal; "servers" -> servers; else -> false }
    }

    /** The key is locked (or no longer valid). Carries no detail about the value. */
    private class LockedException : Exception("locked")

    /** Secrets chosen for one command. [locked] lists biometric secrets that could not be read. */
    internal class Injection(val values: Map<String, String>, val locked: List<String>, val redaction: Redaction?)

    /** What the secret broker answers: [denied] were declined or timed out, [locked] could not be unlocked. */
    internal class Fetched(val values: Map<String, String>, val denied: List<String>, val locked: List<String>)

    private val NONE = Injection(emptyMap(), emptyList(), null)

    /** Called by the execution environment so injection works before any secrets.* call. */
    fun attach(context: Context) { app = context.applicationContext }

    internal fun appContext(): Context? = app

    private fun context(): Context = app ?: throw HostFailure("IO_ERROR", "Secrets are not available yet")

    // ---------------------------------------------------------------- bridge

    fun dispatch(context: Context, method: String, params: JSONObject, done: (Any?) -> Unit, fail: (Throwable) -> Unit) {
        app = context.applicationContext
        if (method == "secrets.unlock") return unlock(done, fail)
        io.execute {
            try {
                done(when (method) {
                    "secrets.list" -> synchronized(lock) { snapshot(load()) }
                    // Not under the lock: setting an ask-every-time secret waits for a fingerprint.
                    "secrets.set" -> set(params)
                    "secrets.delete" -> synchronized(lock) { delete(params) }
                    else -> throw HostFailure("METHOD_NOT_FOUND", "Unknown secrets method")
                })
            } catch (error: HostFailure) { fail(error)
            } catch (error: JSONException) { fail(HostFailure("INVALID_REQUEST", "Invalid secrets request"))
            } catch (error: Exception) {
                // Never forward a library message from a code path that handled plaintext.
                fail(HostFailure("IO_ERROR", "Secrets storage failed"))
            }
        }
    }

    private fun snapshot(entries: List<Entry>): JSONObject {
        val list = JSONArray()
        entries.sortedBy { it.name }.forEach { e ->
            list.put(JSONObject().put("name", e.name)
                .put("scopes", JSONObject().put("agent", e.agent).put("terminal", e.terminal).put("servers", e.servers))
                .put("redact", e.redact).put("biometric", e.biometric).put("askEveryTime", e.ask).put("updatedAt", e.updatedAt))
        }
        return JSONObject().put("secrets", list).put("unlockedUntil", unlockedUntil())
            .put("biometricAvailable", biometricAvailable(context()))
    }

    private fun unlockedUntil(): Long = unlockedUntilMs.let { if (it > System.currentTimeMillis()) it else 0L }

    private fun checkName(name: String) {
        if (!NAME.matches(name)) throw HostFailure("INVALID_REQUEST", "Names use capital letters, digits and underscores, and cannot start with a digit")
        if (name in RESERVED || RESERVED_PREFIXES.any { name.startsWith(it) }) throw HostFailure("INVALID_REQUEST", "$name is reserved")
    }

    /** Runs on the secrets thread without holding [lock] (it may wait for a fingerprint). Only this thread
     * changes the file, so the entries read first are still current when the result is stored. */
    private fun set(params: JSONObject): JSONObject {
        val name = params.getString("name")
        checkName(name)
        // An empty string is treated like an omitted value: keep the current one.
        val value = if (params.has("value") && !params.isNull("value")) params.getString("value").takeIf { it.isNotEmpty() } else null
        if (value != null) {
            if (value.indexOf('\u0000') >= 0) throw HostFailure("INVALID_REQUEST", "Values cannot contain NUL characters")
            if (value.toByteArray(Charsets.UTF_8).size > MAX_VALUE_BYTES) throw HostFailure("INVALID_REQUEST", "Values can be at most 16 KiB")
        }
        val entries = synchronized(lock) { load() }
        val current = entries.firstOrNull { it.name == name }
        if (current == null && value == null) throw HostFailure("INVALID_REQUEST", "Enter a value for the new secret")
        if (current == null && entries.size >= MAX_SECRETS) throw HostFailure("INVALID_REQUEST", "At most $MAX_SECRETS secrets can be stored")
        val scopes = params.optJSONObject("scopes")
        val agent = scopes?.optBoolean("agent", current?.agent ?: false) ?: current?.agent ?: false
        val terminal = scopes?.optBoolean("terminal", current?.terminal ?: false) ?: current?.terminal ?: false
        val servers = scopes?.optBoolean("servers", current?.servers ?: false) ?: current?.servers ?: false
        val redact = if (params.has("redact")) params.getBoolean("redact") else current?.redact ?: true
        val biometric = if (params.has("biometric")) params.getBoolean("biometric") else current?.biometric ?: false
        // Asking every time only means something for a fingerprint-protected secret.
        val ask = biometric && (if (params.has("askEveryTime")) params.getBoolean("askEveryTime") else current?.ask ?: false)
        if (biometric && current?.biometric != true && !biometricAvailable(context())) throw HostFailure("UNAVAILABLE", "Set up a screen lock or fingerprint to protect a secret with it")
        if (ask && current?.ask != true && !strongBiometricAvailable(context())) throw HostFailure("UNAVAILABLE", "Enrol a fingerprint to ask for it every time")

        var iv = current?.iv
        var data = current?.data
        if (value != null || (current != null && (current.biometric != biometric || current.ask != ask))) {
            val plain = value?.toByteArray(Charsets.UTF_8) ?: readForSettings(current!!)
            try {
                val sealed = if (ask) sealAsk(name, plain, entries) else encrypt(name, biometric, plain, entries)
                iv = sealed.first; data = sealed.second
            } finally { plain.fill(0) }
        }
        val updated = Entry(name, agent, terminal, servers, redact, biometric, ask, System.currentTimeMillis(), iv!!, data!!)
        return synchronized(lock) {
            val next = entries.filter { it.name != name } + updated
            store(next)
            clearNet()
            snapshot(next)
        }
    }

    /** The current plaintext, to re-encrypt it. A time-bound key that is locked reports LOCKED (the page unlocks and retries);
     * an ask-every-time one asks for the fingerprint here. */
    private fun readForSettings(current: Entry): ByteArray {
        if (!current.ask) return try { decrypt(current) } catch (_: LockedException) {
            throw HostFailure("LOCKED", "Unlock with your fingerprint first")
        }
        val read = askRead(current, "Self Forming", SETTINGS_WAIT_MS) { false }
        return when (read.second) {
            Outcome.APPROVED -> read.first!!
            Outcome.UNAVAILABLE -> throw HostFailure("UNAVAILABLE", "The fingerprint key for this secret is not usable. Delete it and add it again.")
            else -> throw HostFailure("CANCELLED", "Confirm with your fingerprint to change this secret")
        }
    }

    private fun delete(params: JSONObject): JSONObject {
        val name = params.getString("name")
        val next = load().filter { it.name != name }
        store(next)
        clearNet()
        // Keys stay: they hold no data, and recreating one for a later secret is cheap but unlock state is kept.
        return snapshot(next)
    }

    // ---------------------------------------------------------------- unlock

    private fun unlock(done: (Any?) -> Unit, fail: (Throwable) -> Unit) {
        val context = context()
        if (!SecretPrompter.isForeground) return fail(HostFailure("NO_ACTIVITY", "Open Self Forming to unlock secrets"))
        if (!biometricAvailable(context)) return fail(HostFailure("UNAVAILABLE", "Set up a screen lock or fingerprint to unlock secrets"))
        // Joins a prompt that a broker request already opened. The bridge calls in on the main thread: do not block it.
        SecretPrompter.async {
            when (SecretPrompter.awaitUnlock(null, emptyList(), SETTINGS_WAIT_MS * 3, { false })) {
                Outcome.APPROVED -> done(JSONObject().put("unlockedUntil", unlockedUntil()))
                Outcome.UNAVAILABLE -> fail(HostFailure("UNAVAILABLE", "Unlock did not authorise secrets on this device"))
                else -> fail(HostFailure("CANCELLED", "Unlock was cancelled"))
            }
        }
    }

    /** After a successful prompt: check that the keystore really accepts the time-bound key, then remember the unlock. */
    internal fun completeUnlock() {
        synchronized(lock) { probeBiometricKey() }
        unlockedUntilMs = System.currentTimeMillis() + UNLOCK_SECONDS * 1000L
        clearNet()
    }

    private fun probeBiometricKey() {
        val entries = load()
        val bio = entries.filter { it.biometric && !it.ask }
        val key = existingKey(KEY_BIO)
        if (key == null && bio.isNotEmpty()) throw HostFailure("KEY_MISSING", "The protected key is missing. Delete the protected secrets and add them again.")
        try {
            Cipher.getInstance("AES/GCM/NoPadding").init(Cipher.ENCRYPT_MODE, key ?: createKey(KEY_BIO))
        } catch (error: Exception) {
            if (isLocked(error)) throw HostFailure("UNAVAILABLE", "Unlock did not authorise secrets on this device")
            throw error
        }
    }

    fun biometricAvailable(context: Context): Boolean = try {
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        if (keyguard == null || !keyguard.isDeviceSecure) false
        else when {
            Build.VERSION.SDK_INT >= 30 -> context.getSystemService(BiometricManager::class.java)
                .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL) ==
                BiometricManager.BIOMETRIC_SUCCESS
            // API 29: the prompt itself offers the screen lock. API 28: fingerprint only.
            Build.VERSION.SDK_INT == 29 -> true
            else -> context.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
        }
    } catch (_: Exception) { false }

    /** A strong biometric (fingerprint) is enrolled: the only thing that can authorise a single cipher operation. */
    private fun strongBiometricAvailable(context: Context): Boolean = try {
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        if (keyguard == null || !keyguard.isDeviceSecure) false
        else if (Build.VERSION.SDK_INT >= 30) context.getSystemService(BiometricManager::class.java)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
        else context.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
    } catch (_: Exception) { false }

    // ---------------------------------------------------------------- injection

    /** Pick and decrypt the secrets enabled for [scope] and prepare what the command needs.
     *  - agent: the values are injected (locked fingerprint secrets are asked for, up to 60 s; those denied
     *    or timed out are reported in [Injection.locked]);
     *  - agent|terminal|servers: SF_SECRETS_URL and SF_SECRETS_TOKEN for the broker (terminal and servers
     *    get no values here: their helper fetches them);
     *  - unknown or missing scope injects nothing.
     * The redaction always also covers every other readable redact=true secret, whatever the scope, and the
     * broker tokens. It stays registered in [live] until [release]. */
    internal fun resolve(scope: String?, cancelled: () -> Boolean = { false }): Injection {
        if (app == null) return NONE
        val generation = synchronized(cacheLock) { netGeneration }
        val all = try { synchronized(lock) { load() } } catch (_: Exception) { emptyList() }
        val values = LinkedHashMap<String, String>()
        val locked = ArrayList<String>()
        val redacted = LinkedHashMap<String, ByteArray>()
        if (scope == "agent" && all.isNotEmpty()) {
            val gathered = gather(all.filter { it.agent }.sortedBy { it.name }, AGENT_LABEL, AGENT_WAIT_MS, cancelled)
            values.putAll(gathered.values)
            locked.addAll(gathered.denied)
            locked.addAll(gathered.locked)
            redacted.putAll(gathered.redactions)
        }
        if (all.isNotEmpty()) for ((name, bytes) in safetyNet(all, generation)) {
            if (name in redacted) bytes.fill(0) else redacted[name] = bytes
        }
        if (scope == "agent" || scope == "terminal" || scope == "servers") {
            SecretBroker.environmentFor(scope)?.let { values.putAll(it) }
        }
        SecretBroker.tokenValues().forEachIndexed { i, token -> redacted["SF_SECRETS_TOKEN${if (i == 0) "" else i}"] = token }
        if (values.isEmpty() && locked.isEmpty() && redacted.isEmpty()) return NONE
        val redaction = Redaction(redacted.map { it.key to it.value })
        live.add(redaction)
        return Injection(values, locked.sorted(), redaction)
    }

    /** The command is over: stop adding values to its redaction and wipe it. */
    internal fun release(redaction: Redaction?) {
        if (redaction == null) return
        live.remove(redaction)
        redaction.wipe()
    }

    /** The secret broker: values for [scope] (the token's scope), prompting for fingerprints for up to [waitMs]. */
    internal fun fetch(scope: String, label: String, waitMs: Long, cancelled: () -> Boolean): Fetched {
        if (app == null) return Fetched(emptyMap(), emptyList(), emptyList())
        val all = try { synchronized(lock) { load() } } catch (_: Exception) { emptyList() }
        val gathered = gather(all.filter { it.enabled(scope) }.sortedBy { it.name }, label, waitMs, cancelled)
        // Commands running now may print what their helper just received: cover it before the helper has it.
        // The copies live exactly as long as those commands (never in the safety-net cache).
        for ((name, bytes) in gathered.redactions) {
            for (redaction in live.toList()) redaction.add(name, bytes.copyOf())
            bytes.fill(0)
        }
        return Fetched(gathered.values, gathered.denied.sorted(), gathered.locked.sorted())
    }

    private class Gathered(val values: LinkedHashMap<String, String> = LinkedHashMap(), val denied: ArrayList<String> = ArrayList(),
                           val locked: ArrayList<String> = ArrayList(), val redactions: LinkedHashMap<String, ByteArray> = LinkedHashMap())

    /** Decrypt [chosen], asking for the fingerprint where needed (waiting at most [waitMs] in total). */
    private fun gather(chosen: List<Entry>, label: String, waitMs: Long, cancelled: () -> Boolean): Gathered {
        val result = Gathered()
        val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(waitMs)
        fun remainingMs() = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
        fun accept(entry: Entry, plain: ByteArray) {
            val text = String(plain, Charsets.UTF_8)
            result.values[entry.name] = text
            if (entry.redact && text.codePointCount(0, text.length) >= 4) result.redactions[entry.name] = plain.copyOf()
        }
        val waiting = ArrayList<Entry>()
        val asks = ArrayList<Entry>()
        for (entry in chosen) {
            if (entry.ask) { asks.add(entry); continue }
            var plain: ByteArray? = null
            try {
                plain = decrypt(entry)
                accept(entry, plain)
            } catch (_: LockedException) {
                waiting.add(entry)
            } catch (_: Exception) {
                // Missing key or damaged ciphertext: fail closed by not delivering this secret.
            } finally { plain?.fill(0) }
        }
        if (waiting.isNotEmpty()) {
            val outcome = if (waitMs <= 0 || !biometricAvailable(context())) Outcome.UNAVAILABLE
                else SecretPrompter.awaitUnlock(label, waiting.map { it.name }, remainingMs(), cancelled)
            for (entry in waiting) {
                if (outcome != Outcome.APPROVED) {
                    (if (outcome == Outcome.UNAVAILABLE) result.locked else result.denied).add(entry.name)
                    continue
                }
                var plain: ByteArray? = null
                try {
                    plain = decrypt(entry)
                    accept(entry, plain)
                } catch (_: LockedException) { result.locked.add(entry.name)
                } catch (_: Exception) {
                } finally { plain?.fill(0) }
            }
        }
        for (entry in asks) {
            val ms = remainingMs()
            if (waitMs <= 0) { result.locked.add(entry.name); continue }
            if (ms <= 0) { result.denied.add(entry.name); continue }
            val (plain, outcome) = askRead(entry, label, ms, cancelled)
            when {
                plain != null -> try { accept(entry, plain) } finally { plain.fill(0) }
                outcome == Outcome.UNAVAILABLE -> result.locked.add(entry.name)
                else -> result.denied.add(entry.name)
            }
        }
        return result
    }

    /** Fresh copies (the caller wipes them) of the cached redaction set, rebuilding it when it has expired. */
    private fun safetyNet(entries: List<Entry>, generation: Long): List<Pair<String, ByteArray>> = synchronized(cacheLock) {
        val hit = netCache
        if (hit != null) return@synchronized hit.map { it.first to it.second.copyOf() }
        val built = ArrayList<Pair<String, ByteArray>>()
        for (entry in entries) {
            if (!entry.redact || entry.ask) continue
            var plain: ByteArray? = null
            try {
                plain = decrypt(entry) // Locked biometric secrets and damaged ones are simply left out.
                val text = String(plain, Charsets.UTF_8)
                if (text.codePointCount(0, text.length) >= 4) built.add(entry.name to plain.copyOf())
            } catch (_: Exception) {
            } finally { plain?.fill(0) }
        }
        // A set/delete/unlock during the rebuild makes it stale: use it once, never keep it.
        if (generation == netGeneration) {
            netCache = built
            netTimer?.cancel(false)
            netTimer = timer.schedule({ clearNet() }, NET_SECONDS, java.util.concurrent.TimeUnit.SECONDS)
            built.map { it.first to it.second.copyOf() }
        } else built
    }

    /** Zero the cached copies now (secrets changed, unlocked, or the cache expired). */
    private fun clearNet() = synchronized(cacheLock) {
        netGeneration++
        netCache?.forEach { it.second.fill(0) }
        netCache = null
        netTimer?.cancel(false)
        netTimer = null
    }

    // ---------------------------------------------------------------- crypto

    private fun aad(name: String) = "sf-secret:v1:$name".toByteArray(Charsets.UTF_8)

    private fun keystore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun existingKey(alias: String): SecretKey? = try { keystore().getKey(alias, null) as? SecretKey } catch (_: Exception) { null }

    @Suppress("DEPRECATION")
    private fun createKey(alias: String): SecretKey {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (alias == KEY_BIO) {
            // Unlocked once for 30 minutes by a fingerprint or the screen lock.
            spec.setUserAuthenticationRequired(true)
            if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(UNLOCK_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            else spec.setUserAuthenticationValidityDurationSeconds(UNLOCK_SECONDS)
        } else if (alias == KEY_ASK) {
            // Every single cipher operation needs its own strong-biometric authentication (CryptoObject).
            spec.setUserAuthenticationRequired(true)
            if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            else spec.setUserAuthenticationValidityDurationSeconds(-1)
        }
        try {
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run { init(spec.build()); generateKey() }
        } catch (error: Exception) {
            throw HostFailure("UNAVAILABLE", "Could not create the encryption key on this device")
        }
    }

    private fun isLocked(error: Throwable): Boolean {
        var e: Throwable? = error
        var depth = 0
        while (e != null && depth++ < 6) {
            if (e is UserNotAuthenticatedException || e is KeyPermanentlyInvalidatedException) return true
            e = e.cause
        }
        return false
    }

    /** Encrypt for the key matching [biometric]. Never replaces a key that other secrets still depend on. */
    private fun encrypt(name: String, biometric: Boolean, plain: ByteArray, entries: List<Entry>): Pair<ByteArray, ByteArray> {
        val alias = if (biometric) KEY_BIO else KEY_PLAIN
        fun seal(key: SecretKey): Pair<ByteArray, ByteArray> {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad(name))
            return cipher.iv to cipher.doFinal(plain)
        }
        try {
            var key = existingKey(alias)
            if (key != null) {
                try { return seal(key) } catch (error: Exception) {
                    if (error !is KeyPermanentlyInvalidatedException && error.cause !is KeyPermanentlyInvalidatedException) throw error
                    key = null
                    try { keystore().deleteEntry(alias) } catch (_: Exception) {}
                }
            }
            if (entries.any { it.name != name && keyAlias(it) == alias })
                throw HostFailure("KEY_MISSING", "The key for the stored secrets is missing. Delete those secrets and add them again.")
            return seal(createKey(alias))
        } catch (error: HostFailure) {
            throw error
        } catch (error: Exception) {
            if (isLocked(error)) { unlockedUntilMs = 0; throw HostFailure("LOCKED", "Unlock with your fingerprint first") }
            throw HostFailure("IO_ERROR", "Could not encrypt the secret")
        }
    }

    private fun keyAlias(entry: Entry) = if (entry.ask) KEY_ASK else if (entry.biometric) KEY_BIO else KEY_PLAIN

    // ---- ask-every-time secrets: each use is one cipher operation authorised by its own fingerprint.

    /** Cipher for sealing [name] under the per-use key, initialised but not yet authorised. */
    private fun initAskEncrypt(name: String, entries: List<Entry>): Cipher {
        fun begin(key: SecretKey) = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        existingKey(KEY_ASK)?.let { key ->
            try { return begin(key) } catch (error: Exception) {
                if (error !is KeyPermanentlyInvalidatedException && error.cause !is KeyPermanentlyInvalidatedException) throw error
                try { keystore().deleteEntry(KEY_ASK) } catch (_: Exception) {}
            }
        }
        if (entries.any { it.name != name && it.ask })
            throw HostFailure("KEY_MISSING", "The key for the stored secrets is missing. Delete those secrets and add them again.")
        return begin(createKey(KEY_ASK))
    }

    /** Seal [plain] with a fingerprint (the key needs one for encryption too). Runs without [lock] held. */
    private fun sealAsk(name: String, plain: ByteArray, entries: List<Entry>): Pair<ByteArray, ByteArray> {
        val (outcome, cipher) = SecretPrompter.awaitAsk("Self Forming", name, SETTINGS_WAIT_MS, { false }) { synchronized(lock) { initAskEncrypt(name, entries) } }
        if (outcome == Outcome.UNAVAILABLE) throw HostFailure("UNAVAILABLE", "The fingerprint key could not be used. Delete the ask-every-time secrets and add them again.")
        if (outcome != Outcome.APPROVED || cipher == null) throw HostFailure("CANCELLED", "Confirm with your fingerprint to save this secret")
        try {
            val iv = cipher.iv
            cipher.updateAAD(aad(name))
            return iv to cipher.doFinal(plain)
        } catch (_: Exception) {
            throw HostFailure("IO_ERROR", "Could not encrypt the secret")
        }
    }

    /** Ask for the fingerprint and decrypt [entry]. Plaintext (non-null only when approved) must be wiped by the caller. */
    private fun askRead(entry: Entry, label: String, waitMs: Long, cancelled: () -> Boolean): Pair<ByteArray?, Outcome> {
        val (outcome, cipher) = SecretPrompter.awaitAsk(label, entry.name, waitMs, cancelled) {
            val key = existingKey(KEY_ASK) ?: throw HostFailure("KEY_MISSING", "The key for this secret is missing")
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, entry.iv)) }
        }
        if (outcome != Outcome.APPROVED || cipher == null) return null to outcome
        return try {
            cipher.updateAAD(aad(entry.name))
            cipher.doFinal(entry.data) to Outcome.APPROVED
        } catch (_: Exception) { null to Outcome.UNAVAILABLE }
    }

    /** Throws [LockedException] when the biometric key needs a fresh unlock; the result must be wiped by the caller.
     * Never used for ask-every-time entries (see [askRead]). */
    private fun decrypt(entry: Entry): ByteArray {
        if (entry.ask) throw HostFailure("IO_ERROR", "Could not read the secret")
        val key = existingKey(if (entry.biometric) KEY_BIO else KEY_PLAIN) ?: throw HostFailure("KEY_MISSING", "The key for this secret is missing")
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, entry.iv))
            cipher.updateAAD(aad(entry.name))
            return cipher.doFinal(entry.data)
        } catch (error: Exception) {
            if (isLocked(error)) {
                unlockedUntilMs = 0
                throw if (entry.biometric) LockedException() else HostFailure("IO_ERROR", "Could not read the secret")
            }
            throw HostFailure("IO_ERROR", "Could not read the secret")
        }
    }

    // ---------------------------------------------------------------- file

    private fun file() = File(context().noBackupFilesDir, FILE)

    private fun load(): List<Entry> {
        val file = file()
        if (!file.isFile) return emptyList()
        try {
            val array = JSONObject(file.readText(Charsets.UTF_8)).getJSONArray("secrets")
            return (0 until array.length()).map { i ->
                val o = array.getJSONObject(i)
                Entry(o.getString("name"), o.getBoolean("agent"), o.getBoolean("terminal"), o.getBoolean("servers"),
                    o.getBoolean("redact"), o.getBoolean("biometric"), o.optBoolean("askEveryTime", false), o.getLong("updatedAt"),
                    Base64.decode(o.getString("iv"), Base64.NO_WRAP), Base64.decode(o.getString("data"), Base64.NO_WRAP))
            }
        } catch (error: Exception) {
            // Keep the unreadable (still encrypted) file for inspection and start empty instead of failing forever.
            try { Files.move(file.toPath(), File(file.parentFile, "$FILE.bad").toPath(), StandardCopyOption.REPLACE_EXISTING) } catch (_: Exception) {}
            return emptyList()
        }
    }

    private fun store(entries: List<Entry>) {
        val array = JSONArray()
        entries.sortedBy { it.name }.forEach { e ->
            array.put(JSONObject().put("name", e.name).put("agent", e.agent).put("terminal", e.terminal).put("servers", e.servers)
                .put("redact", e.redact).put("biometric", e.biometric).put("askEveryTime", e.ask).put("updatedAt", e.updatedAt)
                .put("iv", Base64.encodeToString(e.iv, Base64.NO_WRAP)).put("data", Base64.encodeToString(e.data, Base64.NO_WRAP)))
        }
        val target = file()
        val temp = File(target.parentFile, "$FILE.tmp")
        FileOutputStream(temp).use { out ->
            out.write(JSONObject().put("version", 1).put("secrets", array).toString().toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}
