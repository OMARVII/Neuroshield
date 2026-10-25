/**
 * Test pages for the end-to-end suite. Two servers share the routes so tests
 * can load media and frames cross-origin (127.0.0.1 vs localhost).
 */
const http = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join, basename } = require('node:path');

const MEDIA = join(__dirname, 'media');

function html(body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>test</title>${head}</head>
<body style="margin:0;background:#fff;font:14px sans-serif">${body}</body></html>`;
}

function video(src, { id = 'v', width = 640, height = 360, extra = '' } = {}) {
  return `<video id="${id}" src="${src}" muted autoplay loop playsinline width="${width}" height="${height}" ${extra}></video>`;
}

/** Custom element that renders a video into a shadow root. */
const playerElement = (mode) => `
  customElements.define('x-player', class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot || this._root) return;
      this._root = this.attachShadow({ mode: '${mode}' });
      const v = document.createElement('video');
      Object.assign(v, { id: 'v', src: this.getAttribute('src'), muted: true, autoplay: true, loop: true, playsInline: true, width: 640, height: 360 });
      this._root.appendChild(v);
      window.__video = v;
    }
  });`;

const routes = {
  '/blank': () => html('<p>blank</p>'),

  '/video': (q) => html(video(q.get('src'), { width: Number(q.get('w')) || 640, height: Number(q.get('h')) || 360 })),

  '/two-videos': (q) => html(`${video(q.get('a'), { id: 'a' })}<br>${video(q.get('b'), { id: 'b' })}`),

  '/video-later': (q) => html(`<div id="slot"></div><script>
    setTimeout(() => { document.getElementById('slot').innerHTML = '${video(q.get('src'))}'; }, 300);
  </script>`),

  '/xorigin': (q, other) => html(video(`${other}/${q.get('src')}`)),

  '/iframe': (q, other) => html(`<iframe src="${other}/video?src=${q.get('src')}" width="680" height="400" style="border:0"></iframe>`),

  '/shadow-open': (q) => html(`<x-player src="${q.get('src')}"></x-player><script>${playerElement('open')}</script>`),

  '/shadow-closed': (q) => html(`<x-player src="${q.get('src')}"></x-player><script>${playerElement('closed')}</script>`),

  '/shadow-late': (q) => html(`<x-player src="${q.get('src')}"></x-player><script>
    setTimeout(() => { ${playerElement('open')} }, 1500);</script>`),

  '/shadow-declarative': (q) => html(`<div id="host"><template shadowrootmode="open">
    ${video(q.get('src'))}</template></div>`),

  '/canvas': (q) => {
    const hz = Number(q.get('hz')) || 0;
    const ctx = q.get('ctx') === 'webgl' ? 'webgl' : '2d';
    return html(`<canvas id="c" width="480" height="320"></canvas><script>
      const c = document.getElementById('c');
      const hz = ${hz};
      const ctx = c.getContext('${ctx}');
      function draw(t) {
        const on = hz > 0 ? Math.floor(t / (500 / hz)) % 2 === 1 : false;
        if ('${ctx}' === 'webgl') { ctx.clearColor(on ? 1 : 0.1, on ? 1 : 0.1, on ? 1 : 0.1, 1); ctx.clear(ctx.COLOR_BUFFER_BIT); }
        else if (${q.get('mode') === 'clear'}) { ctx.clearRect(0, 0, c.width, c.height); if (on) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); } }
        else { ctx.fillStyle = on ? '#fff' : '#111'; ctx.fillRect(0, 0, c.width, c.height); }
        requestAnimationFrame(draw);
      }
      requestAnimationFrame(draw);
    </script>`);
  },

  // below=1 puts the box two screens down.
  '/css': (q) => {
    const kind = q.get('kind');
    const keyframes = {
      flash: '@keyframes a { 0%, 49% { background: #000 } 50%, 100% { background: #fff } } #box { animation: a 200ms steps(1) infinite; background: #000; }',
      spinner: '@keyframes a { to { transform: rotate(360deg) } } #box { animation: a 800ms linear infinite; background: #222; }',
      pulse: '@keyframes a { 50% { opacity: .75 } } #box { animation: a 2s ease-in-out infinite; background: #234; }',
      // A transparent wrapper blinking its (white) content on a dark page.
      blink: 'body { background: #111 !important } @keyframes a { 0%, 49% { opacity: 0 } 50%, 100% { opacity: 1 } } #box { animation: a 200ms steps(1) infinite; } #box::after { content: ""; display: block; height: 100%; background: #fff; }',
    }[kind];
    const spacer = q.get('below') ? '<div style="height:2200px"></div>' : '';
    return html(`${spacer}<div id="box" style="width:400px;height:300px"></div>`, `<style>${keyframes}</style>`);
  },

  // Thousands of harmless spinners, then a flashing box after 1 s.
  '/many-animations': (q) => html(`<div id="spinners" style="display:flex;flex-wrap:wrap;width:600px"></div><div id="slot"></div><script>
    const n = ${Number(q.get('n')) || 2000};
    const wrap = document.getElementById('spinners');
    for (let i = 0; i < n; i++) {
      const d = document.createElement('i');
      d.style.cssText = 'display:block;width:6px;height:6px;background:#888;animation:spin ' + (600 + (i % 50) * 10) + 'ms linear infinite';
      wrap.appendChild(d);
    }
    setTimeout(() => { document.getElementById('slot').innerHTML = '<div id="box" style="width:400px;height:300px"></div>'; }, 1000);
  </script>`, '<style>@keyframes spin { to { transform: rotate(360deg) } } @keyframes a { 0%, 49% { background: #000 } 50%, 100% { background: #fff } } #box { animation: a 200ms steps(1) infinite; background: #000; }</style>'),

  // A Web Animation started from script (no animationstart event).
  '/waapi': () => html(`<div id="box" style="width:400px;height:300px;background:#000"></div><script>
    window.anim = document.getElementById('box').animate([{ background: '#000' }, { background: '#fff' }], { duration: 200, iterations: Infinity, easing: 'steps(2, jump-none)' });
  </script>`),

  // One long cycle made of many quick steps: a 5 Hz strobe in a 3 s animation.
  '/long-cycle': () => {
    const frames = Array.from({ length: 31 }, (_, i) => `${((i * 100) / 30).toFixed(2)}% { background: ${i % 2 ? '#fff' : '#000'} }`).join(' ');
    return html('<div id="box" style="width:400px;height:300px"></div>', `<style>@keyframes a { ${frames} } #box { animation: a 3s steps(1) infinite; }</style>`);
  },

  // A small element whose ::after covers the viewport and strobes.
  '/pseudo': () => html('<span id="box">x</span>', '<style>@keyframes a { 0%, 49% { background: #000 } 50%, 100% { background: #fff } } #box::after { content: ""; position: fixed; inset: 0; animation: a 200ms steps(1) infinite; }</style>'),

  // A defined custom element that attaches its shadow root a second after it's connected.
  '/shadow-late-attach': (q) => html(`<x-late src="${q.get('src')}"></x-late><script>
    customElements.define('x-late', class extends HTMLElement {
      connectedCallback() {
        setTimeout(() => {
          const root = this.attachShadow({ mode: 'closed' });
          const v = document.createElement('video');
          Object.assign(v, { id: 'v', src: this.getAttribute('src'), muted: true, autoplay: true, loop: true, playsInline: true, width: 640, height: 360 });
          root.appendChild(v);
          window.__video = v;
        }, 1000);
      }
    });</script>`),

  // A lightbox: the video plays inside a modal dialog.
  '/dialog': (q) => html(`<dialog id="d" style="padding:0;border:0">${video(q.get('src'))}</dialog><script>document.getElementById('d').showModal();</script>`),

  // An inner-scrolling pane (chat apps, mail) with a video in it.
  '/scroller': (q) => html(`<div style="height:120px;background:#eee">header</div>
    <div id="pane" style="height:400px;overflow:auto">${video(q.get('src'))}<div style="height:1200px"></div></div>`),

  // CSS zoom on the root element.
  '/zoomed': (q) => html(`<div style="padding:40px 60px">${video(q.get('src'))}</div>`, '<style>html { zoom: 1.5 }</style>'),

  // target=video makes the <video> itself fullscreen (like native controls do).
  '/fullscreen': (q) => html(`<div id="player" style="width:640px;height:360px;background:#000">${video(q.get('src'), { extra: 'style="width:100%;height:100%"' })}</div>
    <button id="fs" onclick="document.getElementById('${q.get('target') === 'video' ? 'v' : 'player'}').requestFullscreen()">Fullscreen</button>`),

  '/csp': (q) => html(video(q.get('src'))),

  // Neutral article layout for README screenshots.
  '/demo': (q) => html(`
    <main style="max-width:760px;margin:40px auto;padding:0 20px;color:#1f2937">
      <p style="margin:0 0 6px;color:#6b7280;font-size:13px;letter-spacing:.04em;text-transform:uppercase">Demo page</p>
      <h1 style="margin:0 0 18px;font:700 30px/1.2 system-ui,sans-serif">Concert highlights: the light show</h1>
      ${video(q.get('src'), { width: 720, height: 405, extra: 'style="display:block;width:720px;height:405px;border-radius:12px;background:#000"' })}
      <p style="font:16px/1.6 system-ui,sans-serif;color:#4b5563;margin-top:18px">The encore ended with a strobe sequence. NeuroShield hid it as soon as it started and paused the video, so you can decide how to watch.</p>
    </main>`),

  // Small players, for checking compact layouts.
  '/sizes': (q) => html(`<div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
    ${video(q.get('src'), { id: 'm', width: 280, height: 158 })}
    ${video(q.get('src'), { id: 's', width: 150, height: 84 })}
    ${video(q.get('src'), { id: 'x', width: 480, height: 270, extra: 'crossorigin' })}</div>`),
};

const HEADERS = {
  '/csp': { 'content-security-policy': "default-src 'self'; style-src 'none'; script-src 'none'" },
};

function createServer(port, otherOrigin) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const route = routes[url.pathname];
    if (route) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...HEADERS[url.pathname] });
      res.end(route(url.searchParams, otherOrigin));
      return;
    }
    const file = join(MEDIA, basename(url.pathname));
    if (url.pathname.endsWith('.webm') && existsSync(file)) {
      const data = readFileSync(file);
      res.writeHead(200, { 'content-type': 'video/webm', 'content-length': data.length });
      res.end(data);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** Start both origins. Returns { a, b, close } where a and b are base URLs. */
async function startServers() {
  const probe = http.createServer();
  const portA = await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
  probe.close();
  const probe2 = http.createServer();
  const portB = await new Promise((r) => probe2.listen(0, '127.0.0.1', () => r(probe2.address().port)));
  probe2.close();
  const a = `http://127.0.0.1:${portA}`;
  const b = `http://localhost:${portB}`;
  const servers = await Promise.all([createServer(portA, b), createServer(portB, a)]);
  const close = () => Promise.all(servers.map((s) => new Promise((r) => {
    s.closeAllConnections();
    s.close(r);
  })));
  return { a, b, close };
}

module.exports = { startServers };
