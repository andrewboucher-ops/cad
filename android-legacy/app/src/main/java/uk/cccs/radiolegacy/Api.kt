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
     * web radio. Audio once connected is PTT, not full-duplex like a
     * modern client's WebRTC call -- this hardware only has the one PTT
     * button -- and is scoped server-side to just this call's own
     * participants (see callPttStart in server.js), never the talkgroup. */
    fun startPrivateCall(token: String, toIssi: String): JSONObject =
        postAuthed("/api/calls/private", token, JSONObject().put("to", toIssi))

    fun acknowledgeJob(token: String, jobId: Int): JSONObject =
        postAuthed("/api/jobs/$jobId/ack", token, JSONObject())

    /** Answering an incoming call.incoming (radio-to-radio or inbound PSTN
     * targeting this handset). No body needed -- the server resolves this
     * handset's own radio from the token, same as setStatus/requestCall. */
    fun acceptCall(token: String, callId: Int): JSONObject =
        postAuthed("/api/calls/$callId/accept", token, JSONObject())
    fun rejectCall(token: String, callId: Int): JSONObject =
        postAuthed("/api/calls/$callId/reject", token, JSONObject())

    class VersionInfo(val versionCode: Int, val versionName: String, val url: String, val notes: String)

    /** No auth needed -- it's the same publicly-downloadable path the APK
     * itself already sits at (see /downloads/ on the server), just a
     * sibling JSON file naming whatever build is currently hosted there.
     * Server side is a plain static file, updated by hand alongside every
     * new build -- see the comment on versionCode in build.gradle. */
    fun checkLatestVersion(): VersionInfo {
        val url = URL("$BASE_URL/downloads/cccs-radio-legacy-version.json")
        val conn = open(url)
        conn.requestMethod = "GET"
        conn.connectTimeout = 10000
        conn.readTimeout = 10000
        val status = conn.responseCode
        if (status !in 200..299) throw Exception("no version info published (HTTP $status)")
        val text = conn.inputStream.bufferedReader().use { it.readText() }
        val json = JSONObject(text)
        return VersionInfo(
            versionCode = json.getInt("versionCode"),
            versionName = json.getString("versionName"),
            url = json.getString("url"),
            notes = json.optString("notes", "")
        )
    }

    /** Streams the APK to destFile, calling onProgress(0-100) as it goes
     * when the server sends a Content-Length (it always does for a static
     * file, but this degrades to no progress callbacks rather than
     * crashing if that ever changes). Runs on the calling thread -- callers
     * must not call this from the UI thread. */
    fun downloadApk(path: String, destFile: java.io.File, onProgress: ((Int) -> Unit)? = null) {
        val url = URL(if (path.startsWith("http")) path else "$BASE_URL$path")
        val conn = open(url)
        conn.requestMethod = "GET"
        conn.connectTimeout = 10000
        conn.readTimeout = 30000
        val status = conn.responseCode
        if (status !in 200..299) throw Exception("download failed (HTTP $status)")
        val total = conn.contentLength
        var written = 0
        conn.inputStream.use { input ->
            destFile.outputStream().use { output ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    output.write(buf, 0, n)
                    written += n
                    if (total > 0) onProgress?.invoke((written * 100L / total).toInt())
                }
            }
        }
    }
}
