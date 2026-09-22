package uk.cccs.radiolegacy

import android.util.Base64
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLSocket

/**
 * Hand-rolled RFC 6455 client — matches the hand-rolled server in
 * server.js frame-for-frame (see that file's own WebSocket section).
 * No OkHttp/library WebSocket client, both to keep this second app
 * free of anything with its own minSdk floor (see build.gradle) and
 * because a plain java.net.Socket is exactly what a client this size
 * needs: connect, one handshake, then read/write frames on a thread.
 *
 * NOT COMPILED OR RUN — no Android SDK available here. First real
 * signal comes from the CI build, same as every other native file in
 * this project.
 */
class CccsWebSocket(private val host: String, private val port: Int, private val path: String, private val secure: Boolean = true) {

    interface Listener {
        fun onOpen() {}
        fun onText(text: String) {}
        fun onBinary(data: ByteArray) {}
        fun onClosed() {}
    }

    var listener: Listener? = null
    private var socket: Socket? = null
    private var output: OutputStream? = null
    private val running = AtomicBoolean(false)
    private val closedByUs = AtomicBoolean(false)
    private val writeLock = Any()

    fun connect() {
        if (running.get()) return
        running.set(true)
        Thread {
            try {
                runConnection()
            } catch (e: Exception) {
                if (!closedByUs.get()) Log.append("ws error: ${e.message}")
            } finally {
                running.set(false)
                // Only report a drop we didn't cause. Reporting our own close()
                // made the owner schedule a reconnect, which closed the fresh
                // connection, which reported another close -- a loop that
                // replaced a healthy connection every few seconds.
                if (!closedByUs.get()) listener?.onClosed()
            }
        }.start()
    }

    fun close() {
        closedByUs.set(true)
        running.set(false)
        try { socket?.close() } catch (_: Exception) {}
        sender.shutdown()
    }

    private fun runConnection() {
        val sock: Socket = if (secure) {
            // Plain SSLSocketFactory.getDefault() gets us a socket, but on
            // Android 4.4/KitKat (API 19) TLS 1.1/1.2 are supported by the
            // underlying library yet NOT enabled by default — that only
            // happens automatically from API 20 onward. Without forcing
            // them on here, the handshake falls back to TLS 1.0 and a
            // modern server (this one included) refuses the connection.
            val plain = Socket(host, port)
            // getDefault()'s declared return type is the plain SocketFactory
            // (that's its actual signature in javax.net.ssl.SSLSocketFactory),
            // which only exposes the host/port createSocket overloads — the
            // Socket-wrapping one used below exists only on SSLSocketFactory
            // itself, hence the cast.
            // Tls.factory already enables TLS 1.2 and adds the Let's Encrypt
            // roots Android 4.4 lacks; a raw SSLSocket doesn't check the
            // hostname itself, so that's verified explicitly below.
            val ssl = Tls.factory.createSocket(plain, host, port, true) as SSLSocket
            ssl.startHandshake()
            if (!Tls.verifyHostname(host, ssl)) { ssl.close(); throw Exception("certificate does not match $host") }
            ssl
        } else {
            Socket(host, port)
        }
        socket = sock
        val out = sock.getOutputStream()
        output = out
        val input = sock.getInputStream()

        val keyBytes = ByteArray(16)
        SecureRandom().nextBytes(keyBytes)
        val key = Base64.encodeToString(keyBytes, Base64.NO_WRAP)

        val request = "GET $path HTTP/1.1\r\n" +
            "Host: $host:$port\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: $key\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        out.write(request.toByteArray(Charsets.US_ASCII))
        out.flush()

        val reader = BufferedReader(InputStreamReader(input, Charsets.US_ASCII))
        val statusLine = reader.readLine() ?: throw Exception("no handshake response")
        if (!statusLine.contains("101")) throw Exception("handshake failed: $statusLine")
        // Drain the rest of the header block. BufferedReader's own buffer
        // could swallow the first bytes of the frame stream that follow
        // immediately after \r\n\r\n on the same TCP segment, so frame
        // reading below uses the raw InputStream directly, never this
        // reader, once headers are done.
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
        }

        listener?.onOpen()
        readFrames(input)
    }

    private fun readFrames(input: InputStream) {
        while (running.get()) {
            val b0 = input.read()
            if (b0 == -1) break
            val b1 = input.read()
            if (b1 == -1) break
            val opcode = b0 and 0x0f
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) {
                len = (((input.read() and 0xff) shl 8) or (input.read() and 0xff)).toLong()
            } else if (len == 127L) {
                var v = 0L
                for (i in 0 until 8) v = (v shl 8) or (input.read() and 0xff).toLong()
                len = v
            }
            // Server frames are never masked (RFC 6455 forbids it), so no
            // mask key to read here — only client->server frames mask.
            val payload = ByteArray(len.toInt())
            var read = 0
            while (read < payload.size) {
                val n = input.read(payload, read, payload.size - read)
                if (n == -1) return
                read += n
            }
            when (opcode) {
                0x1 -> listener?.onText(String(payload, Charsets.UTF_8))
                0x2 -> listener?.onBinary(payload)
                0x8 -> { try { socket?.close() } catch (_: Exception) {}; return } // server closed: a real drop, so it must still be reported for reconnect
                0x9 -> writeFrame(payload, 0xa) // reply to server ping with pong
            }
        }
    }

    // Callers include the UI thread (a key press starts PTT), and Android
    // refuses network writes there (NetworkOnMainThreadException), which
    // silently dropped every PTT request. Everything queued here is written
    // in order on one background thread instead.
    private val sender = java.util.concurrent.Executors.newSingleThreadExecutor()

    private fun queue(payload: ByteArray, opcode: Int) {
        try { sender.execute { writeFrame(payload, opcode) } } catch (_: java.util.concurrent.RejectedExecutionException) {}
    }

    fun sendText(text: String) = queue(text.toByteArray(Charsets.UTF_8), 0x1)
    fun sendBinary(data: ByteArray) = queue(data, 0x2)

    private fun writeFrame(payload: ByteArray, opcode: Int) {
        val out = output ?: return
        synchronized(writeLock) {
            try {
                val mask = ByteArray(4)
                SecureRandom().nextBytes(mask)
                val masked = ByteArray(payload.size)
                for (i in payload.indices) masked[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()

                val header: ByteArray = when {
                    payload.size < 126 -> byteArrayOf((0x80 or opcode).toByte(), (0x80 or payload.size).toByte())
                    payload.size < 65536 -> byteArrayOf(
                        (0x80 or opcode).toByte(), (0x80 or 126).toByte(),
                        ((payload.size shr 8) and 0xff).toByte(), (payload.size and 0xff).toByte()
                    )
                    else -> throw Exception("frame too large")
                }
                out.write(header)
                out.write(mask)
                out.write(masked)
                out.flush()
            } catch (e: Exception) {
                Log.append("ws write failed: ${e.message}")
            }
        }
    }
}
