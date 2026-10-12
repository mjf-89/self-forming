package md.incept.selfforming

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.io.File

/**
 * Updates Self Forming in place from an APK the agent built in the workspace.
 * Only APKs for this package are accepted; Android shows its own confirmation and checks the signature.
 */
object ApkInstaller {
    fun install(context: Context, apk: File): String {
        if (!apk.isFile) throw HostFailure("NOT_FOUND", "No APK at $apk")
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val archive = pm.getPackageArchiveInfo(apk.path, 0) ?: throw HostFailure("APK_INVALID", "Not a valid APK: $apk")
        if (archive.packageName != context.packageName)
            throw HostFailure("APK_DENIED", "Only Self Forming updates (${context.packageName}) can be installed; this APK is ${archive.packageName}.")
        if (!pm.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            throw HostFailure("INSTALL_NOT_ALLOWED", "Android settings are open: ask the user to allow Self Forming to install unknown apps, then try again.")
        }
        val installer = pm.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("base.apk", 0, apk.length()).use { output -> input.copyTo(output); session.fsync(output) }
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val callback = PendingIntent.getBroadcast(context, id, Intent(context, InstallResultReceiver::class.java), flags)
            session.commit(callback.intentSender)
        }
        return "Android is asking the user to confirm the update to ${archive.versionName}. Self Forming restarts after it installs; this conversation is saved."
    }
}

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
            context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
