package hu.isucode.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.security.KeyStoreException
import android.security.keystore.KeyPermanentlyInvalidatedException

class MainActivity : AppCompatActivity() {
    companion object {
        const val BASE = "https://isucode.hu"
        const val HOST = "isucode.hu"
        private const val LOCK_AFTER_MS = 3 * 60 * 1000L
    }

    private lateinit var web: WebView
    private lateinit var lock: View
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var stoppedAt = 0L
    private var unlocking = false

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#080D10"))
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        lock = buildLock()
        lock.visibility = View.GONE
        root.addView(lock, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        // a rendszersávok (óra, navigáció) és a billentyűzet ne takarja ki az oldalt
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, maxOf(b.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        CookieManager.getInstance().setAcceptCookie(true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString IsuCodeApp/${BuildConfigCompat.version(this@MainActivity)}"
        }
        web.addJavascriptInterface(Bridge(), "IsuApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "https" && (u.host == HOST || u.host == "www.$HOST")) return false
                openExternal(u)
                return true
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                pageHost = url?.let { Uri.parse(it).host }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                pageHost = url?.let { Uri.parse(it).host }
                CookieManager.getInstance().flush()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(w: WebView?, cb: ValueCallback<Array<Uri>>?, p: FileChooserParams?): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try {
                    pickFiles.launch(p!!.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }
        web.setDownloadListener { url, ua, cd, mime, _ ->
            try {
                val r = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", ua)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, cd, mime))
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(r)
                Toast.makeText(this, "Letöltés elindult", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                openExternal(Uri.parse(url))
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(startUrl(intent))

        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        IsuWidget.schedule(this)
        Updater.check(this)
    }

    private fun startUrl(i: Intent?): String {
        val hash = i?.getStringExtra("hash")
        return "$BASE/admin" + (if (!hash.isNullOrBlank()) hash else "")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val hash = intent.getStringExtra("hash")
        if (!hash.isNullOrBlank()) web.loadUrl(startUrl(intent))
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onStop() {
        super.onStop()
        stoppedAt = SystemClock.elapsedRealtime()
        CookieManager.getInstance().flush()
        IsuWidget.refreshNow(this)
    }

    override fun onStart() {
        super.onStart()
        // ha az ujjlenyomat be van kapcsolva, 3 perc háttér után zárolja magát
        if (stoppedAt > 0 && SystemClock.elapsedRealtime() - stoppedAt > 60 * 60 * 1000L) Updater.check(this)
        if (stoppedAt > 0 && Vault.hasLogin(this) && SystemClock.elapsedRealtime() - stoppedAt > LOCK_AFTER_MS) {
            lock.visibility = View.VISIBLE
            appUnlock()
        }
    }

    private fun buildLock(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#080D10"))
            isClickable = true
        }
        box.addView(TextView(this).apply {
            text = "IsuCode zárolva"
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = Gravity.CENTER
        })
        box.addView(Button(this).apply {
            text = "Feloldás"
            setOnClickListener { appUnlock() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 48 })
        return box
    }

    private fun appUnlock() {
        if (unlocking) return
        unlocking = true
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                unlocking = false
                lock.visibility = View.GONE
            }

            override fun onAuthenticationError(code: Int, msg: CharSequence) {
                unlocking = false
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder().setTitle("IsuCode feloldása")
        if (Build.VERSION.SDK_INT >= 30) info.setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        else info.setDeviceCredentialAllowed(true)
        prompt.authenticate(info.build())
    }

    private fun openExternal(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }
    private fun jsError(msg: String) = js("window.__isuApp&&window.__isuApp.onError&&window.__isuApp.onError(${JSONObject.quote(msg)})")

    /** Ujjlenyomat-ablak egy kulcstári cipherrel; siker esetén a feloldott cipherrel hív vissza. */
    private fun withFingerprint(title: String, sub: String, cipher: javax.crypto.Cipher, ok: (javax.crypto.Cipher) -> Unit) {
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher
                if (c == null) jsError("Nem sikerült.") else try {
                    ok(c)
                } catch (e: Exception) {
                    jsError("Nem sikerült: ${e.message ?: "ismeretlen hiba"}")
                }
            }

            override fun onAuthenticationError(code: Int, msg: CharSequence) {
                // mégse / vissza: üres üzenet → az oldal csak a jelszavas űrlapot mutatja
                val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED
                jsError(if (cancelled) "" else msg.toString())
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(sub)
            .setNegativeButtonText("Mégse")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** A híd csak az isucode.hu oldalain válaszol. */
    @Volatile private var pageHost: String? = null

    inner class Bridge {
        private fun ok() = pageHost == HOST

        @JavascriptInterface
        fun hasLogin(): Boolean = ok() && Vault.hasLogin(this@MainActivity)

        @JavascriptInterface
        fun deviceId(): String = Vault.deviceId(this@MainActivity)

        @JavascriptInterface
        fun deviceName(): String = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".take(60)

        @JavascriptInterface
        fun checkUpdate() = runOnUiThread { Updater.check(this@MainActivity, true) }

        @JavascriptInterface
        fun version(): String = BuildConfigCompat.version(this@MainActivity)

        @JavascriptInterface
        fun clear() {
            Vault.clear(this@MainActivity)
            IsuWidget.refreshNow(this@MainActivity)
        }

        @JavascriptInterface
        fun enroll(loginToken: String, widgetToken: String, deviceId: String) = runOnUiThread {
            if (!ok()) return@runOnUiThread
            try {
                withFingerprint("Ujjlenyomatos belépés bekapcsolása", "Érintsd meg az ujjlenyomat-olvasót", Vault.encryptCipher()) { c ->
                    Vault.save(this@MainActivity, c, loginToken, widgetToken, deviceId)
                    IsuWidget.refreshNow(this@MainActivity)
                    js("window.__isuApp&&window.__isuApp.onEnrolled&&window.__isuApp.onEnrolled(true)")
                }
            } catch (e: Exception) {
                jsError("Ezen a telefonon nincs beállítva ujjlenyomat (Beállítások → Jelszó és biztonság).")
            }
        }

        @JavascriptInterface
        fun unlock() = runOnUiThread {
            if (!ok()) return@runOnUiThread
            val cipher = try {
                Vault.decryptCipher(this@MainActivity)
            } catch (e: KeyPermanentlyInvalidatedException) {
                Vault.clear(this@MainActivity); null
            } catch (e: KeyStoreException) {
                Vault.clear(this@MainActivity); null
            } catch (e: Exception) {
                Vault.clear(this@MainActivity); null
            }
            if (cipher == null) {
                jsError("Az ujjlenyomatos belépést újra be kell kapcsolni: lépj be egyszer jelszóval.")
                return@runOnUiThread
            }
            withFingerprint("Belépés az IsuCode adminba", "Érintsd meg az ujjlenyomat-olvasót", cipher) { c ->
                // A belépő tokent a weboldal kódja SOHA nem kapja meg: az app maga kér vele munkamenetet,
                // és csak a munkamenet-sütit adja át a WebView-nak.
                val t = Vault.read(this@MainActivity, c)
                Thread { nativeLogin(t) }.start()
            }
        }
    }

    private fun nativeLogin(token: String) {
        try {
            val con = java.net.URL("$BASE/api/index.php?r=app/login").openConnection() as java.net.HttpURLConnection
            con.requestMethod = "POST"
            con.doOutput = true
            con.connectTimeout = 15000
            con.readTimeout = 20000
            con.setRequestProperty("Content-Type", "application/json")
            con.setRequestProperty("Accept", "application/json")
            con.outputStream.use { it.write(JSONObject().put("t", token).toString().toByteArray()) }
            val code = con.responseCode
            if (code == 401) {
                Vault.clear(this)
                jsError("Ez a telefon már nincs engedélyezve. Lépj be jelszóval.")
                return
            }
            if (code != 200) {
                jsError("A belépés most nem sikerült (hiba: $code). Próbáld újra.")
                return
            }
            val cm = CookieManager.getInstance()
            con.headerFields.filterKeys { it != null && it.equals("Set-Cookie", true) }.values.flatten().forEach { cm.setCookie(BASE, it) }
            cm.flush()
            js("window.__isuApp&&window.__isuApp.onLoggedIn&&window.__isuApp.onLoggedIn()")
        } catch (e: Exception) {
            jsError("Nincs internet, vagy a szerver nem érhető el.")
        }
    }
}

object BuildConfigCompat {
    fun version(c: android.content.Context): String = try {
        c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: "1"
    } catch (_: Exception) {
        "1"
    }
}
