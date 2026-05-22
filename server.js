'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ProxyAgent } = require('undici');
const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const app = express();
app.disable('x-powered-by');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = toPort(process.env.PORT, 80);
const MANAGE_HOST = process.env.MANAGE_HOST || '0.0.0.0';
const MANAGE_PORT = toPort(process.env.MANAGE_PORT, 9999);
const MANAGE_ENABLED = process.env.MANAGE_ENABLED !== 'false';
const MANAGE_TOKEN = process.env.MANAGE_TOKEN || '';
const BASE_API = withTrailingSlash(
  process.env.ROUTINEHUB_API_BASE || 'https://routinehub.co/api/v1/'
);
const REQUEST_TIMEOUT_MS = toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 30000);
const CACHE_TTL_MS = toNonNegativeInt(process.env.CACHE_TTL_MS, 30000);
const MAX_CACHE_ENTRIES = toPositiveInt(process.env.MAX_CACHE_ENTRIES, 100);
const MAX_BROWSER_PAGES = toPositiveInt(process.env.MAX_BROWSER_PAGES, 2);
const RATE_LIMIT_MAX = toPositiveInt(process.env.RATE_LIMIT_MAX, 60);
const DIRECT_FETCH_FIRST = process.env.DIRECT_FETCH_FIRST !== 'false';
const OUTBOUND_PROXY_URL = process.env.OUTBOUND_PROXY_URL || '';
const PROXY_LIST_URL = process.env.PROXY_LIST_URL || '';
const AUTO_PROXY_ENABLED =
  process.env.AUTO_PROXY_ENABLED !== 'false' && Boolean(PROXY_LIST_URL);
const PROXY_LIST_REFRESH_MS = toPositiveInt(
  process.env.PROXY_LIST_REFRESH_MS,
  10 * 60 * 1000
);
const PROXY_TEST_TIMEOUT_MS = toPositiveInt(
  process.env.PROXY_TEST_TIMEOUT_MS,
  5000
);
const PROXY_TEST_CANDIDATES = toPositiveInt(
  process.env.PROXY_TEST_CANDIDATES,
  32
);
const PROXY_TEST_CONCURRENCY = toPositiveInt(
  process.env.PROXY_TEST_CONCURRENCY,
  4
);
const PROXY_BAD_TTL_MS = toPositiveInt(
  process.env.PROXY_BAD_TTL_MS,
  30 * 60 * 1000
);
const PROXY_RETRY_LIMIT = toPositiveInt(process.env.PROXY_RETRY_LIMIT, 5);
const PROXY_TEST_URL =
  process.env.PROXY_TEST_URL ||
  new URL('shortcuts/6565/versions/latest', BASE_API).toString();
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_BIN ||
  '/usr/bin/chromium';

const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let browser;
let browserPromise;
let browserProxyUrl = '';
let activeBrowserPages = 0;
const browserQueue = [];
const responseCache = new Map();
const fetchDispatchers = new Map();
const proxyState = {
  list: [],
  fetchedAt: 0,
  refreshPromise: null,
  selectPromise: null,
  selectedUrl: OUTBOUND_PROXY_URL,
  selectedAt: OUTBOUND_PROXY_URL ? new Date() : null,
  badUntil: new Map(),
  lastError: null,
  lastTestAt: null,
  tested: 0,
  working: 0,
  failed: 0,
  rotations: 0,
};
const stats = {
  startedAt: new Date(),
  proxyRequests: 0,
  proxyErrors: 0,
  cacheHits: 0,
  directFetches: 0,
  browserFetches: 0,
  lastProxyError: null,
  lastProxyRequestAt: null,
};

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
  })
);

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'routinehub-proxy',
  });
});

app.use(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  stats.proxyRequests += 1;
  stats.lastProxyRequestAt = new Date();

  const targetUrl = buildTargetUrl(req);
  const cacheKey = `${req.method}:${targetUrl}`;
  const cached = getCached(cacheKey);

  if (cached) {
    stats.cacheHits += 1;
    sendProxyResponse(res, cached);
    return;
  }

  try {
    const result = await fetchRoutineHub(targetUrl);
    setCached(cacheKey, result);
    sendProxyResponse(res, result);
  } catch (err) {
    stats.proxyErrors += 1;
    stats.lastProxyError = serializeError(err);
    console.error('Proxy error:', err);
    await resetBrowser();
    res.status(err.statusCode || 502).json({
      error: err.publicMessage || 'Unable to fetch RoutineHub data',
      code: err.code || 'UPSTREAM_FETCH_FAILED',
      detail: err.publicDetail,
    });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      event: 'server_listening',
      host: HOST,
      port: PORT,
      portEnv: process.env.PORT || null,
      chromePath: CHROME_PATH,
      outboundProxy: maskProxyUrl(proxyState.selectedUrl),
      autoProxyEnabled: AUTO_PROXY_ENABLED,
      proxyListUrl: PROXY_LIST_URL ? 'configured' : null,
      nodeEnv: process.env.NODE_ENV || null,
      nodeVersion: process.version,
    })
  );
});

let manageServer;
if (MANAGE_ENABLED) {
  const manageApp = createManageApp();
  manageServer = manageApp.listen(MANAGE_PORT, MANAGE_HOST, () => {
    console.log(
      JSON.stringify({
        event: 'manage_listening',
        host: MANAGE_HOST,
        port: MANAGE_PORT,
        authEnabled: Boolean(MANAGE_TOKEN),
      })
    );
  });

  manageServer.on('error', (err) => {
    console.error('Management server failed to start:', err);
    process.exit(1);
  });
}

server.on('error', (err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown(signal).catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });
}

async function fetchRoutineHub(url) {
  let lastErr;
  const maxAttempts = AUTO_PROXY_ENABLED ? PROXY_RETRY_LIMIT : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (DIRECT_FETCH_FIRST) {
        try {
          stats.directFetches += 1;
          return await fetchDirect(url);
        } catch (err) {
          if (AUTO_PROXY_ENABLED && shouldRotateProxy(err)) {
            throw err;
          }
          console.warn(`Direct fetch failed, falling back to browser: ${err.message}`);
        }
      }

      stats.browserFetches += 1;
      return await withBrowserSlot(() => fetchWithBrowser(url));
    } catch (err) {
      lastErr = err;

      if (!AUTO_PROXY_ENABLED || !shouldRotateProxy(err) || attempt >= maxAttempts) {
        throw err;
      }

      console.warn(
        `Blocked proxy attempt ${attempt}, rotating proxy: ${err.message}`
      );
      await rotateActiveProxy(err);
    }
  }

  throw lastErr;
}

async function fetchDirect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const proxyUrl = await getActiveProxyUrl();
    const fetchOptions = {
      headers: {
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    };

    if (proxyUrl) {
      fetchOptions.dispatcher = getFetchDispatcher(proxyUrl);
    }

    const response = await fetch(url, fetchOptions);

    const bodyContent = await response.text();
    const contentType = response.headers.get('content-type') || '';

    assertNotCloudflareBlocked(bodyContent, 'direct', {
      status: response.status,
      headers: response.headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!contentType.includes('json') && !isJson(bodyContent)) {
      throw new Error(`Unexpected content type: ${contentType || 'unknown'}`);
    }

    return {
      bodyContent,
      content: bodyContent,
      source: 'direct',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithBrowser(url) {
  const proxyUrl = await getActiveProxyUrl();
  const browserProxy = parseBrowserProxy(proxyUrl);
  const b = await initBrowser(proxyUrl);
  const page = await b.newPage();

  try {
    page.setDefaultNavigationTimeout(REQUEST_TIMEOUT_MS);
    page.setDefaultTimeout(REQUEST_TIMEOUT_MS);

    await page.setUserAgent(USER_AGENT);
    if (browserProxy && browserProxy.auth) {
      await page.authenticate(browserProxy.auth);
    }

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['font', 'image', 'media', 'stylesheet'].includes(request.resourceType())) {
        request.abort();
        return;
      }

      request.continue();
    });

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT_MS,
    });

    await page
      .waitForNetworkIdle({
        idleTime: 500,
        timeout: Math.min(5000, REQUEST_TIMEOUT_MS),
      })
      .catch(() => {});

    const content = await page.content();
    const bodyContent = await page.evaluate(() =>
      (document.body && document.body.textContent
        ? document.body.textContent.trim()
        : '')
    );

    assertNotCloudflareBlocked(`${bodyContent}\n${content}`, 'browser', {
      status: response ? response.status() : null,
      headers: response ? response.headers() : {},
    });

    return {
      bodyContent,
      content,
      source: 'browser',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function initBrowser(proxyUrl = '') {
  if (browser && browser.connected && browserProxyUrl === proxyUrl) {
    return browser;
  }

  if (browser && browser.connected && browserProxyUrl !== proxyUrl) {
    await resetBrowser();
  }

  if (!browserPromise) {
    const browserProxy = parseBrowserProxy(proxyUrl);
    console.log(
      `Launching Chromium${browserProxy ? ` with proxy ${maskProxyUrl(proxyUrl)}` : ''}...`
    );
    browserPromise = puppeteer
      .launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-gpu',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-first-run',
          ...(browserProxy ? [`--proxy-server=${browserProxy.server}`] : []),
        ],
      })
      .then((launchedBrowser) => {
        browser = launchedBrowser;
        browserProxyUrl = proxyUrl;
        browserPromise = null;
        browser.on('disconnected', () => {
          browser = null;
          browserProxyUrl = '';
        });
        return launchedBrowser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }

  return browserPromise;
}

function withBrowserSlot(task) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeBrowserPages += 1;
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      } finally {
        activeBrowserPages -= 1;
        const next = browserQueue.shift();
        if (next) {
          next();
        }
      }
    };

    if (activeBrowserPages < MAX_BROWSER_PAGES) {
      run();
      return;
    }

    browserQueue.push(run);
  });
}

async function resetBrowser() {
  if (!browser) {
    return;
  }

  const oldBrowser = browser;
  browser = null;
  browserProxyUrl = '';
  await oldBrowser.close().catch(() => {});
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  if (manageServer) {
    manageServer.close(() => {});
  }

  server.close(async () => {
    await resetBrowser();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

function buildTargetUrl(req) {
  const [pathPart, queryString] = req.originalUrl.split('?');
  const cleanPath = pathPart
    .replace(/^\/api\/v1\/?/, '')
    .replace(/^\/+/, '');
  const target = new URL(cleanPath, BASE_API);

  if (queryString) {
    target.search = `?${queryString}`;
  }

  return target.toString();
}

function sendProxyResponse(res, result) {
  res.setHeader('X-Proxy-Source', result.source);

  try {
    const json = JSON.parse(result.bodyContent);
    res.status(200).json(json);
  } catch (_err) {
    res.type('html').status(200).send(result.content);
  }
}

function createManageApp() {
  const manageApp = express();
  manageApp.disable('x-powered-by');
  manageApp.use(express.json({ limit: '16kb' }));
  manageApp.use(express.urlencoded({ extended: false, limit: '16kb' }));
  manageApp.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  manageApp.get('/', (req, res) => {
    const auth = getManageAuth(req);
    if (!isManageAuthorized(auth)) {
      res.status(401).type('html').send(renderManageLogin());
      return;
    }

    if (MANAGE_TOKEN && req.query.token === MANAGE_TOKEN) {
      res.cookie('rh_manage_token', MANAGE_TOKEN, {
        httpOnly: true,
        sameSite: 'strict',
      });
      res.redirect('/');
      return;
    }

    res.type('html').send(renderManagePage());
  });

  manageApp.get('/api/status', requireManageAuth, (_req, res) => {
    res.json(getManageStatus());
  });

  manageApp.post('/api/cache/clear', requireManageAuth, (_req, res) => {
    const previousSize = responseCache.size;
    responseCache.clear();
    res.json({ ok: true, cleared: previousSize });
  });

  manageApp.post('/api/browser/restart', requireManageAuth, async (_req, res) => {
    await resetBrowser();
    res.json({ ok: true });
  });

  manageApp.post('/api/proxy/rotate', requireManageAuth, async (_req, res) => {
    await rotateActiveProxy(new Error('Manual proxy rotation'));
    res.json({
      ok: true,
      selectedProxy: maskProxyUrl(proxyState.selectedUrl),
      proxy: getProxyStatus(),
    });
  });

  manageApp.post('/api/test', requireManageAuth, async (req, res) => {
    const path = String(req.body.path || req.query.path || 'shortcuts/6565/versions/latest');
    const startedAt = Date.now();
    try {
      const result = await fetchRoutineHub(buildTargetUrlFromPath(path));
      const durationMs = Date.now() - startedAt;
      res.json({
        ok: true,
        durationMs,
        source: result.source,
        bytes: Buffer.byteLength(result.content),
        json: isJson(result.bodyContent),
        preview: result.bodyContent.slice(0, 500),
      });
    } catch (err) {
      res.status(err.statusCode || 502).json({
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err.publicMessage || err.message,
        code: err.code || 'TEST_FAILED',
        detail: err.publicDetail,
      });
    }
  });

  return manageApp;
}

function requireManageAuth(req, res, next) {
  if (isManageAuthorized(getManageAuth(req))) {
    next();
    return;
  }

  res.status(401).json({
    error: 'Unauthorized',
    detail: MANAGE_TOKEN
      ? 'Pass the management token as a Bearer token, X-Manage-Token header, token query string, or rh_manage_token cookie.'
      : 'Set MANAGE_TOKEN to protect the management UI.',
  });
}

function getManageAuth(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }

  return (
    req.headers['x-manage-token'] ||
    req.query.token ||
    parseCookies(req.headers.cookie || '').rh_manage_token ||
    ''
  );
}

function isManageAuthorized(token) {
  return !MANAGE_TOKEN || token === MANAGE_TOKEN;
}

function getManageStatus() {
  const memory = process.memoryUsage();
  return {
    ok: true,
    service: 'routinehub-proxy',
    startedAt: stats.startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    pid: process.pid,
    proxy: {
      host: HOST,
      port: PORT,
      baseApi: BASE_API,
      outboundProxy: maskProxyUrl(OUTBOUND_PROXY_URL),
      directFetchFirst: DIRECT_FETCH_FIRST,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      autoProxyEnabled: AUTO_PROXY_ENABLED,
      selectedProxy: maskProxyUrl(proxyState.selectedUrl),
    },
    proxyPool: getProxyStatus(),
    management: {
      enabled: MANAGE_ENABLED,
      host: MANAGE_HOST,
      port: MANAGE_PORT,
      authEnabled: Boolean(MANAGE_TOKEN),
    },
    chromium: {
      path: CHROME_PATH,
      connected: Boolean(browser && browser.connected),
      activePages: activeBrowserPages,
      queuedPages: browserQueue.length,
      maxPages: MAX_BROWSER_PAGES,
    },
    cache: {
      size: responseCache.size,
      maxEntries: MAX_CACHE_ENTRIES,
      ttlMs: CACHE_TTL_MS,
    },
    stats: {
      proxyRequests: stats.proxyRequests,
      proxyErrors: stats.proxyErrors,
      cacheHits: stats.cacheHits,
      directFetches: stats.directFetches,
      browserFetches: stats.browserFetches,
      lastProxyRequestAt: stats.lastProxyRequestAt
        ? stats.lastProxyRequestAt.toISOString()
        : null,
      lastProxyError: stats.lastProxyError,
    },
    memory: {
      rssMb: toMb(memory.rss),
      heapUsedMb: toMb(memory.heapUsed),
      heapTotalMb: toMb(memory.heapTotal),
      externalMb: toMb(memory.external),
    },
  };
}

function renderManageLogin() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RoutineHub Proxy Manage</title>
  ${manageStyles()}
</head>
<body>
  <main class="login">
    <h1>RoutineHub Proxy</h1>
    <form method="get" action="/">
      <label for="token">Management token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus>
      <button type="submit">Open</button>
    </form>
  </main>
</body>
</html>`;
}

function renderManagePage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RoutineHub Proxy Manage</title>
  ${manageStyles()}
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>RoutineHub Proxy</h1>
        <p id="subline">Loading...</p>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </header>

    <section class="grid">
      <article>
        <h2>Runtime</h2>
        <dl id="runtime"></dl>
      </article>
      <article>
        <h2>Traffic</h2>
        <dl id="traffic"></dl>
      </article>
      <article>
        <h2>Chromium</h2>
        <dl id="chromium"></dl>
      </article>
      <article>
        <h2>Memory</h2>
        <dl id="memory"></dl>
      </article>
    </section>

    <section class="actions">
      <form id="test-form">
        <label for="test-path">Test path</label>
        <div class="row">
          <input id="test-path" name="path" value="shortcuts/6565/versions/latest">
          <button type="submit">Run Test</button>
        </div>
      </form>
      <div class="row">
        <button id="clear-cache" type="button">Clear Cache</button>
        <button id="restart-browser" type="button">Restart Chromium</button>
        <button id="rotate-proxy" type="button">Rotate Proxy</button>
      </div>
    </section>

    <pre id="result"></pre>
  </main>
  <script>${manageScript()}</script>
</body>
</html>`;
}

function manageStyles() {
  return `<style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #151922;
      --muted: #5f6878;
      --line: #d9dee8;
      --accent: #0d6efd;
      --bad: #b42318;
      --good: #067647;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111318;
        --panel: #191d24;
        --text: #f3f5f8;
        --muted: #a7afbd;
        --line: #303642;
        --accent: #6ea8fe;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .shell {
      width: min(1120px, calc(100vw - 32px));
      margin: 24px auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 16px;
    }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; }
    h2 { font-size: 15px; margin-bottom: 12px; }
    p, dd { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    article, .actions, pre, .login {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    dl {
      display: grid;
      grid-template-columns: minmax(96px, 0.8fr) minmax(0, 1.2fr);
      gap: 8px 12px;
      margin: 0;
    }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    button, input {
      height: 36px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      font: inherit;
    }
    button {
      padding: 0 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    input {
      min-width: 0;
      padding: 0 10px;
      width: 100%;
    }
    label {
      display: block;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: end;
      margin: 12px 0;
    }
    .row { display: flex; gap: 8px; }
    .row input { flex: 1; }
    pre {
      min-height: 120px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .login {
      width: min(420px, calc(100vw - 32px));
      margin: 18vh auto 0;
    }
    .login h1 { margin-bottom: 18px; }
    .login button { width: 100%; margin-top: 10px; }
    .ok { color: var(--good); }
    .bad { color: var(--bad); }
    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .actions { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
      header, .row { flex-direction: column; align-items: stretch; }
    }
  </style>`;
}

function manageScript() {
  return `
    const fields = {
      runtime: document.getElementById('runtime'),
      traffic: document.getElementById('traffic'),
      chromium: document.getElementById('chromium'),
      memory: document.getElementById('memory'),
      result: document.getElementById('result'),
      subline: document.getElementById('subline'),
    };

    function entries(target, rows) {
      target.innerHTML = rows
        .map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(String(value ?? '')) + '</dd>')
        .join('');
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]);
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
      });
      const data = await response.json();
      if (!response.ok) {
        throw data;
      }
      return data;
    }

    async function loadStatus() {
      const status = await api('/api/status');
      fields.subline.innerHTML = status.ok
        ? '<span class="ok">Online</span> · uptime ' + status.uptimeSeconds + 's'
        : '<span class="bad">Issue detected</span>';
      entries(fields.runtime, [
        ['Proxy', status.proxy.host + ':' + status.proxy.port],
        ['Manage', status.management.host + ':' + status.management.port],
        ['Base API', status.proxy.baseApi],
        ['Proxy URL', status.proxy.selectedProxy || status.proxy.outboundProxy || 'none'],
        ['Auto proxy', status.proxy.autoProxyEnabled],
        ['Node', status.nodeVersion],
      ]);
      entries(fields.traffic, [
        ['Requests', status.stats.proxyRequests],
        ['Errors', status.stats.proxyErrors],
        ['Cache hits', status.stats.cacheHits],
        ['Direct fetches', status.stats.directFetches],
        ['Browser fetches', status.stats.browserFetches],
        ['Proxy rotations', status.proxyPool.rotations],
      ]);
      entries(fields.chromium, [
        ['Connected', status.chromium.connected],
        ['Active pages', status.chromium.activePages],
        ['Queued pages', status.chromium.queuedPages],
        ['Max pages', status.chromium.maxPages],
        ['Path', status.chromium.path],
      ]);
      entries(fields.memory, [
        ['RSS MB', status.memory.rssMb],
        ['Heap used MB', status.memory.heapUsedMb],
        ['Heap total MB', status.memory.heapTotalMb],
        ['Cache size', status.cache.size + '/' + status.cache.maxEntries],
      ]);
      fields.result.textContent = JSON.stringify(status.stats.lastProxyError || { ok: true }, null, 2);
    }

    document.getElementById('refresh').addEventListener('click', loadStatus);
    document.getElementById('clear-cache').addEventListener('click', async () => {
      fields.result.textContent = JSON.stringify(await api('/api/cache/clear', { method: 'POST', body: '{}' }), null, 2);
      await loadStatus();
    });
    document.getElementById('restart-browser').addEventListener('click', async () => {
      fields.result.textContent = JSON.stringify(await api('/api/browser/restart', { method: 'POST', body: '{}' }), null, 2);
      await loadStatus();
    });
    const rotateButton = document.getElementById('rotate-proxy');
    if (rotateButton) {
      rotateButton.addEventListener('click', async () => {
        fields.result.textContent = 'Rotating proxy...';
        fields.result.textContent = JSON.stringify(await api('/api/proxy/rotate', { method: 'POST', body: '{}' }), null, 2);
        await loadStatus();
      });
    }
    document.getElementById('test-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const path = document.getElementById('test-path').value;
      fields.result.textContent = 'Running...';
      try {
        fields.result.textContent = JSON.stringify(await api('/api/test', {
          method: 'POST',
          body: JSON.stringify({ path }),
        }), null, 2);
      } catch (err) {
        fields.result.textContent = JSON.stringify(err, null, 2);
      }
      await loadStatus();
    });
    loadStatus().catch((err) => {
      fields.subline.innerHTML = '<span class="bad">Unable to load status</span>';
      fields.result.textContent = JSON.stringify(err, null, 2);
    });
  `;
}

function parseCookies(header) {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index === -1) {
        return cookies;
      }

      cookies[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(
        part.slice(index + 1)
      );
      return cookies;
    }, {});
}

function buildTargetUrlFromPath(path) {
  if (/^https?:\/\//i.test(path) && !/^https:\/\/routinehub\.co\/api\/v1\//i.test(path)) {
    const err = new Error('Management tests can only target RoutineHub API URLs');
    err.statusCode = 400;
    err.code = 'INVALID_TEST_TARGET';
    err.publicMessage = 'Invalid test target';
    err.publicDetail = 'Use a RoutineHub API path or https://routinehub.co/api/v1/ URL.';
    throw err;
  }

  const cleanPath = path.replace(/^https:\/\/routinehub\.co\/api\/v1\//i, '');
  const target = new URL(cleanPath.replace(/^\/+/, ''), BASE_API);
  return target.toString();
}

function serializeError(err) {
  return {
    name: err.name || 'Error',
    message: err.publicMessage || err.message,
    code: err.code || null,
    detail: err.publicDetail || null,
    at: new Date().toISOString(),
  };
}

function toMb(value) {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}

function getCached(key) {
  if (CACHE_TTL_MS <= 0) {
    return null;
  }

  const entry = responseCache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }

  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.value;
}

function setCached(key, value) {
  if (CACHE_TTL_MS <= 0) {
    return;
  }

  responseCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });

  while (responseCache.size > MAX_CACHE_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch (_err) {
    return false;
  }
}

function withTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function toPort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : fallback;
}

async function getActiveProxyUrl() {
  if (!AUTO_PROXY_ENABLED) {
    return OUTBOUND_PROXY_URL;
  }

  if (proxyState.selectedUrl && !isProxyBad(proxyState.selectedUrl)) {
    return proxyState.selectedUrl;
  }

  return selectWorkingProxy();
}

async function rotateActiveProxy(err) {
  if (!AUTO_PROXY_ENABLED) {
    return OUTBOUND_PROXY_URL;
  }

  if (proxyState.selectedUrl) {
    markProxyBad(proxyState.selectedUrl, err);
  }

  proxyState.selectedUrl = '';
  proxyState.selectedAt = null;
  proxyState.rotations += 1;
  await resetBrowser();
  return selectWorkingProxy();
}

async function selectWorkingProxy() {
  if (proxyState.selectPromise) {
    return proxyState.selectPromise;
  }

  proxyState.selectPromise = (async () => {
    const list = await refreshProxyList();
    let candidates = shuffle(list.filter((proxyUrl) => !isProxyBad(proxyUrl)));

    if (!candidates.length) {
      proxyState.badUntil.clear();
      candidates = shuffle(await refreshProxyList(true));
    }

    const limit = Math.min(PROXY_TEST_CANDIDATES, candidates.length);
    const limited = candidates.slice(0, limit);

    for (let i = 0; i < limited.length; i += PROXY_TEST_CONCURRENCY) {
      const batch = limited.slice(i, i + PROXY_TEST_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (proxyUrl) => {
          try {
            await testProxy(proxyUrl);
            return proxyUrl;
          } catch (err) {
            markProxyBad(proxyUrl, err);
            return null;
          }
        })
      );
      const selected = results.find(Boolean);

      if (selected) {
        const previous = proxyState.selectedUrl;
        proxyState.selectedUrl = selected;
        proxyState.selectedAt = new Date();
        proxyState.working += 1;

        if (previous && previous !== selected) {
          await resetBrowser();
        }

        console.log(`Selected outbound proxy ${maskProxyUrl(selected)}`);
        return selected;
      }
    }

    const err = new Error('No working proxy found in sampled proxy list');
    err.name = 'ProxySelectionError';
    err.code = 'PROXY_SELECTION_FAILED';
    err.statusCode = 502;
    err.publicMessage = 'No working outbound proxy is currently available';
    err.publicDetail =
      'The proxy list was fetched, but sampled proxies failed HTTPS connectivity or were blocked by RoutineHub.';
    proxyState.lastError = serializeError(err);
    throw err;
  })().finally(() => {
    proxyState.selectPromise = null;
  });

  return proxyState.selectPromise;
}

async function refreshProxyList(force = false) {
  if (!AUTO_PROXY_ENABLED) {
    return [];
  }

  const fresh =
    proxyState.list.length &&
    Date.now() - proxyState.fetchedAt < PROXY_LIST_REFRESH_MS;

  if (fresh && !force) {
    return proxyState.list;
  }

  if (proxyState.refreshPromise) {
    return proxyState.refreshPromise;
  }

  proxyState.refreshPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(PROXY_LIST_URL, {
        headers: {
          Accept: 'text/plain,*/*;q=0.8',
          'User-Agent': USER_AGENT,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Proxy list fetch failed with HTTP ${response.status}`);
      }

      const text = await response.text();
      const proxies = Array.from(
        new Set(
          text
            .split(/\r?\n/)
            .map(normalizeProxyUrl)
            .filter(Boolean)
        )
      );

      if (!proxies.length) {
        throw new Error('Proxy list did not contain usable proxy URLs');
      }

      proxyState.list = proxies;
      proxyState.fetchedAt = Date.now();
      console.log(`Loaded ${proxies.length} proxies from proxy list`);
      return proxies;
    } catch (err) {
      proxyState.lastError = serializeError(err);
      if (proxyState.list.length) {
        return proxyState.list;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    proxyState.refreshPromise = null;
  });

  return proxyState.refreshPromise;
}

async function testProxy(proxyUrl) {
  proxyState.tested += 1;
  proxyState.lastTestAt = new Date();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);

  try {
    const response = await fetch(PROXY_TEST_URL, {
      dispatcher: getFetchDispatcher(proxyUrl),
      headers: {
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    const body = await response.text();

    assertNotCloudflareBlocked(body, 'proxy-test', {
      status: response.status,
      headers: response.headers,
    });

    if (response.status === 407) {
      throw new Error('Proxy authentication required');
    }

    if (response.status >= 500) {
      throw new Error(`Proxy test returned HTTP ${response.status}`);
    }

    return true;
  } finally {
    clearTimeout(timeout);
  }
}

function getFetchDispatcher(proxyUrl) {
  if (!proxyUrl) {
    return undefined;
  }

  if (!fetchDispatchers.has(proxyUrl)) {
    fetchDispatchers.set(proxyUrl, createFetchDispatcher(proxyUrl));
  }

  return fetchDispatchers.get(proxyUrl);
}

function markProxyBad(proxyUrl, err) {
  if (!proxyUrl) {
    return;
  }

  proxyState.failed += 1;
  proxyState.badUntil.set(proxyUrl, Date.now() + PROXY_BAD_TTL_MS);
  proxyState.lastError = serializeError(err);
}

function isProxyBad(proxyUrl) {
  const badUntil = proxyState.badUntil.get(proxyUrl);
  if (!badUntil) {
    return false;
  }

  if (badUntil <= Date.now()) {
    proxyState.badUntil.delete(proxyUrl);
    return false;
  }

  return true;
}

function shouldRotateProxy(err) {
  if (!err || !AUTO_PROXY_ENABLED) {
    return false;
  }

  return (
    err.isBlocked === true ||
    err.code === 'UPSTREAM_BLOCKED' ||
    err.code === 'UPSTREAM_ASN_BLOCKED'
  );
}

function getProxyStatus() {
  return {
    autoEnabled: AUTO_PROXY_ENABLED,
    listConfigured: Boolean(PROXY_LIST_URL),
    listSize: proxyState.list.length,
    fetchedAt: proxyState.fetchedAt
      ? new Date(proxyState.fetchedAt).toISOString()
      : null,
    selectedProxy: maskProxyUrl(proxyState.selectedUrl),
    selectedAt: proxyState.selectedAt
      ? proxyState.selectedAt.toISOString()
      : null,
    badCount: Array.from(proxyState.badUntil.keys()).filter(isProxyBad).length,
    tested: proxyState.tested,
    working: proxyState.working,
    failed: proxyState.failed,
    rotations: proxyState.rotations,
    lastTestAt: proxyState.lastTestAt
      ? proxyState.lastTestAt.toISOString()
      : null,
    lastError: proxyState.lastError,
    testCandidates: PROXY_TEST_CANDIDATES,
    testConcurrency: PROXY_TEST_CONCURRENCY,
    testTimeoutMs: PROXY_TEST_TIMEOUT_MS,
  };
}

function normalizeProxyUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    if (!parsed.hostname || !parsed.port) {
      return null;
    }

    return parsed.toString();
  } catch (_err) {
    return null;
  }
}

function shuffle(values) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function createFetchDispatcher(proxyUrl) {
  if (!proxyUrl) {
    return undefined;
  }

  return new ProxyAgent(proxyUrl);
}

function parseBrowserProxy(proxyUrl) {
  if (!proxyUrl) {
    return null;
  }

  const parsed = new URL(proxyUrl);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    auth: parsed.username
      ? {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        }
      : null,
  };
}

function assertNotCloudflareBlocked(text, source, responseInfo = {}) {
  if (!isCloudflareBlocked(text, responseInfo)) {
    return;
  }

  const err = new Error(`RoutineHub blocked the ${source} request`);
  err.name = 'UpstreamBlockedError';
  err.code = 'UPSTREAM_BLOCKED';
  err.statusCode = 502;
  err.isBlocked = true;
  err.publicMessage = 'RoutineHub blocked the selected outbound IP/proxy';
  err.publicDetail =
    'The selected egress IP/proxy was blocked by RoutineHub/Cloudflare. The proxy will rotate on detected block responses until a working proxy is found or the retry limit is reached.';
  throw err;
}

function isCloudflareBlocked(text, responseInfo = {}) {
  const normalized = String(text || '').toLowerCase();
  const headers = normalizeHeaders(responseInfo.headers);
  const status = Number(responseInfo.status || 0);
  const contentType = headers['content-type'] || '';
  const server = headers.server || '';
  const hasCloudflareHeader =
    server.includes('cloudflare') ||
    Boolean(headers['cf-ray'] || headers['cf-cache-status']);
  const hasCloudflareText = normalized.includes('cloudflare');
  const hasHtmlBody =
    contentType.includes('html') || normalized.includes('<html');
  const hasKnownBlockText =
    normalized.includes('error 1005') ||
    normalized.includes('error 1020') ||
    (normalized.includes('autonomous system number') &&
      normalized.includes('banned')) ||
    (normalized.includes('the owner of this website') &&
      normalized.includes('has banned')) ||
    (hasCloudflareText &&
      (normalized.includes('access denied') ||
        normalized.includes('you have been blocked') ||
        normalized.includes('attention required')));

  if (hasKnownBlockText) {
    return true;
  }

  return (
    [403, 429, 503].includes(status) &&
    hasCloudflareHeader &&
    hasHtmlBody &&
    (hasCloudflareText || status === 403)
  );
}

function normalizeHeaders(headers = {}) {
  const normalized = {};

  if (!headers) {
    return normalized;
  }

  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      normalized[String(key).toLowerCase()] = String(value).toLowerCase();
    });
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = String(value).toLowerCase();
  }

  return normalized;
}

function maskProxyUrl(proxyUrl) {
  if (!proxyUrl) {
    return null;
  }

  const parsed = new URL(proxyUrl);
  if (parsed.username) {
    parsed.username = '***';
    parsed.password = parsed.password ? '***' : '';
  }

  return parsed.toString();
}
