/* Vessical polish: the gauge percentage counts up in step with the needle.
 * Purely cosmetic and independent of app.js (it watches #gauge-value). */
(() => {
  const el = document.getElementById("gauge-value");
  if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let raf = 0, shown = 0, writing = null;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const write = (text) => { writing = text; el.textContent = text; };

  new MutationObserver(() => {
    if (el.textContent === writing) return;               // our own write
    const m = /^([\d.]+)%$/.exec(el.textContent.trim());
    cancelAnimationFrame(raf);
    if (!m) { shown = 0; return; }                         // "—" after a reset
    const from = shown, to = parseFloat(m[1]), t0 = performance.now(), dur = 900;
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      shown = from + (to - from) * ease(k);
      write(`${shown.toFixed(1)}%`);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }).observe(el, { childList: true, characterData: true, subtree: true });
})();
