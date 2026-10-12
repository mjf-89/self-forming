package md.incept.selfforming

import java.io.ByteArrayOutputStream

/** Replaces secret values in command output with `[NAME]`, working on raw bytes (UTF-8 safe, no decoding).
 * Each output stream owns a [Stream] with a small carry-over buffer, so a value split across read
 * chunks is still found. The carry never exceeds (longest value - 1) bytes: it holds only a suffix
 * that is a proper prefix of some value, and is flushed when the stream ends.
 *
 * Besides the exact value, a few shell-visible spellings are matched too: the value without leading or
 * trailing whitespace (`echo -n $X` of a value saved with a trailing newline), with whitespace runs
 * collapsed to one space (unquoted `echo $X` of a multi-line value) and each long line of a multi-line
 * value. Values can also be added while commands run ([add]): the secret broker hands values to helpers
 * after the command started, and their output must be covered too. */
internal class Redaction(entries: List<Pair<String, ByteArray>>) {
    private class Pattern(val value: ByteArray, val replacement: ByteArray)

    private val lock = Any()
    // Longest first, so the leftmost-longest value wins when one value is a prefix of another.
    private var patterns: List<Pattern> = sorted(entries.flatMap { (name, value) -> expand(name, value) })
    private var wiped = false
    private val streams = ArrayList<Stream>()

    val isEmpty get() = synchronized(lock) { patterns.isEmpty() }

    fun stream(): Stream = Stream().also { synchronized(lock) { streams.add(it) } }

    /** Start redacting [value] too. Takes ownership of the array (it is wiped by [wipe] or when redundant). */
    fun add(name: String, value: ByteArray) = synchronized(lock) {
        if (wiped || value.isEmpty()) { value.fill(0); return@synchronized }
        val fresh = expand(name, value).filter { candidate ->
            val known = patterns.any { it.value.contentEquals(candidate.value) && it.replacement.contentEquals(candidate.replacement) }
            if (known) candidate.value.fill(0)
            !known
        }
        if (fresh.isNotEmpty()) patterns = sorted(patterns + fresh)
    }

    /** Zero the plaintext copies and any held-back bytes. Later calls pass data through untouched. */
    fun wipe() = synchronized(lock) {
        wiped = true
        patterns.forEach { it.value.fill(0) }
        patterns = emptyList()
        streams.forEach { it.carry.fill(0); it.carry = ByteArray(0) }
        streams.clear()
    }

    private companion object {
        fun sorted(list: List<Pattern>) = list.sortedByDescending { it.value.size }

        fun expand(name: String, value: ByteArray): List<Pattern> {
            val replacement = "[$name]".toByteArray(Charsets.UTF_8)
            val result = arrayListOf(Pattern(value, replacement))
            val text = String(value, Charsets.UTF_8)
            val seen = hashSetOf(text)
            fun variant(candidate: String) {
                if (candidate.codePointCount(0, candidate.length) >= 4 && seen.add(candidate))
                    result.add(Pattern(candidate.toByteArray(Charsets.UTF_8), replacement))
            }
            variant(text.trim())
            variant(text.trim().split(Regex("\\s+")).joinToString(" "))
            if (text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
                text.split(Regex("[\r\n]+")).asSequence().map { it.trim() }.filter { it.length >= 8 && !it.startsWith("-----") }
                    .take(64).forEach { variant(it) }
            }
            return result
        }
    }

    inner class Stream internal constructor() {
        internal var carry = ByteArray(0)

        /** Returns the bytes that are safe to emit now; the tail that might start a value is kept. */
        fun process(chunk: ByteArray): ByteArray = synchronized(lock) { run(chunk, false) }

        /** End of stream: emit everything still held back. */
        fun flush(): ByteArray = synchronized(lock) { run(ByteArray(0), true) }

        private fun run(chunk: ByteArray, final: Boolean): ByteArray {
            val data = if (carry.isEmpty()) chunk else carry + chunk
            if (patterns.isEmpty()) { carry = ByteArray(0); return data }
            val out = ByteArrayOutputStream(data.size + 16)
            var i = 0
            var emitted = 0
            while (i < data.size) {
                var match: Pattern? = null
                var partial = false
                val available = data.size - i
                for (pattern in patterns) {
                    val value = pattern.value
                    if (value[0] != data[i]) continue
                    if (available >= value.size) {
                        if (match == null && regionEquals(data, i, value, value.size)) match = pattern
                    } else if (!final && regionEquals(data, i, value, available)) partial = true
                }
                if (partial) break // Might be the start of a value that the next chunk completes.
                if (match != null) {
                    out.write(data, emitted, i - emitted)
                    out.write(match.replacement)
                    i += match.value.size
                    emitted = i
                } else i++
            }
            out.write(data, emitted, i - emitted)
            carry = if (i < data.size) data.copyOfRange(i, data.size) else ByteArray(0)
            return out.toByteArray()
        }

        private fun regionEquals(data: ByteArray, at: Int, value: ByteArray, length: Int): Boolean {
            for (k in 0 until length) if (data[at + k] != value[k]) return false
            return true
        }
    }
}
