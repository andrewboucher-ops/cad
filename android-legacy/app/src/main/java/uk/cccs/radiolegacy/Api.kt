package uk.cccs.radiolegacy

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

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

    class LoginResult(val token: String, val role: String, val displayName: String, val radioId: Int?, val issi: String?)

    /** Runs on the calling thread — callers must not call this from the UI
     * thread; MainActivity always calls it from a background Thread. */
    fun login(username: String, password: String): LoginResult {
        val url = URL("$BASE_URL/api/auth/login")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.connectTimeout = 10000
        conn.readTimeout = 10000

        val body = JSONObject()
        body.put("username", username)
        body.put("password", password)
        conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream.bufferedReader().use { it.readText() }

        if (status !in 200..299) {
            val err = try { JSONObject(text).optString("error", "login failed") } catch (_: Exception) { "login failed" }
            throw Exception(err)
        }

        val json = JSONObject(text)
        val user = json.getJSONObject("user")
        return LoginResult(
            token = json.getString("token"),
            role = user.getString("role"),
            displayName = user.optString("display_name", username),
            radioId = if (user.isNull("radio_id")) null else user.getInt("radio_id"),
            issi = null // resolved from the radio.attach response once the WS is open, not known at login time
        )
    }

    /** POST with a bearer token, used for the two REST calls this app makes
     * outside of login: raising an emergency and acknowledging a job. Runs
     * on the calling thread, same contract as login(). */
    private fun postAuthed(path: String, token: String, body: JSONObject): JSONObject {
        val url = URL("$BASE_URL$path")
        val conn = url.openConnection() as HttpURLConnection
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

    fun acknowledgeJob(token: String, jobId: Int): JSONObject =
        postAuthed("/api/jobs/$jobId/ack", token, JSONObject())
}
