package uk.cccs.radiolegacy

import android.content.Context
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory

/**
 * Android 4.4 has two problems talking to a modern HTTPS server:
 *  1. TLS 1.1/1.2 are supported by the OS but not switched on by default, so
 *     a stock connection offers TLS 1.0 only and the server rightly refuses
 *     it ("version too low").
 *  2. Its CA store predates Let's Encrypt's current roots, so a perfectly
 *     valid certificate is rejected as untrusted.
 * Both are fixed here for every connection this app makes. Trust is the
 * device's own CA store PLUS the two Let's Encrypt roots bundled in res/raw —
 * nothing is disabled or bypassed, hostnames are still verified.
 */
object Tls {
    lateinit var factory: SSLSocketFactory
        private set

    fun init(context: Context) {
        if (::factory.isInitialized) return
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
        try {
            val system = KeyStore.getInstance("AndroidCAStore").apply { load(null, null) }
            for (alias in system.aliases()) system.getCertificate(alias)?.let { keyStore.setCertificateEntry("sys-$alias", it) }
        } catch (e: Exception) {
            Log.append("tls: could not read system CA store: ${e.message}")
        }
        val cf = CertificateFactory.getInstance("X.509")
        for ((name, res) in listOf("isrg-x1" to R.raw.isrg_root_x1, "isrg-x2" to R.raw.isrg_root_x2)) {
            context.resources.openRawResource(res).use { keyStore.setCertificateEntry(name, cf.generateCertificate(it)) }
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keyStore) }
        val ctx = SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }
        factory = Tls12SocketFactory(ctx.socketFactory)
    }

    /** Raw SSLSockets (unlike HttpsURLConnection) don't check the hostname
     * against the certificate on their own, so the WebSocket does it here. */
    fun verifyHostname(host: String, socket: SSLSocket): Boolean {
        val verifier: HostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
        return verifier.verify(host, socket.session)
    }
}

private class Tls12SocketFactory(private val delegate: SSLSocketFactory) : SSLSocketFactory() {
    override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites
    override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites
    override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket = enable(delegate.createSocket(s, host, port, autoClose))
    override fun createSocket(host: String, port: Int): Socket = enable(delegate.createSocket(host, port))
    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket = enable(delegate.createSocket(host, port, localHost, localPort))
    override fun createSocket(host: InetAddress, port: Int): Socket = enable(delegate.createSocket(host, port))
    override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket = enable(delegate.createSocket(address, port, localAddress, localPort))

    private fun enable(socket: Socket): Socket {
        if (socket is SSLSocket) {
            val supported = socket.supportedProtocols.toSet()
            val wanted = listOf("TLSv1.2", "TLSv1.1").filter { it in supported }
            if (wanted.isNotEmpty()) socket.enabledProtocols = wanted.toTypedArray()
        }
        return socket
    }
}
