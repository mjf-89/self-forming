package md.incept.selfforming

/** Removes a private completion marker without decoding or changing command bytes.
 * After the marker, inherited background output is drained but is no longer this call's output. */
internal class CommandOutput(private val marker: ByteArray, private val emit: (ByteArray) -> Unit) {
    private var pending = ByteArray(0)
    var completed = false
        private set

    fun write(bytes: ByteArray) {
        if (completed) return
        val value = pending + bytes
        for (at in 0..(value.size - marker.size)) {
            if (marker.indices.all { value[at + it] == marker[it] }) {
                if (at > 0) emit(value.copyOfRange(0, at))
                pending = ByteArray(0)
                completed = true
                return
            }
        }
        var keep = minOf(marker.size - 1, value.size)
        while (keep > 0 && !(0 until keep).all { value[value.size - keep + it] == marker[it] }) keep--
        if (value.size > keep) emit(value.copyOfRange(0, value.size - keep))
        pending = value.copyOfRange(value.size - keep, value.size)
    }

    fun finish() {
        if (!completed && pending.isNotEmpty()) emit(pending)
        pending = ByteArray(0)
    }
}
