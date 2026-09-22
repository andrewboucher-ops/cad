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
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
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
    private var locked = false
    private var dialBuffer = ""
    private var activeCallId = -1

    private var pttHeld = false
    private var pttGranted = false

    private lateinit var loginScreen: View
    private lateinit var mainScreen: View
    private lateinit var loginIssi: Spinner
    private lateinit var loginPin: EditText
    private lateinit var loginButton: Button
    private lateinit var loginError: TextView
    private var directory: List<Api.DirectoryEntry> = emptyList()
    private lateinit var statusLed: View
    private lateinit var linkStatus: TextView
    private lateinit var callsignLabel: TextView
    private lateinit var talkgroupLabel: TextView
    private lateinit var statusLabel: TextView
    private lateinit var pttState: TextView
    private var panicBusy = false
    private var pttKey = -1
    private var panicKey = -1
    private lateinit var logView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Tls.init(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        bindViews()
        requestPermissions()

        Log.onLine = { line -> main.post { appendLog(line) } }

        loginButton.setOnClickListener { doLogin() }
        pttKey = prefs.getInt(KEY_PTT_KEY, DEFAULT_PTT_KEY)
        panicKey = prefs.getInt(KEY_PANIC_KEY, DEFAULT_PANIC_KEY)
        // Self-heal a key learned before isReservedKey() existed -- a PTT or
        // panic key that collided with *, #, the soft key or a digit is not
        // a cosmetic bug: it can make the lock unrecoverable (this happened
        // today) or, worse, mean the real panic button does nothing in an
        // actual emergency. Silently repaired on every launch, not just
        // flagged for the next trip through Settings.
        if (isReservedKey(pttKey)) { pttKey = DEFAULT_PTT_KEY; prefs.edit().putInt(KEY_PTT_KEY, DEFAULT_PTT_KEY).apply() }
        if (isReservedKey(panicKey)) { panicKey = DEFAULT_PANIC_KEY; prefs.edit().putInt(KEY_PANIC_KEY, DEFAULT_PANIC_KEY).apply() }

        token = prefs.getString(KEY_TOKEN, null)
        issi = prefs.getString(KEY_ISSI, null)
        radioId = if (prefs.contains(KEY_RADIO_ID)) prefs.getInt(KEY_RADIO_ID, -1) else null
        callsign = prefs.getString(KEY_CALLSIGN, null)

        if (token != null) showMain() else { showLogin(); loadDirectory() }
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
        loginIssi = findViewById(R.id.loginIssi)
        loginPin = findViewById(R.id.loginPin)
        loginButton = findViewById(R.id.loginButton)
        loginError = findViewById(R.id.loginError)
        statusLed = findViewById(R.id.statusLed)
        linkStatus = findViewById(R.id.linkStatus)
        callsignLabel = findViewById(R.id.callsignLabel)
        talkgroupLabel = findViewById(R.id.talkgroupLabel)
        statusLabel = findViewById(R.id.statusLabel)
        pttState = findViewById(R.id.pttState)
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

    /** No username/password to type — just the list of radios control has
     * already set up (see GET /api/radios/directory), so the only typing
     * left on this login screen is the PIN. */
    private fun loadDirectory() {
        Thread {
            try {
                val entries = Api.directory()
                main.post {
                    directory = entries
                    val labels = if (entries.isEmpty()) listOf("No radios configured yet")
                        else entries.map { e -> (if (e.callsign != null) "${e.callsign} — " else "") + (e.alias ?: e.issi) + " (${e.issi})" }
                    loginIssi.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
                }
            } catch (e: Exception) {
                main.post { loginError.text = e.message ?: "Could not load radio list" }
            }
        }.start()
    }

    private fun doLogin() {
        val entry = directory.getOrNull(loginIssi.selectedItemPosition)
        val pin = loginPin.text.toString().trim()
        if (entry == null) {
            loginError.text = "No radio selected"
            return
        }
        if (pin.length != 6) {
            loginError.text = "Enter the 6-digit PIN"
            return
        }
        loginButton.isEnabled = false
        loginError.text = ""
        Thread {
            try {
                val result = Api.loginRadio(entry.issi, pin)
                if (result.role != "RADIO_USER" || result.radioId == null) {
                    main.post {
                        loginError.text = "This ISSI isn't set up as a radio"
                        loginButton.isEnabled = true
                    }
                    return@Thread
                }
                prefs.edit()
                    .putString(KEY_TOKEN, result.token)
                    .putInt(KEY_RADIO_ID, result.radioId)
                    .putString(KEY_ISSI, result.issi)
                    .putString(KEY_DISPLAY_NAME, result.displayName)
                    .apply()
                token = result.token
                radioId = result.radioId
                issi = result.issi
                main.post {
                    loginButton.isEnabled = true
                    showMain()
                }
            } catch (e: Exception) {
                main.post {
                    loginError.text = e.message ?: "Sign-in failed"
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
        // Tells the server this floor time's audio comes as the binary
        // frames relayAudioFrame() forwards, not a WebRTC offer this app
        // never sends -- see server.js's radio.attach handler.
        payload.put("client", "legacy")
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
                    pttState.text = "TRANSMITTING"
                    pttState.setBackgroundColor(android.graphics.Color.parseColor("#b91c1c"))
                    audio.startCapture { chunk -> ws?.sendBinary(chunk) }
                }
            }
            "ptt.denied" -> {
                pttGranted = false
                pttHeld = false
                setPttIdle()
                appendLog("PTT DENIED — ${payload.optString("holder", "channel busy")}")
            }
            "radio.ptt_started" -> {
                if (payload.optString("issi") == issi) return // that's us, handled by ptt.granted
                pttState.text = "RX ${payload.optString("callsign", "")}"
                pttState.setBackgroundColor(android.graphics.Color.parseColor("#15803d"))
            }
            "radio.ptt_released" -> {
                // Playback stops naturally when frames stop arriving; just clear the indicator.
                if (!pttHeld) setPttIdle()
            }
            "call.accepted" -> {
                if (payload.optInt("id", -1) == activeCallId) { appendLog("CALL CONNECTED (no audio on this handset)"); pttState.text = "ON CALL" }
            }
            "call.rejected" -> {
                if (payload.optInt("id", -1) == activeCallId) { appendLog("CALL DECLINED"); activeCallId = -1; setPttIdle() }
            }
            "call.ended" -> {
                if (payload.optInt("id", -1) == activeCallId) { appendLog("CALL ENDED"); activeCallId = -1; setPttIdle() }
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

    private fun setPttIdle() {
        pttState.text = "READY"
        pttState.setBackgroundColor(android.graphics.Color.parseColor("#1f2937"))
    }

    private fun startPtt() {
        if (pttHeld || talkgroup == null) return
        pttHeld = true
        pttState.text = "REQUESTING…"
        pttState.setBackgroundColor(android.graphics.Color.parseColor("#b45309"))
        val payload = JSONObject().put("talkgroup", talkgroup).put("as_radio", issi)
        ws?.sendText(JSONObject().put("type", "radio.ptt_start").put("payload", payload).toString())
        main.postDelayed({
            if (pttHeld && !pttGranted) {
                pttState.text = "NO RESPONSE"
                appendLog("PTT: no answer from server (link ${linkStatus.text})")
            }
        }, PTT_RESPONSE_TIMEOUT_MS)
    }

    private fun stopPtt() {
        if (!pttHeld) return
        pttHeld = false
        setPttIdle()
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
        if (panicBusy) return
        panicBusy = true
        appendLog("EMERGENCY - sending...")
        // Take a fresh fix if one's already on file from the location
        // listener below; a stale/absent fix isn't worth blocking on since
        // the server falls back to the radio's last known position anyway
        // (see Api.emergency's doc comment).
        val fix = lastFix
        Thread {
            try {
                Api.emergency(t, fix?.latitude, fix?.longitude)
                main.post { appendLog("EMERGENCY SENT"); panicBusy = false; showPanicResult("EMERGENCY SENT") }
            } catch (e: Exception) {
                main.post { appendLog("EMERGENCY FAILED: ${e.message}"); panicBusy = false; showPanicResult("EMERGENCY FAILED") }
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
    // buttons send, so nothing is hardcoded: MENU > "Set PTT button" / "Set
    // panic button" learns the key by asking for it to be pressed, and stores
    // it. Until a PTT key has been learned, any non-ordinary key acts as PTT
    // so a fresh handset is usable straight away. Panic has no fallback on
    // purpose: an unassigned key must never raise a real emergency.
    private fun isPttKey(keyCode: Int) = if (pttKey >= 0) keyCode == pttKey else isPttCandidate(keyCode)

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (mainScreen.visibility != View.VISIBLE) return super.onKeyDown(keyCode, event)
        val first = event.repeatCount == 0
        if (first) appendLog("KEY $keyCode")
        // PTT, panic and the lock toggle itself always work, locked or not --
        // a locked keypad in a pocket must never block transmit or emergency.
        if (keyCode == panicKey) { if (first) beginPanicHold(); return true }
        if (isPttKey(keyCode)) { if (first) { if (dialBuffer.isNotEmpty()) placeCall() else startPtt() }; return true }
        if (keyCode == KeyEvent.KEYCODE_STAR) { if (first) beginLockHold(); return true }
        if (locked) { if (first) appendLog("LOCKED - hold * to unlock"); return true }
        // Left soft key: status list directly, no intermediate menu -- that's
        // the one thing worth a single press. Everything else (PTT/panic
        // assignment, sign out) lives behind a hold on # instead, so it's not
        // one press away from an accidental status change.
        //
        // DPAD_CENTER is here on purpose, not a leftover: earlier testing
        // said this handset has no separate OK/centre button, so that
        // wiring was removed as dead code -- turns out the soft key itself
        // sends DPAD_CENTER's code (23) on this hardware, so removing it
        // silently broke the soft key too. Confirmed from the real device,
        // not a guess this time.
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SOFT_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_CENTER) { if (first) showStatusMenu(); return true }
        if (keyCode == KeyEvent.KEYCODE_POUND) { if (first) beginSettingsHold(); return true }
        // 1 is dual-purpose: a tap dials it (see onKeyUp), a hold sends a
        // call request instead -- same tap/hold split as PTT-vs-dial below.
        if (keyCode == KeyEvent.KEYCODE_1) { if (first) beginCallRequestHold(); return true }
        if (keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) { if (first) onDialDigit(keyCode); return true }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (mainScreen.visibility == View.VISIBLE) {
            if (keyCode == panicKey) { cancelPanicHold(); return true }
            if (isPttKey(keyCode)) { stopPtt(); return true }
            if (keyCode == KeyEvent.KEYCODE_STAR) { cancelLockHold(); return true }
            if (keyCode == KeyEvent.KEYCODE_POUND) { cancelSettingsHold(); return true }
            // A short tap never reaches the call-request hold threshold --
            // cancelCallRequestHold() reports that back so it can be treated
            // as an ordinary dialled digit instead of doing nothing.
            if (keyCode == KeyEvent.KEYCODE_1) { if (cancelCallRequestHold() && !locked) onDialDigit(keyCode); return true }
        }
        return super.onKeyUp(keyCode, event)
    }

    // Dialling an ISSI then pressing PTT places a radio-to-radio call (no
    // lock check needed here -- locked already blocks reaching this code).
    // 12 digits is generously past any real ISSI, just to stop a stuck key
    // from growing the buffer forever.
    private fun onDialDigit(keyCode: Int) {
        if (dialBuffer.length >= 12) return
        dialBuffer += (keyCode - KeyEvent.KEYCODE_0).toString()
        pttState.text = "DIAL $dialBuffer"
        pttState.setBackgroundColor(android.graphics.Color.parseColor("#1f2937"))
    }

    private fun placeCall() {
        val t = token ?: return
        val toIssi = dialBuffer
        dialBuffer = ""
        pttState.text = "CALLING $toIssi"
        pttState.setBackgroundColor(android.graphics.Color.parseColor("#b45309"))
        Thread {
            try {
                val result = Api.startPrivateCall(t, toIssi)
                activeCallId = result.optInt("id", -1)
                // No audio path for this yet -- see Api.startPrivateCall's
                // doc comment for why. The call record connects; only its
                // sound doesn't reach this handset.
                main.post { appendLog("CALLING $toIssi (no audio on this handset yet)") }
            } catch (e: Exception) {
                main.post { appendLog("CALL FAILED: ${e.message}"); setPttIdle() }
            }
        }.start()
    }

    private val lockHoldRunnable = Runnable {
        lockHolding = false
        locked = !locked
        dialBuffer = ""
        appendLog(if (locked) "LOCKED" else "UNLOCKED")
        setPttIdle()
    }
    private var lockHolding = false

    private fun beginLockHold() {
        if (lockHolding) return
        lockHolding = true
        main.postDelayed(lockHoldRunnable, LOCK_HOLD_MS)
    }

    private fun cancelLockHold() {
        if (!lockHolding) return
        lockHolding = false
        main.removeCallbacks(lockHoldRunnable)
    }

    private val settingsHoldRunnable = Runnable { settingsHolding = false; showMenu() }
    private var settingsHolding = false

    private fun beginSettingsHold() {
        if (settingsHolding) return
        settingsHolding = true
        main.postDelayed(settingsHoldRunnable, SETTINGS_HOLD_MS)
    }

    private fun cancelSettingsHold() {
        if (!settingsHolding) return
        settingsHolding = false
        main.removeCallbacks(settingsHoldRunnable)
    }

    // Not safety-critical like panic, but still deliberate -- a short hold
    // rather than firing on the first press of a key someone might otherwise
    // just be passing over while typing.
    private val callRequestHoldRunnable = Runnable {
        callRequestHolding = false
        val t = token ?: return@Runnable
        appendLog("CALL REQUEST - sending")
        Thread {
            try { Api.requestCall(t, false); main.post { appendLog("CALL REQUESTED") } }
            catch (e: Exception) { main.post { appendLog("CALL REQUEST FAILED: ${e.message}") } }
        }.start()
    }
    private var callRequestHolding = false

    private fun beginCallRequestHold() {
        if (callRequestHolding) return
        callRequestHolding = true
        main.postDelayed(callRequestHoldRunnable, CALL_REQUEST_HOLD_MS)
    }

    /** Returns true if the hold never fired (a short tap), so the caller
     * can treat it as a dialled digit instead. */
    private fun cancelCallRequestHold(): Boolean {
        if (!callRequestHolding) return false
        callRequestHolding = false
        main.removeCallbacks(callRequestHoldRunnable)
        return true
    }

    // An emergency goes straight to the alarm receiving centre, so a brush
    // against the button must not raise one: it has to be held.
    private val panicHoldRunnable = Runnable {
        panicHolding = false
        appendLog("EMERGENCY - held, sending")
        doPanic()
    }
    private var panicHolding = false

    private fun beginPanicHold() {
        if (panicHolding) return
        panicHolding = true
        pttState.text = "HOLD FOR EMERGENCY"
        pttState.setBackgroundColor(android.graphics.Color.parseColor("#b91c1c"))
        main.postDelayed(panicHoldRunnable, PANIC_HOLD_MS)
    }

    private fun showPanicResult(text: String) {
        pttState.text = text
        pttState.setBackgroundColor(android.graphics.Color.parseColor("#b91c1c"))
        main.postDelayed({ if (!pttHeld) setPttIdle() }, 6000)
    }

    private fun cancelPanicHold() {
        if (!panicHolding) return
        panicHolding = false
        main.removeCallbacks(panicHoldRunnable)
        setPttIdle()
    }

    // -- Menu, status and key learning ---------------------------------------

    // Same codes as the server's STATUS_CODES (and the web radio's picker).
    private val statusChoices = listOf(
        "01" to "Available", "02" to "Busy", "03" to "En route", "04" to "On scene / at site",
        "05" to "On task", "06" to "Site clear, resuming patrol", "07" to "Meal break", "08" to "Out of service"
    )

    // Change status isn't here — it's one press of the soft key, not behind
    // this hold-# settings menu.
    private fun showMenu() {
        val items = arrayOf("Set PTT button", "Set panic button", "Sign out")
        AlertDialog.Builder(this).setTitle("Settings").setItems(items) { _, which ->
            when (which) {
                0 -> learnKey("PTT")
                1 -> learnKey("panic")
                2 -> signOut()
            }
        }.show()
    }

    private fun showStatusMenu() {
        val t = token ?: return
        val who = issi ?: return
        AlertDialog.Builder(this).setTitle("Set status")
            .setItems(statusChoices.map { it.second }.toTypedArray()) { _, which ->
                val (code, label) = statusChoices[which]
                appendLog("STATUS -> $label")
                Thread {
                    try { Api.setStatus(t, who, code) }
                    catch (e: Exception) { main.post { appendLog("STATUS FAILED: ${e.message}") } }
                }.start()
            }.show()
    }

    private fun isReservedKey(keyCode: Int): Boolean = keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 ||
        keyCode in setOf(KeyEvent.KEYCODE_STAR, KeyEvent.KEYCODE_POUND, KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SOFT_LEFT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_BACK)

    private fun learnKey(kind: String) {
        val dialog = AlertDialog.Builder(this)
            .setTitle("Set $kind button")
            .setMessage("Press the $kind button now")
            .setNegativeButton("Cancel", null)
            .create()
        dialog.setOnKeyListener { d, keyCode, event ->
            if (event.action != KeyEvent.ACTION_DOWN || keyCode == KeyEvent.KEYCODE_BACK) return@setOnKeyListener false
            // A wrong press here (e.g. a digit meant for dialling) would
            // silently steal that key from whatever it's really for, since
            // PTT/panic are checked first in onKeyDown -- happened during
            // testing today. Refuse anything already spoken for instead.
            if (isReservedKey(keyCode)) {
                appendLog("$kind: key $keyCode is used for something else, try again")
                return@setOnKeyListener true
            }
            if (kind == "PTT") { pttKey = keyCode; prefs.edit().putInt(KEY_PTT_KEY, keyCode).apply() }
            else { panicKey = keyCode; prefs.edit().putInt(KEY_PANIC_KEY, keyCode).apply() }
            appendLog("$kind button set to key $keyCode")
            d.dismiss()
            true
        }
        dialog.show()
    }

    private fun signOut() {
        ws?.close()
        ws = null
        audio.stopCapture()
        try { locationManager?.removeUpdates(this) } catch (_: Exception) {}
        prefs.edit().remove(KEY_TOKEN).remove(KEY_ISSI).remove(KEY_RADIO_ID).remove(KEY_CALLSIGN).apply()
        token = null; issi = null; radioId = null; callsign = null; talkgroup = null
        locked = false; dialBuffer = ""; activeCallId = -1
        logView.text = ""
        setPttIdle()
        showLogin()
        loadDirectory()
    }

    // Ordinary keypad keys (digits, D-pad, soft keys, call/end, star/hash...)
    // are never PTT candidates.
    private fun isPttCandidate(keyCode: Int): Boolean = when {
        keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> false
        keyCode in setOf(
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_POWER,
            KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SEARCH,
            KeyEvent.KEYCODE_CALL, KeyEvent.KEYCODE_ENDCALL, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_STAR,
            KeyEvent.KEYCODE_POUND, KeyEvent.KEYCODE_DEL, KeyEvent.KEYCODE_CLEAR, KeyEvent.KEYCODE_SOFT_LEFT,
            KeyEvent.KEYCODE_SOFT_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER
        ) -> false
        else -> true
    }

    private fun appendLog(line: String) {
        logView.append(line + "\n")
    }

    companion object {
        private const val KEY_TOKEN = "token"
        private const val KEY_ISSI = "issi"
        private const val KEY_RADIO_ID = "radio_id"
        private const val KEY_CALLSIGN = "callsign"
        private const val KEY_DISPLAY_NAME = "display_name"
        // Read off the real handset: its physical PTT button sends key 0
        // (KEYCODE_UNKNOWN — the OEM never mapped it to a real Android key),
        // and its emergency button sends key 67. Both are exact matches now
        // rather than relying on the general non-keypad fallback, so a
        // future stray/unmapped key elsewhere can't be mistaken for either.
        private const val DEFAULT_PTT_KEY = 0
        private const val DEFAULT_PANIC_KEY = 67
        private const val SETTINGS_HOLD_MS = 1200L
        private const val CALL_REQUEST_HOLD_MS = 800L
        private const val LOCK_HOLD_MS = 1000L
        private const val PANIC_HOLD_MS = 1500L
        private const val KEY_PTT_KEY = "ptt_keycode"
        private const val KEY_PANIC_KEY = "panic_keycode"
        private const val PERMISSION_REQUEST = 4001
        private const val RECONNECT_DELAY_MS = 4000L
        private const val PTT_RESPONSE_TIMEOUT_MS = 3000L
        private const val LOCATION_INTERVAL_MS = 15000L
    }
}
