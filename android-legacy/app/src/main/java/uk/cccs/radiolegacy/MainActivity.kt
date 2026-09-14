package uk.cccs.radiolegacy

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import org.json.JSONObject

/**
 * Legacy-handset shell: login once (token persisted in SharedPreferences —
 * "once the radio is logged in it needs to stay logged in"), then PTT and
 * panic only. No job list, no nav, no task screens — those stay on the MDT,
 * this device just tells the crew to go and look at it (see the
 * job.assigned_to_you handling below).
 *
 * NOT COMPILED OR RUN — no Android SDK available here. First real signal
 * comes from the CI build, same as every other native file in this project.
 */
class MainActivity : Activity(), CccsWebSocket.Listener, LocationListener {

    private val prefs by lazy { getSharedPreferences("cccs", Context.MODE_PRIVATE) }
    private val main = Handler(Looper.getMainLooper())
    private val audio = AudioEngine()
    private var ws: CccsWebSocket? = null
    private var locationManager: LocationManager? = null

    private var token: String? = null
    private var issi: String? = null
    private var radioId: Int? = null
    private var callsign: String? = null
    private var talkgroup: String? = null
    private var lastFix: Location? = null

    private var pttHeld = false
    private var pttGranted = false

    private lateinit var loginScreen: View
    private lateinit var mainScreen: View
    private lateinit var loginUsername: EditText
    private lateinit var loginPassword: EditText
    private lateinit var loginButton: Button
    private lateinit var loginError: TextView
    private lateinit var statusLed: View
    private lateinit var linkStatus: TextView
    private lateinit var callsignLabel: TextView
    private lateinit var talkgroupLabel: TextView
    private lateinit var statusLabel: TextView
    private lateinit var pttButton: Button
    private lateinit var panicButton: Button
    private lateinit var logView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        bindViews()
        requestPermissions()

        Log.onLine = { line -> main.post { appendLog(line) } }

        loginButton.setOnClickListener { doLogin() }
        pttButton.setOnTouchListener { _, event -> onPttTouch(event) }
        panicButton.setOnClickListener { doPanic() }

        token = prefs.getString(KEY_TOKEN, null)
        issi = prefs.getString(KEY_ISSI, null)
        radioId = if (prefs.contains(KEY_RADIO_ID)) prefs.getInt(KEY_RADIO_ID, -1) else null
        callsign = prefs.getString(KEY_CALLSIGN, null)

        if (token != null) showMain() else showLogin()
    }

    override fun onDestroy() {
        super.onDestroy()
        ws?.close()
        audio.stopCapture()
        audio.releasePlayback()
        try { locationManager?.removeUpdates(this) } catch (_: Exception) {}
    }

    private fun bindViews() {
        loginScreen = findViewById(R.id.loginScreen)
        mainScreen = findViewById(R.id.mainScreen)
        loginUsername = findViewById(R.id.loginUsername)
        loginPassword = findViewById(R.id.loginPassword)
        loginButton = findViewById(R.id.loginButton)
        loginError = findViewById(R.id.loginError)
        statusLed = findViewById(R.id.statusLed)
        linkStatus = findViewById(R.id.linkStatus)
        callsignLabel = findViewById(R.id.callsignLabel)
        talkgroupLabel = findViewById(R.id.talkgroupLabel)
        statusLabel = findViewById(R.id.statusLabel)
        pttButton = findViewById(R.id.pttButton)
        panicButton = findViewById(R.id.panicButton)
        logView = findViewById(R.id.logView)
    }

    /** Runtime permission prompts don't exist before API 23 — on the real
     * target hardware (Android 4.4.2 / API 19) everything in the manifest
     * is granted at install time, so this whole path is a no-op there. It
     * only matters if this build ever runs on a newer device. Uses the
     * plain framework Activity/Context methods (API 23+), not AndroidX's
     * ActivityCompat/ContextCompat — this project has no AndroidX
     * dependency at all, deliberately, to keep minSdk 19 usable. */
    private fun requestPermissions() {
        if (Build.VERSION.SDK_INT < 23) return
        val needed = arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.ACCESS_FINE_LOCATION)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isNotEmpty()) requestPermissions(needed.toTypedArray(), PERMISSION_REQUEST)
    }

    // -- Login ------------------------------------------------------------

    private fun doLogin() {
        val username = loginUsername.text.toString().trim()
        val password = loginPassword.text.toString()
        if (username.isEmpty() || password.isEmpty()) {
            loginError.text = "Enter a username and password"
            return
        }
        loginButton.isEnabled = false
        loginError.text = ""
        Thread {
            try {
                val result = Api.login(username, password)
                if (result.role != "RADIO_USER" || result.radioId == null) {
                    main.post {
                        loginError.text = "This account isn't set up as a radio"
                        loginButton.isEnabled = true
                    }
                    return@Thread
                }
                prefs.edit()
                    .putString(KEY_TOKEN, result.token)
                    .putInt(KEY_RADIO_ID, result.radioId)
                    .putString(KEY_DISPLAY_NAME, result.displayName)
                    .apply()
                token = result.token
                radioId = result.radioId
                main.post {
                    loginButton.isEnabled = true
                    showMain()
                }
            } catch (e: Exception) {
                main.post {
                    loginError.text = e.message ?: "Login failed"
                    loginButton.isEnabled = true
                }
            }
        }.start()
    }

    private fun showLogin() {
        loginScreen.visibility = View.VISIBLE
        mainScreen.visibility = View.GONE
    }

    private fun showMain() {
        loginScreen.visibility = View.GONE
        mainScreen.visibility = View.VISIBLE
        startLocationUpdates()
        connectWs()
    }

    // -- WebSocket ----------------------------------------------------------

    private fun connectWs() {
        val t = token ?: return
        ws?.close()
        val socket = CccsWebSocket(Api.HOST, 443, "/ws?token=${java.net.URLEncoder.encode(t, "UTF-8")}", secure = true)
        socket.listener = this
        ws = socket
        socket.connect()
    }

    override fun onOpen() {
        main.post { linkStatus.text = "CONNECTING" }
        val payload = JSONObject()
        radioId?.let { payload.put("radio_id", it) }
        issi?.let { payload.put("issi", it) }
        ws?.sendText(JSONObject().put("type", "radio.attach").put("payload", payload).toString())
    }

    override fun onText(text: String) {
        val msg = try { JSONObject(text) } catch (_: Exception) { return }
        val type = msg.optString("type")
        val payload = msg.optJSONObject("payload") ?: JSONObject()
        main.post { handleMessage(type, payload) }
    }

    override fun onBinary(data: ByteArray) {
        // Only arrives while this radio is listening on the held talkgroup —
        // see relayAudioFrame() server-side, which won't send it otherwise.
        audio.playChunk(data)
    }

    override fun onClosed() {
        main.post {
            linkStatus.text = "LINK DOWN"
            setLed("#4b5563")
            pttGranted = false
        }
        // Simple fixed backoff — this handset has nothing better to do while
        // waiting, and a tight retry loop would just hammer the server.
        main.postDelayed({ if (token != null) connectWs() }, RECONNECT_DELAY_MS)
    }

    private fun handleMessage(type: String, payload: JSONObject) {
        when (type) {
            "radio.attached" -> {
                issi = payload.optString("issi", issi)
                callsign = payload.optString("callsign", callsign)
                talkgroup = if (payload.isNull("talkgroup")) null else payload.optString("talkgroup")
                prefs.edit().putString(KEY_ISSI, issi).putString(KEY_CALLSIGN, callsign).apply()
                linkStatus.text = "LINK UP"
                callsignLabel.text = callsign ?: issi ?: "---"
                talkgroupLabel.text = talkgroup ?: "no talkgroup"
                applyStatus(payload.optString("status", "AVAILABLE"))
                appendLog("REGISTERED ISSI ${issi ?: "?"}")
            }
            "radio.status_changed" -> {
                if (payload.optString("issi") != issi) return
                talkgroup = if (payload.isNull("talkgroup")) null else payload.optString("talkgroup")
                talkgroupLabel.text = talkgroup ?: "no talkgroup"
                applyStatus(payload.optString("status", statusLabel.text.toString()))
            }
            "job.assigned_to_you" -> {
                val resources = payload.optJSONArray("resources")
                var mine = false
                if (resources != null) {
                    for (i in 0 until resources.length()) {
                        if (resources.optJSONObject(i)?.optString("radio") == issi) { mine = true; break }
                    }
                }
                if (!mine) return
                val jobId = payload.optInt("id", -1)
                val reference = payload.optString("reference", "")
                appendLog("NEW JOB $reference")
                showJobAssignedDialog(jobId, reference)
            }
            "ptt.granted" -> {
                pttGranted = true
                if (pttHeld) {
                    pttButton.text = "TRANSMITTING"
                    audio.startCapture { chunk -> ws?.sendBinary(chunk) }
                }
            }
            "ptt.denied" -> {
                pttGranted = false
                pttHeld = false
                pttButton.text = "HOLD TO TALK"
                appendLog("PTT DENIED — ${payload.optString("holder", "channel busy")}")
            }
            "radio.ptt_started" -> {
                if (payload.optString("issi") == issi) return // that's us, handled by ptt.granted
                appendLog("RX ${payload.optString("callsign", "")}")
            }
            "radio.ptt_released" -> {
                // Nothing to do — playback stops naturally when frames stop arriving.
            }
            "emergency.acknowledged" -> {
                if (payload.optString("issi") == issi) appendLog("EMERGENCY ACKNOWLEDGED BY ${payload.optString("acknowledged_by", "control")}")
            }
            "emergency.resolved" -> {
                if (payload.optString("issi") == issi) appendLog("EMERGENCY RESET BY CONTROL")
            }
            "error" -> appendLog("ERROR: ${payload.optString("message", "")}")
        }
    }

    private fun applyStatus(status: String) {
        statusLabel.text = status
        setLed(colourForStatus(status))
        StatusLed.setStatus(this, status)
    }

    private fun colourForStatus(status: String): String = when (status) {
        "EMERGENCY" -> "#ef4444"
        "AVAILABLE" -> "#22c55e"
        "ACKNOWLEDGED", "EN_ROUTE", "ON_SCENE", "ON_TASK" -> "#3b82f6"
        else -> "#4b5563"
    }

    private fun setLed(colourHex: String) {
        try { statusLed.setBackgroundColor(android.graphics.Color.parseColor(colourHex)) } catch (_: Exception) {}
    }

    private fun showJobAssignedDialog(jobId: Int, reference: String) {
        val dialog = AlertDialog.Builder(this)
            .setTitle("INCIDENT ASSIGNED")
            .setMessage("Please return to vehicle")
            .setPositiveButton("Accept") { _, _ -> acknowledgeJob(jobId, reference) }
            .setCancelable(false)
            .create()
        dialog.show()
    }

    private fun acknowledgeJob(jobId: Int, reference: String) {
        val t = token ?: return
        if (jobId < 0) return
        Thread {
            try {
                Api.acknowledgeJob(t, jobId)
                main.post { appendLog("ACKNOWLEDGED $reference") }
            } catch (e: Exception) {
                main.post { appendLog("ACK FAILED: ${e.message}") }
            }
        }.start()
    }

    // -- PTT ------------------------------------------------------------

    private fun onPttTouch(event: MotionEvent): Boolean {
        when (event.action) {
            MotionEvent.ACTION_DOWN -> startPtt()
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> stopPtt()
        }
        return true
    }

    private fun startPtt() {
        if (pttHeld || talkgroup == null) return
        pttHeld = true
        pttButton.text = "REQUESTING…"
        val payload = JSONObject().put("talkgroup", talkgroup).put("as_radio", issi)
        ws?.sendText(JSONObject().put("type", "radio.ptt_start").put("payload", payload).toString())
    }

    private fun stopPtt() {
        if (!pttHeld) return
        pttHeld = false
        pttButton.text = "HOLD TO TALK"
        if (pttGranted) {
            audio.stopCapture()
            val payload = JSONObject().put("talkgroup", talkgroup).put("as_radio", issi)
            ws?.sendText(JSONObject().put("type", "radio.ptt_release").put("payload", payload).toString())
        }
        pttGranted = false
    }

    // -- Panic ------------------------------------------------------------

    private fun doPanic() {
        val t = token ?: return
        panicButton.isEnabled = false
        appendLog("EMERGENCY — sending...")
        // Take a fresh fix if one's already on file from the location
        // listener below; a stale/absent fix isn't worth blocking on since
        // the server falls back to the radio's last known position anyway
        // (see Api.emergency's doc comment).
        val fix = lastFix
        Thread {
            try {
                Api.emergency(t, fix?.latitude, fix?.longitude)
                main.post { appendLog("EMERGENCY SENT"); panicButton.isEnabled = true }
            } catch (e: Exception) {
                main.post { appendLog("EMERGENCY FAILED: ${e.message}"); panicButton.isEnabled = true }
            }
        }.start()
    }

    // -- Location ------------------------------------------------------------

    private fun startLocationUpdates() {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        locationManager = lm
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, LOCATION_INTERVAL_MS, 25f, this)
        } catch (_: Exception) {}
    }

    override fun onLocationChanged(location: Location) { lastFix = location }
    @Deprecated("Deprecated in Java") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    // -- Hardware keys ------------------------------------------------------

    // Rugged handsets disagree about which keycode their side PTT/panic
    // buttons send, and this project doesn't have a settings screen to
    // configure it (unlike the main app — see its MainActivity.kt). Until
    // this is confirmed against the real device, log every non-OS key so
    // the right code can be identified, and treat it as PTT by default
    // since that's the control every handset in this fleet has.
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (shouldHandle(keyCode)) {
            if (event.repeatCount == 0) { appendLog("KEY DOWN $keyCode"); startPtt() }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (shouldHandle(keyCode)) {
            appendLog("KEY UP $keyCode")
            stopPtt()
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun shouldHandle(keyCode: Int): Boolean = keyCode !in setOf(
        KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_APP_SWITCH,
        KeyEvent.KEYCODE_POWER, KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN
    )

    private fun appendLog(line: String) {
        logView.append(line + "\n")
    }

    companion object {
        private const val KEY_TOKEN = "token"
        private const val KEY_ISSI = "issi"
        private const val KEY_RADIO_ID = "radio_id"
        private const val KEY_CALLSIGN = "callsign"
        private const val KEY_DISPLAY_NAME = "display_name"
        private const val PERMISSION_REQUEST = 4001
        private const val RECONNECT_DELAY_MS = 4000L
        private const val LOCATION_INTERVAL_MS = 15000L
    }
}
