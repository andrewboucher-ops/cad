package uk.cccs.radiolegacy

/** Tiny pub/sub so any background thread (the WebSocket reader, the audio
 * engine) can append a line without holding a reference back to the
 * Activity or worrying about which thread it's called from — MainActivity
 * subscribes and hops to the UI thread itself. */
object Log {
    var onLine: ((String) -> Unit)? = null
    fun append(line: String) {
        onLine?.invoke(line)
    }
}
