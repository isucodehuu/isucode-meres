package hu.isucode.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.CookieManager
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Frissítés-figyelő: megnézi az isucode.hu-n a legújabb app verzióját, és ha újabb van, felajánlja.
 * A letöltés a belépett admin munkamenetével megy (az APK nem nyilvános), a telepítést az Android végzi –
 * csak azonos aláírású (a mi kulcsunkkal aláírt) frissítést fogad el, és minden adat megmarad.
 */
object Updater {
    fun ownCode(c: Context): Long = try {
        val p = c.packageManager.getPackageInfo(c.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else @Suppress("DEPRECATION") p.versionCode.toLong()
    } catch (_: Exception) {
        0
    }

    /** A legújabb verzió adatai (háttérszálon hívd). */
    fun latest(): JSONObject? = try {
        val con = URL("${MainActivity.BASE}/api/index.php?r=app/latest").openConnection() as HttpURLConnection
        con.connectTimeout = 10000
        con.readTimeout = 15000
        if (con.responseCode == 200) JSONObject(con.inputStream.bufferedReader().readText()) else null
    } catch (_: Exception) {
        null
    }

    /** Indításkor: ha van újabb verzió, és ezt még nem utasította el ma, megkérdezi. */
    fun check(a: Activity, manual: Boolean = false) {
        Thread {
            val l = latest() ?: return@Thread
            val code = l.optLong("code")
            val p = Vault.prefs(a)
            val skipped = p.getLong("skipCode", 0) == code && System.currentTimeMillis() - p.getLong("skipAt", 0) < 20 * 3600 * 1000
            if (code <= ownCode(a)) {
                if (manual) a.runOnUiThread { Toast.makeText(a, "A legfrissebb verzió van fent.", Toast.LENGTH_SHORT).show() }
                return@Thread
            }
            if (skipped && !manual) return@Thread
            a.runOnUiThread {
                if (a.isFinishing) return@runOnUiThread
                val mb = l.optLong("size") / 1_000_000.0
                AlertDialog.Builder(a)
                    .setTitle("Új IsuCode app (${l.optString("version")})")
                    .setMessage("Elérhető az app új verziója (${"%.1f".format(mb)} MB). A belépésed és a widget megmarad.")
                    .setPositiveButton("Frissítés") { _, _ -> download(a) }
                    .setNegativeButton("Később") { _, _ ->
                        p.edit().putLong("skipCode", code).putLong("skipAt", System.currentTimeMillis()).apply()
                    }
                    .show()
            }
        }.start()
    }

    private fun download(a: Activity) {
        // az első frissítésnél az Android engedélyt kér: „telepítés ebből az alkalmazásból”
        if (Build.VERSION.SDK_INT >= 26 && !a.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(a, "Engedélyezd az IsuCode-nak a telepítést, aztán nyomd meg újra a Frissítést.", Toast.LENGTH_LONG).show()
            a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
            Vault.prefs(a).edit().remove("skipCode").apply()
            return
        }
        Toast.makeText(a, "Frissítés letöltése…", Toast.LENGTH_SHORT).show()
        Thread {
            try {
                val url = "${MainActivity.BASE}/api/index.php?r=admin/app/download"
                val con = URL(url).openConnection() as HttpURLConnection
                con.connectTimeout = 15000
                con.readTimeout = 60000
                con.setRequestProperty("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                val type = con.contentType ?: ""
                if (con.responseCode != 200 || !type.contains("android.package-archive")) {
                    a.runOnUiThread { Toast.makeText(a, "Előbb lépj be az appba, aztán próbáld újra.", Toast.LENGTH_LONG).show() }
                    return@Thread
                }
                val dir = File(a.cacheDir, "update").apply { mkdirs() }
                val f = File(dir, "IsuCode.apk")
                con.inputStream.use { inp -> f.outputStream().use { inp.copyTo(it) } }
                val uri = FileProvider.getUriForFile(a, "${a.packageName}.files", f)
                val i = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                a.runOnUiThread { a.startActivity(i) }
            } catch (e: Exception) {
                a.runOnUiThread { Toast.makeText(a, "A letöltés nem sikerült. Próbáld újra később.", Toast.LENGTH_LONG).show() }
            }
        }.start()
    }
}
