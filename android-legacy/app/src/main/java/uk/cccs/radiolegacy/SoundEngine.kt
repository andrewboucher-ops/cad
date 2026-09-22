package uk.cccs.radiolegacy

import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/**
 * Short synthesised tones for the handset's own feedback -- PTT
 * granted/denied, a status confirmed, the lock toggled, an incoming call
 * ringing. Sepura's actual tones are their firmware's own proprietary
 * audio, not something to ship inside this app, so these are generated
 * in code to sit in the same register (short, clean, functional beeps)
 * rather than trying to reproduce them note for note.
 *
 * Every one-shot plays on its own short-lived AudioTrack in MODE_STATIC
 * (write the whole buffer once, then play) rather than reusing
 * AudioEngine's long-lived streaming track -- these can land right on
 * top of PTT audio in time (the denied buzz fires exactly when capture
 * would otherwise be starting) and are gone in well under a second, so a
 * disposable track per call is simpler than coordinating with the
 * streaming one. Same STREAM_MUSIC choice as AudioEngine's playback, for
 * the same reason: it's heard on the loudspeaker without needing
 * MODE_IN_COMMUNICATION.
 *
 * NOT COMPILED OR RUN -- no Android SDK available here.
 */
class SoundEngine {
    companion object {
        private const val RATE = 8000
        private const val CHANNEL = AudioFormat.CHANNEL_OUT_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }

    private var ringTrack: AudioTrack? = null

    /** One tone burst: a sine wave with a short linear fade in/out so it
     * ticks less than a hard-edged envelope would. */
    private fun tone(freqHz: Int, ms: Int, amplitude: Double = 0.6): ShortArray {
        val n = RATE * ms / 1000
        val out = ShortArray(n)
        val fade = min(n / 8, RATE / 200) // ~5ms, capped so very short tones still fade cleanly
        for (i in 0 until n) {
            val env = when {
                fade <= 0 -> 1.0
                i < fade -> i.toDouble() / fade
                i >= n - fade -> (n - i).toDouble() / fade
                else -> 1.0
            }
            out[i] = (amplitude * env * sin(2.0 * PI * freqHz * i / RATE) * Short.MAX_VALUE).toInt().toShort()
        }
        return out
    }

    private fun silence(ms: Int): ShortArray = ShortArray(RATE * ms / 1000)

    private fun concat(vararg parts: ShortArray): ShortArray {
        val out = ShortArray(parts.sumOf { it.size })
        var pos = 0
        for (p in parts) { p.copyInto(out, pos); pos += p.size }
        return out
    }

    private fun playOnce(samples: ShortArray) {
        try {
            val minBuf = AudioTrack.getMinBufferSize(RATE, CHANNEL, ENCODING)
            if (minBuf <= 0) { Log.append("sound: getMinBufferSize failed"); return }
            @Suppress("DEPRECATION")
            val track = AudioTrack(
                AudioManager.STREAM_MUSIC, RATE, CHANNEL, ENCODING,
                maxOf(minBuf, samples.size * 2), AudioTrack.MODE_STATIC
            )
            track.write(samples, 0, samples.size)
            track.play()
            // MODE_STATIC needs an explicit stop/release once it's done playing
            // -- there's no completion callback worth the API-level fuss for a
            // sub-second tone, so just wait it out on its own thread, matching
            // the Thread{...}.start() idiom already used for short-lived work
            // elsewhere in this file (Api calls, job ack, etc).
            val durationMs = samples.size * 1000L / RATE
            Thread {
                try { Thread.sleep(durationMs + 60) } catch (_: InterruptedException) {}
                try { track.stop(); track.release() } catch (_: Exception) {}
            }.start()
        } catch (e: Exception) { Log.append("sound: playback failed: ${e.message}") }
    }

    /** PTT granted -- quick two-note "go ahead" chirp. */
    fun confirm() = playOnce(concat(tone(900, 40), tone(1300, 60)))

    /** PTT denied / channel busy -- low double buzz. */
    fun denied() = playOnce(concat(tone(350, 120), silence(40), tone(350, 120)))

    /** Our own transmission ended -- single short low tone, quieter and
     * lower than confirm() so the two are easy to tell apart by ear. */
    fun released() = playOnce(tone(700, 50, amplitude = 0.45))

    /** Status change confirmed. */
    fun statusBeep() = playOnce(tone(1200, 50))

    /** Lock toggled -- rising for unlock, falling for lock, mirroring the
     * on-screen padlock direction. */
    fun lockClick(unlocked: Boolean) = playOnce(
        if (unlocked) concat(tone(600, 35), tone(1000, 35)) else concat(tone(1000, 35), tone(600, 35))
    )

    /** Incoming call -- three short beeps, a pause, then repeats, until
     * stopRing() is called (answered, declined, or the call times out). */
    fun startRing() {
        stopRing()
        try {
            val cycle = concat(
                tone(1000, 100), silence(90), tone(1000, 100), silence(90), tone(1000, 100), silence(700)
            )
            val minBuf = AudioTrack.getMinBufferSize(RATE, CHANNEL, ENCODING)
            if (minBuf <= 0) { Log.append("sound: ring getMinBufferSize failed"); return }
            @Suppress("DEPRECATION")
            val track = AudioTrack(
                AudioManager.STREAM_MUSIC, RATE, CHANNEL, ENCODING,
                maxOf(minBuf, cycle.size * 2), AudioTrack.MODE_STATIC
            )
            track.write(cycle, 0, cycle.size)
            track.setLoopPoints(0, cycle.size, -1)
            track.play()
            ringTrack = track
        } catch (e: Exception) { Log.append("sound: ring failed: ${e.message}") }
    }

    fun stopRing() {
        try { ringTrack?.stop(); ringTrack?.release() } catch (_: Exception) {}
        ringTrack = null
    }
}
