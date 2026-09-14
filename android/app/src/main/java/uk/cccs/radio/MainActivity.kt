package uk.cccs.radio

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity

/**
 * Radio shell.
 *
 * Deliberately dumb about keys: every press is forwarded to the web layer as a
 * `cccs:key` event carrying the raw keycode, and the Settings screen decides
 * what it means. Rugged handsets disagree wildly about which code the side key
 * sends, so binding it in Kotlin means a new build for every model you buy —
 * the wrong place for that cost. The officer presses the key they want, it is
 * captured, and it is stored against their account.
 *
 * NOT COMPILED OR RUN — written without an Android SDK available. Expect to fix
 * imports and at least one Gradle or plugin version on first build.
 */
class MainActivity : BridgeActivity() {

    private val requiredPermissions = buildList {
        add(Manifest.permission.RECORD_AUDIO)
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.toTypedArray()

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(StatusLedPlugin::class.java)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestMissingPermissions()
        startRadioService()
    }

    private fun requestMissingPermissions() {
        val missing = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    private fun startRadioService() {
        val intent = Intent(this, RadioService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
        else startService(intent)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (shouldForward(keyCode)) {
            if (event.repeatCount == 0) forward(keyCode, true)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (shouldForward(keyCode)) {
            forward(keyCode, false)
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun forward(keyCode: Int, pressed: Boolean) {
        bridge.triggerWindowJSEvent("cccs:key", """{"keyCode":$keyCode,"pressed":$pressed}""")
    }

    /**
     * Forward everything except the keys the operating system owns. Back and
     * Home must keep working. Volume is left alone by default because officers
     * use it — if you want volume-down as the SOS key, take it out of this set
     * and accept that it stops changing the volume.
     */
    private fun shouldForward(keyCode: Int): Boolean = keyCode !in setOf(
        KeyEvent.KEYCODE_BACK,
        KeyEvent.KEYCODE_HOME,
        KeyEvent.KEYCODE_APP_SWITCH,
        KeyEvent.KEYCODE_POWER,
        KeyEvent.KEYCODE_VOLUME_UP,
        KeyEvent.KEYCODE_VOLUME_DOWN
    )

    companion object {
        private const val PERMISSION_REQUEST = 4001
    }
}
