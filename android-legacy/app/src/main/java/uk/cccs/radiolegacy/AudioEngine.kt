package uk.cccs.radiolegacy

import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Raw 16-bit PCM mono at 8kHz (telephone quality) over the WebSocket binary
 * relay — no codec, deliberately, to get one working, provably-correct
 * audio path end to end before spending any effort on compression. ~16KB/s;
 * fine over wifi, usable but not free over cellular. A real codec (a small
 * hand-rolled ADPCM, most likely — no external library, same reasoning as
 * the WebSocket client) is the natural next step once this is confirmed
 * working on the actual handset, not before.
 *
 * NOT COMPILED OR RUN — no Android SDK available here.
 */
class AudioEngine {
    companion object {
        const val SAMPLE_RATE = 8000
        private val CHANNEL_IN = AudioFormat.CHANNEL_IN_MONO
        private val CHANNEL_OUT = AudioFormat.CHANNEL_OUT_MONO
        private val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }

    private var recorder: AudioRecord? = null
    private var track: AudioTrack? = null
    private val capturing = AtomicBoolean(false)

    fun startCapture(onChunk: (ByteArray) -> Unit) {
        if (capturing.get()) return
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_IN, ENCODING)
        if (minBuf <= 0) { Log.append("audio: getMinBufferSize failed"); return }
        val bufSize = minBuf * 2
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, CHANNEL_IN, ENCODING, bufSize)
        } catch (e: Exception) {
            Log.append("audio: AudioRecord init failed: ${e.message}"); return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { Log.append("audio: AudioRecord not initialised"); return }
        recorder = rec
        capturing.set(true)
        rec.startRecording()
        Thread {
            val buf = ByteArray(1024)
            while (capturing.get()) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) onChunk(buf.copyOf(n))
            }
        }.start()
    }

    fun stopCapture() {
        if (!capturing.compareAndSet(true, false)) return
        try {
            recorder?.stop()
            recorder?.release()
        } catch (_: Exception) {}
        recorder = null
    }

    /** Lazily created on first playback and left running — tearing an
     * AudioTrack down between every received chunk would both waste time
     * and risk audible clicks at every chunk boundary. Call releasePlayback()
     * when the screen goes away, not between individual chunks. */
    fun playChunk(data: ByteArray) {
        val t = track ?: run {
            val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNEL_OUT, ENCODING)
            if (minBuf <= 0) { Log.append("audio: playback getMinBufferSize failed"); return }
            @Suppress("DEPRECATION")
            val newTrack = AudioTrack(
                AudioManager.STREAM_VOICE_CALL, SAMPLE_RATE, CHANNEL_OUT, ENCODING,
                minBuf * 2, AudioTrack.MODE_STREAM
            )
            newTrack.play()
            track = newTrack
            newTrack
        }
        try { t.write(data, 0, data.size) } catch (e: Exception) { Log.append("audio: playback write failed: ${e.message}") }
    }

    fun releasePlayback() {
        try { track?.stop(); track?.release() } catch (_: Exception) {}
        track = null
    }
}
