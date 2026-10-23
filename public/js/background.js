/* Live animated background: glowing drifting particles that connect to each other and react to the cursor. */
(function () {
  'use strict';
  var canvas = document.getElementById('bg');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = 0, h = 0, particles = [], raf = 0, running = false;
  var mouse = { x: -9999, y: -9999, active: false };
  var palettes = {
    dark: ['124,92,255', '34,211,238', '255,92,168', '96,165,250'],
    light: ['99,102,241', '14,165,233', '236,72,153', '59,130,246']
  };
  var sprites = {};

  function theme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

  function makeSprite(rgb) {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(' + rgb + ',0.95)');
    grad.addColorStop(0.25, 'rgba(' + rgb + ',0.45)');
    grad.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  function buildSprites() {
    sprites = {};
    var list = palettes[theme()];
    for (var i = 0; i < list.length; i++) sprites[list[i]] = makeSprite(list[i]);
  }

  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var count = Math.max(24, Math.min(90, Math.floor((w * h) / 17000)));
    var list = palettes[theme()];
    particles = [];
    for (var i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
        r: 6 + Math.random() * 16, rgb: list[i % list.length], tw: Math.random() * Math.PI * 2
      });
    }
  }

  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    var light = theme() === 'light';
    var lineRgb = light ? '90,100,200' : '170,180,255';
    var i, j, p, q, dx, dy, d;

    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = w + 20; else if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20; else if (p.y > h + 20) p.y = -20;

      if (mouse.active) {
        dx = mouse.x - p.x; dy = mouse.y - p.y; d = Math.sqrt(dx * dx + dy * dy);
        if (d < 200 && d > 1) { p.x += (dx / d) * 0.45; p.y += (dy / d) * 0.45; }
      }

      var pulse = 0.65 + Math.sin(t / 900 + p.tw) * 0.35;
      var s = sprites[p.rgb];
      if (s) {
        ctx.globalAlpha = (light ? 0.5 : 0.8) * pulse;
        var size = p.r * 3.2;
        ctx.drawImage(s, p.x - size / 2, p.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;

      for (j = i + 1; j < particles.length; j++) {
        q = particles[j]; dx = p.x - q.x; dy = p.y - q.y; d = dx * dx + dy * dy;
        if (d < 14400) {
          ctx.strokeStyle = 'rgba(' + lineRgb + ',' + ((1 - d / 14400) * (light ? 0.16 : 0.2)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }

      if (mouse.active) {
        dx = p.x - mouse.x; dy = p.y - mouse.y; d = Math.sqrt(dx * dx + dy * dy);
        if (d < 170) {
          ctx.strokeStyle = 'rgba(34,211,238,' + ((1 - d / 170) * 0.5).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
        }
      }
    }
    if (running) raf = requestAnimationFrame(frame);
  }

  function start() { if (reduce || running) return; running = true; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  buildSprites(); resize();
  if (reduce) frame(0); else start();

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); if (reduce) frame(0); }, 150);
  });
  window.addEventListener('pointermove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = e.pointerType !== 'touch'; }, { passive: true });
  window.addEventListener('pointerleave', function () { mouse.active = false; });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });

  // Re-colour when the theme is switched
  new MutationObserver(function () { buildSprites(); resize(); if (reduce) frame(0); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
