/**
 * A Content-Disposition header value safe for a filename that may contain
 * non-ASCII characters — an en-dash, an accent, an emoji someone typed
 * into a document title. Node's http module throws "Invalid character in
 * header content" on anything outside a narrow byte range in a raw header
 * value, so a plain `filename="<name>"` breaks the instant an uploaded
 * file's original name isn't pure ASCII (it happened first with
 * "Assignment Instructions – Meridian Point...pdf", the en-dash).
 *
 * The RFC 5987/6266 filename* parameter is always ASCII — it's
 * percent-encoded — so it's what actually carries the real name; the
 * plain filename stays as a lossy ASCII-only fallback for the
 * essentially-nonexistent client that doesn't understand filename*.
 */
function contentDisposition(type, filename) {
  const safe = String(filename || 'file').replace(/[\r\n"]/g, '');
  const asciiFallback = safe.replace(/[^\x20-\x7E]/g, '_') || 'file';
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
module.exports = { contentDisposition };
