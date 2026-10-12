package md.incept.selfforming

class HostFailure(val code: String, message: String) : Exception(message)

internal const val MAX_MESSAGE_BYTES = 4 * 1024 * 1024
internal const val MAX_TEXT_BYTES = 1024 * 1024
