package hu.isucode.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/** Kezdőképernyő-widget: teendők, új válaszok, jóváhagyásra váró tervezetek, ma kiküldött levelek. */
class IsuWidget : AppWidgetProvider() {
    override fun onUpdate(c: Context, m: AppWidgetManager, ids: IntArray) {
        render(c, Vault.prefs(c).getString("last", null)?.let { runCatching { JSONObject(it) }.getOrNull() })
        refreshNow(c)
        schedule(c)
    }

    override fun onReceive(c: Context, i: Intent) {
        super.onReceive(c, i)
        if (i.action == ACTION_REFRESH) refreshNow(c)
    }

    companion object {
        const val ACTION_REFRESH = "hu.isucode.app.REFRESH"
        private const val CHANNEL = "isu"

        fun schedule(c: Context) {
            val req = PeriodicWorkRequestBuilder<SummaryWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(c).enqueueUniquePeriodicWork("isu-summary", ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun refreshNow(c: Context) {
            WorkManager.getInstance(c).enqueueUniqueWork("isu-now", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<SummaryWorker>().build())
        }

        private fun open(c: Context, code: Int, hash: String): PendingIntent {
            val i = Intent(c, MainActivity::class.java).putExtra("hash", hash).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        fun render(c: Context, d: JSONObject?) {
            val m = AppWidgetManager.getInstance(c)
            val ids = m.getAppWidgetIds(ComponentName(c, IsuWidget::class.java))
            if (ids.isEmpty()) return
            val v = RemoteViews(c.packageName, R.layout.widget)
            if (d == null) {
                listOf(R.id.n1, R.id.n2, R.id.n3, R.id.n4).forEach { v.setTextViewText(it, "–") }
                v.setTextViewText(R.id.names, if (Vault.widgetToken(c) == null) "Nyisd meg az appot, és lépj be egyszer." else "Frissítés…")
                v.setTextViewText(R.id.updated, "")
            } else {
                v.setTextViewText(R.id.n1, d.optInt("todo").toString())
                v.setTextViewText(R.id.n2, d.optInt("unread").toString())
                v.setTextViewText(R.id.n3, d.optInt("pending").toString())
                val cap = d.optInt("cap")
                v.setTextViewText(R.id.n4, if (cap > 0) "${d.optInt("sentToday")}/$cap" else d.optInt("sentToday").toString())
                val todo = d.optJSONArray("todoNames")
                val unread = d.optJSONArray("unreadNames")
                val parts = mutableListOf<String>()
                if (unread != null && unread.length() > 0) parts += "✉ " + (0 until unread.length()).joinToString(", ") { unread.optString(it) }
                if (todo != null && todo.length() > 0) parts += "☐ " + (0 until todo.length()).joinToString(", ") { todo.optString(it) }
                v.setTextViewText(R.id.names, if (parts.isEmpty()) "Minden kész, nincs teendő. 🎉" else parts.joinToString("\n"))
                v.setTextViewText(R.id.updated, d.optString("at"))
            }
            v.setOnClickPendingIntent(R.id.root, open(c, 1, "#/"))
            v.setOnClickPendingIntent(R.id.tile1, open(c, 2, "#/"))
            v.setOnClickPendingIntent(R.id.tile2, open(c, 3, "#/postafiok"))
            v.setOnClickPendingIntent(R.id.tile3, open(c, 4, "#/ugyfelszerzes"))
            v.setOnClickPendingIntent(R.id.tile4, open(c, 5, "#/ugyfelszerzes"))
            val r = Intent(c, IsuWidget::class.java).setAction(ACTION_REFRESH)
            v.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(c, 9, r, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            m.updateAppWidget(ids, v)
        }

        /** Értesítés, ha új válasz jött vagy új teendő lett. */
        fun notifyChanges(c: Context, d: JSONObject) {
            val p = Vault.prefs(c)
            val key = d.optString("unreadKey")
            val unread = d.optInt("unread")
            val todo = d.optInt("todo")
            val first = !p.contains("notified")
            val lastKey = p.getString("unreadKey", "")
            val lastTodo = p.getInt("todoN", 0)
            p.edit().putString("unreadKey", key).putInt("todoN", todo).putBoolean("notified", true).apply()
            if (first) return
            val nm = c.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Új válaszok és teendők", NotificationManager.IMPORTANCE_HIGH))
            if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return
            if (unread > 0 && key.isNotEmpty() && key != lastKey) {
                val names = d.optJSONArray("unreadNames")
                val who = if (names != null && names.length() > 0) names.optString(0) else "Valaki"
                show(c, 100, "Új válasz: $who", if (unread > 1) "$unread olvasatlan levél vár" else "Nyisd meg a Postafiókot", "#/postafiok")
            } else if (todo > lastTodo) {
                val names = d.optJSONArray("todoNames")
                show(c, 101, "Új teendő ($todo)", if (names != null && names.length() > 0) names.optString(0) else "Nézd meg a mai teendőket", "#/")
            }
        }

        private fun show(c: Context, id: Int, title: String, text: String, hash: String) {
            val n = NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(open(c, id, hash))
                .build()
            try {
                NotificationManagerCompat.from(c).notify(id, n)
            } catch (_: SecurityException) {
            }
        }
    }
}

class SummaryWorker(private val c: Context, p: WorkerParameters) : Worker(c, p) {
    override fun doWork(): Result {
        val token = Vault.widgetToken(c)
        if (token == null) {
            Vault.prefs(c).edit().remove("last").apply()
            IsuWidget.render(c, null)
            return Result.success()
        }
        return try {
            val con = URL("${MainActivity.BASE}/api/index.php?r=app/summary").openConnection() as HttpURLConnection
            con.connectTimeout = 15000
            con.readTimeout = 20000
            con.setRequestProperty("X-App-Token", token)
            con.setRequestProperty("Accept", "application/json")
            val code = con.responseCode
            if (code == 401) {
                Vault.clear(c)
                IsuWidget.render(c, null)
                return Result.success()
            }
            if (code != 200) return Result.retry()
            val d = JSONObject(con.inputStream.bufferedReader().readText())
            Vault.prefs(c).edit().putString("last", d.toString()).apply()
            IsuWidget.render(c, d)
            IsuWidget.notifyChanges(c, d)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}
