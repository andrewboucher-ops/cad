package uk.cccs.radio

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.FileOutputStream

/**
 * Drives a rugged handset's hardware status LED (separate from the on-screen
 * indicator in radio.html — this is the physical light).
 *
 * There is no standard Android API for this; every rugged-PTT reference
 * design does it differently. Two mechanisms were found by inspecting how a
 * comparable PTT app (BroadNet PTT) talks to its own hardware, not copied
 * from it: broadcast intents the device firmware listens for, and a direct
 * write to the kernel LED sysfs nodes as a fallback for devices where the
 * intents aren't wired up but the app has been granted (or the device
 * doesn't enforce) permission to write there. Both are tried; neither is
 * guaranteed to exist on any given handset, which is the whole reason this
 * is a best-effort fallback chain rather than a single call — confirm which
 * one (if either) actually lights anything on the real device, then this
 * can be trimmed down to just what works.
 *
 * NOT COMPILED OR RUN — written without an Android SDK available, same as
 * the rest of this native layer. Expect to fix at least one import on the
 * first CI build.
 */
@CapacitorPlugin(name = "StatusLed")
class StatusLedPlugin : Plugin() {

    private enum class LedColour(val label: String) {
        RED("red"), GREEN("green"), BLUE("blue")
    }

    @PluginMethod
    fun setStatus(call: PluginCall) {
        val status = call.getString("status", "")?.uppercase() ?: ""
        val target = colourFor(status)

        for (colour in LedColour.entries) {
            setLed(colour, colour == target)
        }

        val result = JSObject()
        result.put("status", status)
        result.put("lit", target?.label ?: "off")
        call.resolve(result)
    }

    /**
     * Status -> LED colour. Only three physical colours exist, so several
     * statuses collapse together: AVAILABLE is the only "all clear" state
     * (green); actively working a job reads as blue; EMERGENCY is red and
     * takes priority over everything. Genuinely idle/unavailable states
     * (BUSY on a non-job task, meal break, offline, out of service) leave
     * the light off rather than picking an arbitrary colour for them.
     * Adjust freely once this is confirmed against a real handset — this
     * mapping is a first guess, not a spec.
     */
    private fun colourFor(status: String): LedColour? = when (status) {
        "EMERGENCY" -> LedColour.RED
        "AVAILABLE" -> LedColour.GREEN
        "ACKNOWLEDGED", "EN_ROUTE", "ON_SCENE", "ON_TASK" -> LedColour.BLUE
        else -> null
    }

    private fun setLed(colour: LedColour, on: Boolean) {
        sendLedBroadcast(colour, on)
        writeLedSysfs(colour, on)
    }

    private fun sendLedBroadcast(colour: LedColour, on: Boolean) {
        try {
            val action = "com.intent.${colour.label}led.${if (on) "on" else "off"}"
            context.sendBroadcast(Intent(action))
        } catch (_: Exception) {
            // No receiver for this action on this device — fine, the sysfs
            // path below is the fallback, not every handset needs both.
        }
    }

    private fun writeLedSysfs(colour: LedColour, on: Boolean) {
        try {
            FileOutputStream("/sys/class/leds/${colour.label}/brightness").use {
                it.write((if (on) "255" else "0").toByteArray())
            }
        } catch (_: Exception) {
            // Most likely permission denied (this node is usually root-only
            // unless the device's firmware specifically opens it up) or the
            // path doesn't exist on this hardware at all — both expected
            // and harmless; the broadcast above is the primary mechanism.
        }
    }
}
