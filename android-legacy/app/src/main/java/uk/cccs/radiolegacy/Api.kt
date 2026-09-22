package uk.cccs.radiolegacy

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Plain HttpURLConnection + org.json — both built into Android since API 1,
 * so no HTTP/JSON library dependency, same reasoning as everywhere else in
 * this app. Only what this app actually needs: logging in. Everything else
 * (status, PTT, jobs data if ever needed) rides the WebSocket connection
 * once it's open, same pattern the main web app already uses.
 */
object Api {
    const val HOST = "comms.echeloncic.com"
    const val BASE_URL = "https://$HOST"

    /** Every request goes through the TLS-1.2-enabled factory in Tls.kt —
     * a stock connection on Android 4.4 only offers TLS 1.0, which the
     * server refuses. */
    private fun open(url: URL): HttpURLConnection {
        val conn = url.openConnection() as HttpsURLConnection
        conn.sslSocketFactory = Tls.factory
        return conn
    }

    class LoginResult(val token: String, val role: String, val displayName: String, val radioId: Int?, val issi: String?)
    class DirectoryEntry(val issi: String, val alias: String?, val callsign: String?)

    /** No username/password on this device — a radio signs in with just its
     * ISSI (picked from the directory below, not typed) and a short PIN
     * control sets when it assigns the ISSI to a callsign. See
     * /api/auth/radio-login in server.js. Runs on the calling thread —
     * callers must not call this from the UI thread. */
    fun loginRadio(issi: String, pin: String): LoginResult {
        val url = URL("$BASE_URL/api/auth/radio-login")
        val conn = open(url)
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.connectTimeout = 10000
        conn.readTimeout = 10000

        val body = JSONObject()
        body.put("issi", issi)
        body.put("pin", pin)
        conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream.bufferedReader().use { it.readText() }

        if (status !in 200..299) {
            val err = try { JSONObject(text).optString("error", "sign-in failed") } catch (_: Exception) { "sign-in failed" }
            throw Exception(err)
        }

        val json = JSONObject(text)
        val user = json.getJSONObject("user")
        return LoginResult(
            token = json.getString("token"),
            role = user.getString("role"),
            displayName = user.optString("display_name", issi),
            radioId = if (user.isNull("radio_id")) null else user.getInt("radio_id"),
            issi = issi
        )
    }

    /** Unauthenticated, deliberately minimal — just enough to fill the
     * sign-in screen's radio picker (see /api/radios/directory). */
    fun directory(): List<DirectoryEntry> {
        val url = URL("$BASE_URL/api/radios/directory")
        val conn = open(url)
        conn.requestMethod = "GET"
        conn.connectTimeout = 10000
        conn.readTimeout = 10000
        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream.bufferedReader().use { it.readText() }
        if (status !in 200..299) throw Exception("could not load radio list")
        val arr = org.json.JSONArray(text)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            DirectoryEntry(
                issi = o.getString("issi"),
                alias = if (o.isNull("alias")) null else o.optString("alias"),
                callsign = if (o.isNull("callsign")) null else o.optString("callsign")
            )
        }
    }

    /** POST with a bearer token, used for the two REST calls this app makes
     * outside of login: raising an emergency and acknowledging a job. Runs
     * on the calling thread, same contract as login(). */
    private fun postAuthed(path: String, token: String, body: JSONObject): JSONObject {
        val url = URL("$BASE_URL$path")
        val conn = open(url)
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.connectTimeout = 10000
        conn.readTimeout = 10000
        conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream.bufferedReader().use { it.readText() }
        if (status !in 200..299) {
            val err = try { JSONObject(text).optString("error", "request failed") } catch (_: Exception) { "request failed" }
            throw Exception(err)
        }
        return if (text.isNotBlank()) JSONObject(text) else JSONObject()
    }

    /** lat/lon come from a fresh GPS fix taken the instant the panic button
     * is pressed — matches the reasoning in radio.html's freshFix(): an
     * idle device's last-known position can be stale, so a fix taken now
     * beats whatever's already on file server-side. Either may be null if
     * no fix was available in time; the server keeps the radio's last
     * known position in that case rather than rejecting the call. */
    fun emergency(token: String, lat: Double?, lon: Double?): JSONObject {
        val body = JSONObject()
        if (lat != null && lon != null) { body.put("lat", lat); body.put("lon", lon) }
        return postAuthed("/api/emergency", token, body)
    }

    /** Same status codes the web radio uses (server STATUS_CODES): the server
     * maps a code to the status and syncs any linked job. The result comes
     * back to the app over the WebSocket as radio.status_changed. */
    fun setStatus(token: String, issi: String, code: String): JSONObject =
        postAuthed("/api/radios/$issi/status", token, JSONObject().put("code", code))

    /** "Request voice" — asks control for a callback, same endpoint the web
     * radio uses. A second press while one is already pending escalates it
     * to priority rather than stacking another request (server-side). */
    fun requestCall(token: String, priority: Boolean): JSONObject =
        postAuthed("/api/calls/request", token, JSONObject().put("priority", priority))

    /** Radio-to-radio, by ISSI. Placing the call and tracking its state
     * (RINGING/CONNECTED/ENDED, over the WebSocket) works the same as the
     * web radio; there is no audio path for it from this handset yet --
     * that rides WebRTC on the web app, which this device can't do (see
     * relayAudioFrame in server.js for why talkgroup PTT uses a different,
     * server-relayed path instead). Placing calls now, audio is separate
     * follow-up work. */
    fun startPrivateCall(token: String, toIssi: String): JSONObject =
        postAuthed("/api/calls/private", token, JSONObject().put("to", toIssi))

    fun acknowledgeJob(token: String, jobId: Int): JSONObject =
        postAuthed("/api/jobs/$jobId/ack", token, JSONObject())
}
