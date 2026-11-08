package hu.isucode.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * A belépő token a telefon hardveres kulcstárában lévő, ujjlenyomathoz kötött AES-kulccsal titkosítva tárolódik:
 * kiolvasni csak sikeres ujjlenyomat után lehet. Ha új ujjlenyomatot vesznek fel a telefonra, a kulcs érvénytelen
 * lesz (újra jelszóval kell belépni). A widget-token csak olvasásra jó, az sima (privát) tárolóban van.
 */
object Vault {
    private const val KEY = "isu_login_key"
    private const val PREFS = "isu"

    fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun hasLogin(c: Context) = prefs(c).getString("ct", null) != null
    fun widgetToken(c: Context): String? = prefs(c).getString("widget", null)
    fun deviceId(c: Context): String = prefs(c).getString("device", "") ?: ""

    fun clear(c: Context) {
        prefs(c).edit().remove("ct").remove("iv").remove("widget").remove("device").apply()
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY)
        } catch (_: Exception) {
        }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        }
        gen.init(spec.build())
        return gen.generateKey()
    }

    /** Titkosításra kész cipher (az ujjlenyomat-ablak ezt „oldja fel”). */
    fun encryptCipher(): Cipher {
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY)
        } catch (_: Exception) {
        }
        return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    }

    /** Visszafejtésre kész cipher; null, ha nincs mentett token vagy a kulcs érvénytelenné vált. */
    fun decryptCipher(c: Context): Cipher? {
        val iv = prefs(c).getString("iv", null) ?: return null
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        }
    }

    fun save(c: Context, cipher: Cipher, loginToken: String, widgetToken: String, deviceId: String) {
        val ct = cipher.doFinal(loginToken.toByteArray())
        prefs(c).edit()
            .putString("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("widget", widgetToken)
            .putString("device", deviceId)
            .apply()
    }

    fun read(c: Context, cipher: Cipher): String {
        val ct = Base64.decode(prefs(c).getString("ct", "") ?: "", Base64.NO_WRAP)
        return String(cipher.doFinal(ct))
    }
}
