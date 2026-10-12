package md.incept.selfforming

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class CommandOutputTest {
    private val marker = byteArrayOf(0, 80, 73, 45, 55, 0)

    @Test fun removesMarkerAtEveryBoundaryAndPreservesRawBytes() {
        val prefix = byteArrayOf(-1, -2, 0, 80, 73, 45, 56, 0, 10)
        val payload = prefix + marker + "background".toByteArray()
        for (split in 0..payload.size) {
            val result = ByteArrayOutputStream()
            val parser = CommandOutput(marker) { result.write(it) }
            parser.write(payload.copyOfRange(0, split))
            parser.write(payload.copyOfRange(split, payload.size))
            parser.finish()
            assertTrue(parser.completed)
            assertArrayEquals(prefix, result.toByteArray())
        }
    }

    @Test fun eofFlushesPartialMarkerAndSingleByteChunksWork() {
        val result = ByteArrayOutputStream()
        val parser = CommandOutput(marker) { result.write(it) }
        val data = byteArrayOf(65, 0, 80, 73)
        data.forEach { parser.write(byteArrayOf(it)) }
        parser.finish()
        assertFalse(parser.completed)
        assertArrayEquals(data, result.toByteArray())
        val done = CommandOutput(marker) { fail("Marker must not be emitted") }
        marker.forEach { done.write(byteArrayOf(it)) }
        assertTrue(done.completed)
    }
}
