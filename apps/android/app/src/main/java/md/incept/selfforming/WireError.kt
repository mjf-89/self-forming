package md.incept.selfforming

import org.json.JSONObject

/** Shared error encoding for the storage and execution bridge. */
internal fun wireError(error: Throwable): JSONObject {
    val code = when (error) {
        is EnvFailure -> error.code
        is HostFailure -> error.code
        is org.json.JSONException, is IllegalArgumentException -> "INVALID_REQUEST"
        is java.nio.file.NoSuchFileException -> "NOT_FOUND"
        is java.nio.file.AccessDeniedException, is SecurityException -> "ACCESS_DENIED"
        is java.nio.charset.CharacterCodingException -> "INVALID_UTF8"
        is android.database.SQLException -> "SQL_ERROR"
        else -> "IO_ERROR"
    }
    return JSONObject().put("code", code).put("message", error.message?.take(2048) ?: "Native operation failed").also {
        if (error is EnvFailure) {
            error.path?.let { path -> it.put("path", path) }
            error.spillPath?.let { path -> it.put("spillPath", path) }
        }
    }
}
