package uk.cccs.radiolegacy

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * The handset's physical status LED — plain-Kotlin sibling of
 * StatusLedPlugin in the main Capacitor app (uk.cccs.radio). Same two
 * best-effort mechanisms and the same reasoning for trying both; see that
 * file's doc comment for the full explanation. No Capacitor bridge needed
 * here since this whole app is native, so it's just a plain object instead
 * of a @CapacitorPlugin.
 *
 * Reported not to change colour on the real handset at all, and neither
 * write path was ever logged — a broadcast with no listening receiver
 * doesn't throw (Android broadcasts are fire-and-forget, so that path
 * can never confirm anything actually happened), and the sysfs write's
 * exception was silently swallowed. Now: the sysfs outcome is logged once
 * per colour so a real permission/path error shows up on screen instead
 * of just doing nothing, and the actual /sys/class/leds node names are
 * listed once too, since "red"/"green"/"blue" came from a different
 * reference app (BroadNet) and may not be what this hardware calls them.
 *
 * Also caused the handset to stop responding to button presses after a
 * while: breathing's sysfs writes ran on the main thread every 600ms
 * forever, and if that write is ever slow on this hardware (plausible —
 * it's also why the colour never confirmed working), it stalls the same
 * thread key events are dispatched on. Both write paths now run on a
 * background thread; the main-thread Handler only schedules the next
 * tick, never does the I/O itself.
 */
object StatusLed {
    private enum class Colour(val label: String) { RED("red"), GREEN("green"), BLUE("blue") }

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var breatheRunnable: Runnable? = null
    private var breatheOn = false
    private var loggedNodes = false
    private val probedColours = mutableSetOf<Colour>()

    fun setStatus(context: Context, status: String) {
        stopBreathing()
        val target = colourFor(status.uppercase())
        if (target == null) {
            io.execute { for (colour in Colour.entries) setLed(context, colour, false) }
            return
        }
        io.execute { logAvailableNodesOnce(); probeSysfsOnce(target) }
        startBreathing(context, target)
    }

    private fun colourFor(status: String): Colour? = when (status) {
        "EMERGENCY" -> Colour.RED
        "AVAILABLE" -> Colour.GREEN
        "ACKNOWLEDGED", "EN_ROUTE", "ON_SCENE", "ON_TASK" -> Colour.BLUE
        else -> null
    }

    private fun startBreathing(context: Context, target: Colour) {
        breatheOn = true
        val runnable = object : Runnable {
            override fun run() {
                val on = breatheOn
                io.execute { for (colour in Colour.entries) setLed(context, colour, colour == target && on) }
                breatheOn = !breatheOn
                handler.postDelayed(this, BREATHE_INTERVAL_MS)
            }
        }
        breatheRunnable = runnable
        handler.post(runnable)
    }

    private fun stopBreathing() {
        breatheRunnable?.let { handler.removeCallbacks(it) }
        breatheRunnable = null
    }

    // Runs on the io executor -- see setStatus().
    private fun logAvailableNodesOnce() {
        if (loggedNodes) return
        loggedNodes = true
        try {
            val names = File("/sys/class/leds").list()
            Log.append("led: /sys/class/leds = ${names?.joinToString(", ") ?: "(empty)"}")
        } catch (e: Exception) {
            Log.append("led: /sys/class/leds not readable: ${e.message}")
        }
    }

    // Logged once per colour, not on every breathing on/off toggle, or the
    // log view would fill with nothing else within a few seconds. Runs on
    // the io executor -- see setStatus().
    private fun probeSysfsOnce(colour: Colour) {
        if (!probedColours.add(colour)) return
        try {
            FileOutputStream("/sys/class/leds/${colour.label}/brightness").use { it.write("0".toByteArray()) }
            Log.append("led: sysfs write to ${colour.label} OK")
        } catch (e: Exception) {
            Log.append("led: sysfs write to ${colour.label} failed: ${e.message}")
        }
    }

    // Runs on the io executor, never the caller's thread -- see startBreathing().
    private fun setLed(context: Context, colour: Colour, on: Boolean) {
        try {
            context.sendBroadcast(Intent("com.intent.${colour.label}led.${if (on) "on" else "off"}"))
        } catch (_: Exception) {}
        try {
            FileOutputStream("/sys/class/leds/${colour.label}/brightness").use {
                it.write((if (on) "255" else "0").toByteArray())
            }
        } catch (_: Exception) {}
    }

    private const val BREATHE_INTERVAL_MS = 600L
}
