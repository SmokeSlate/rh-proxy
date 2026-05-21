'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const app = express();
app.disable('x-powered-by');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const BASE_API = withTrailingSlash(
  process.env.ROUTINEHUB_API_BASE || 'https://routinehub.co/api/v1/'
);
const REQUEST_TIMEOUT_MS = toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 30000);
const CACHE_TTL_MS = toNonNegativeInt(process.env.CACHE_TTL_MS, 30000);
const MAX_CACHE_ENTRIES = toPositiveInt(process.env.MAX_CACHE_ENTRIES, 100);
const MAX_BROWSER_PAGES = toPositiveInt(process.env.MAX_BROWSER_PAGES, 2);
const RATE_LIMIT_MAX = toPositiveInt(process.env.RATE_LIMIT_MAX, 60);
const DIRECT_FETCH_FIRST = process.env.DIRECT_FETCH_FIRST !== 'false';
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
let activeBrowserPages = 0;
const browserQueue = [];
const responseCache = new Map();

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

  const targetUrl = buildTargetUrl(req);
  const cacheKey = `${req.method}:${targetUrl}`;
  const cached = getCached(cacheKey);

  if (cached) {
    sendProxyResponse(res, cached);
    return;
  }

  try {
    const result = await fetchRoutineHub(targetUrl);
    setCached(cacheKey, result);
    sendProxyResponse(res, result);
  } catch (err) {
    console.error('Proxy error:', err);
    await resetBrowser();
    res.status(502).json({ error: 'Unable to fetch RoutineHub data' });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Proxy listening on http://${HOST}:${PORT}`);
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
  if (DIRECT_FETCH_FIRST) {
    try {
      return await fetchDirect(url);
    } catch (err) {
      console.warn(`Direct fetch failed, falling back to browser: ${err.message}`);
    }
  }

  return withBrowserSlot(() => fetchWithBrowser(url));
}

async function fetchDirect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    const bodyContent = await response.text();
    const contentType = response.headers.get('content-type') || '';

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
  const b = await initBrowser();
  const page = await b.newPage();

  try {
    page.setDefaultNavigationTimeout(REQUEST_TIMEOUT_MS);
    page.setDefaultTimeout(REQUEST_TIMEOUT_MS);

    await page.setUserAgent(USER_AGENT);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['font', 'image', 'media', 'stylesheet'].includes(request.resourceType())) {
        request.abort();
        return;
      }

      request.continue();
    });

    await page.goto(url, {
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

    return {
      bodyContent,
      content,
      source: 'browser',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function initBrowser() {
  if (browser && browser.connected) {
    return browser;
  }

  if (!browserPromise) {
    console.log('Launching Chromium...');
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
        ],
      })
      .then((launchedBrowser) => {
        browser = launchedBrowser;
        browserPromise = null;
        browser.on('disconnected', () => {
          browser = null;
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
  await oldBrowser.close().catch(() => {});
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
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
