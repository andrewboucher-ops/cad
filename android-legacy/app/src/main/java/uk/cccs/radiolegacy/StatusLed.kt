package uk.cccs.radiolegacy

import android.content.Context
import android.content.Intent
import java.io.FileOutputStream

/**
 * The handset's physical status LED — plain-Kotlin sibling of
 * StatusLedPlugin in the main Capacitor app (uk.cccs.radio). Same two
 * best-effort mechanisms and the same reasoning for trying both; see that
 * file's doc comment for the full explanation. No Capacitor bridge needed
 * here since this whole app is native, so it's just a plain object instead
 * of a @CapacitorPlugin.
 */
object StatusLed {
    private enum class Colour(val label: String) { RED("red"), GREEN("green"), BLUE("blue") }

    fun setStatus(context: Context, status: String) {
        val target = colourFor(status.uppercase())
        for (colour in Colour.entries) setLed(context, colour, colour == target)
    }

    private fun colourFor(status: String): Colour? = when (status) {
        "EMERGENCY" -> Colour.RED
        "AVAILABLE" -> Colour.GREEN
        "ACKNOWLEDGED", "EN_ROUTE", "ON_SCENE", "ON_TASK" -> Colour.BLUE
        else -> null
    }

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
}
