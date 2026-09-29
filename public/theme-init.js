/* Stamps the operator's saved theme onto <html> before console.css paints,
 * so the page never flashes the default theme before switching to theirs.
 * Loaded synchronously, early in <head>, deliberately outside app.js (which
 * loads later in the page and would paint once before it ran). Reads the
 * same localStorage mirror app.js writes on login — see CCCS.applyTheme,
 * which this duplicates in miniature for the same reason it exists: to run
 * before anything else has. */
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('cccs.session.mirror') || 'null');
    var p = s && s.user && s.user.ui_prefs;
    if (!p) return;
    var d = document.documentElement;
    if (p.theme) d.setAttribute('data-theme', p.theme);
    if (p.mode && p.mode !== 'system') d.setAttribute('data-mode', p.mode);
    if (p.bloom) d.setAttribute('data-bloom', p.bloom);
    if (p.panels) d.setAttribute('data-panels', p.panels);
    if (p.corners) d.setAttribute('data-corners', p.corners);
    if (p.glow) d.setAttribute('data-glow', 'on');
    if (p.priority_ramp) d.setAttribute('data-priority-ramp', p.priority_ramp);
    if (p.reduce_motion) d.setAttribute('data-motion', 'reduce');
  } catch (e) {}
})();
