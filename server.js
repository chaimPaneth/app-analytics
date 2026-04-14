require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://api.appstoreconnect.apple.com';

// ── Data directory for user-uploaded keys ────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_DIR = path.join(DATA_DIR, 'keys');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directories exist
fs.mkdirSync(KEYS_DIR, { recursive: true });

// ── Configuration management ─────────────────────────────────
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (_) {}
  }
  // Fall back to env vars for backward compatibility
  return {
    apple: {
      issuerId: process.env.APPLE_ISSUER_ID || '',
      keyId: process.env.APPLE_KEY_ID || '',
      keyFile: process.env.APPLE_KEY_FILE || '',
      vendorNumber: process.env.APPLE_VENDOR_NUMBER || '',
    },
    google: {
      developerId: process.env.GOOGLE_DEVELOPER_ID || '',
      serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
      packages: process.env.GOOGLE_PACKAGES || '',
    },
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function getConfig() {
  return loadConfig();
}

function isAppleConfigured() {
  const c = getConfig().apple;
  return !!(c.issuerId && c.keyId && c.keyFile && c.vendorNumber);
}

function isGoogleConfigured() {
  const c = getConfig().google;
  return !!(c.developerId && c.serviceAccountFile);
}

// ── Progress tracking ────────────────────────────────────────
const activeProgress = {};

function updateProgress(id, phase, message, percent) {
  activeProgress[id] = { phase, message, percent, updatedAt: Date.now() };
}

function clearProgress(id) {
  delete activeProgress[id];
}

app.get('/api/progress/:id', (req, res) => {
  const p = activeProgress[req.params.id];
  res.json(p || { phase: 'idle', message: '', percent: 0 });
});

// ── Serve static files ──────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// ── Setup / Configuration API ────────────────────────────────
app.get('/api/config', (req, res) => {
  const config = getConfig();
  // Return config but mask sensitive file contents
  res.json({
    apple: {
      issuerId: config.apple.issuerId || '',
      keyId: config.apple.keyId || '',
      vendorNumber: config.apple.vendorNumber || '',
      hasKeyFile: !!(config.apple.keyFile && fs.existsSync(path.resolve(config.apple.keyFile))),
    },
    google: {
      developerId: config.google.developerId || '',
      hasServiceAccount: !!(config.google.serviceAccountFile && fs.existsSync(path.resolve(config.google.serviceAccountFile))),
      packages: config.google.packages || '',
    },
    isConfigured: {
      apple: isAppleConfigured(),
      google: isGoogleConfigured(),
    },
  });
});

app.post('/api/config/apple', (req, res) => {
  const { issuerId, keyId, vendorNumber } = req.body;
  if (!issuerId || !keyId || !vendorNumber) {
    return res.status(400).json({ error: 'issuerId, keyId, and vendorNumber are required.' });
  }
  // Validate input format
  if (!/^[a-f0-9-]+$/i.test(issuerId)) {
    return res.status(400).json({ error: 'Invalid Issuer ID format.' });
  }
  if (!/^[A-Z0-9]+$/i.test(keyId)) {
    return res.status(400).json({ error: 'Invalid Key ID format.' });
  }
  if (!/^[0-9]+$/.test(vendorNumber)) {
    return res.status(400).json({ error: 'Vendor Number must be numeric.' });
  }

  const config = getConfig();
  config.apple.issuerId = issuerId.trim();
  config.apple.keyId = keyId.trim();
  config.apple.vendorNumber = vendorNumber.trim();
  saveConfig(config);

  // Reset cached token so new credentials take effect
  cachedToken = null;
  tokenExpiry = 0;

  res.json({ ok: true });
});

app.post('/api/config/apple/key', (req, res) => {
  const { keyContent, fileName } = req.body;
  if (!keyContent) {
    return res.status(400).json({ error: 'Key file content is required.' });
  }
  // Validate it's a valid .p8 PEM key
  if (!keyContent.includes('BEGIN PRIVATE KEY')) {
    return res.status(400).json({ error: 'Invalid .p8 key file. Must be a PEM-encoded PKCS#8 private key.' });
  }

  const safeName = (fileName || 'AuthKey.p8').replace(/[^a-zA-Z0-9._-]/g, '_');
  const keyPath = path.join(KEYS_DIR, safeName);
  fs.writeFileSync(keyPath, keyContent, 'utf8');

  const config = getConfig();
  config.apple.keyFile = keyPath;
  saveConfig(config);

  // Reset cached token
  cachedToken = null;
  tokenExpiry = 0;

  res.json({ ok: true, path: keyPath });
});

app.post('/api/config/google', (req, res) => {
  const { developerId, packages } = req.body;
  if (!developerId) {
    return res.status(400).json({ error: 'Developer ID is required.' });
  }
  if (!/^[0-9]+$/.test(developerId)) {
    return res.status(400).json({ error: 'Developer ID must be numeric.' });
  }

  const config = getConfig();
  config.google.developerId = developerId.trim();
  if (packages !== undefined) config.google.packages = packages.trim();
  saveConfig(config);

  // Update runtime variables
  reloadGoogleConfig();

  res.json({ ok: true });
});

app.post('/api/config/google/service-account', (req, res) => {
  const { keyContent } = req.body;
  if (!keyContent) {
    return res.status(400).json({ error: 'Service account JSON is required.' });
  }

  let parsed;
  try {
    parsed = JSON.parse(keyContent);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON. Must be a Google service account key file.' });
  }

  if (!parsed.type || parsed.type !== 'service_account') {
    return res.status(400).json({ error: 'Invalid service account file. "type" must be "service_account".' });
  }
  if (!parsed.client_email || !parsed.private_key) {
    return res.status(400).json({ error: 'Service account file is missing required fields.' });
  }

  const keyPath = path.join(KEYS_DIR, 'google-service-account.json');
  fs.writeFileSync(keyPath, JSON.stringify(parsed, null, 2), 'utf8');

  const config = getConfig();
  config.google.serviceAccountFile = keyPath;
  saveConfig(config);

  // Reset google auth
  _googleAuth = null;
  reloadGoogleConfig();

  res.json({ ok: true, path: keyPath });
});

app.post('/api/config/test/apple', async (req, res) => {
  try {
    if (!isAppleConfigured()) {
      return res.status(400).json({ error: 'Apple is not fully configured yet.' });
    }
    // Try fetching apps to test credentials
    const token = getAppleToken();
    const { data } = await axios.get(`${BASE_URL}/v1/apps?limit=1&fields[apps]=name`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    res.json({ ok: true, message: `Connected! Found ${data.data?.length || 0} app(s).` });
  } catch (err) {
    const detail = err.response?.data?.errors?.[0]?.detail || err.message;
    res.status(400).json({ error: `Apple API test failed: ${detail}` });
  }
});

app.post('/api/config/test/google', async (req, res) => {
  try {
    if (!isGoogleConfigured()) {
      return res.status(400).json({ error: 'Google is not fully configured yet.' });
    }
    // Try to discover apps
    const apps = await discoverAppsViaReportingAPI();
    res.json({ ok: true, message: `Connected! Found ${apps.length} app(s).` });
  } catch (err) {
    // Try GCS as fallback test
    try {
      const bucketName = getBucketName();
      if (bucketName) {
        const files = await gsutilLs('stats/installs/');
        res.json({ ok: true, message: `Connected via GCS! Found install data.` });
        return;
      }
    } catch (_) {}
    res.status(400).json({ error: `Google API test failed: ${err.message}` });
  }
});

// ── Apple JWT Token ──────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

function getAppleToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiry - 60) return cachedToken;

  const config = getConfig().apple;
  const keyPath = path.resolve(config.keyFile);
  const privateKey = fs.readFileSync(keyPath, 'utf8');

  const payload = {
    iss: config.issuerId,
    iat: now,
    exp: now + 1200,
    aud: 'appstoreconnect-v1',
  };

  cachedToken = jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    keyid: config.keyId,
  });
  tokenExpiry = now + 1200;
  return cachedToken;
}

function appleHeaders(accept = 'application/json') {
  return {
    Authorization: `Bearer ${getAppleToken()}`,
    Accept: accept,
  };
}

// ── API: List all apps ───────────────────────────────────────
app.get('/api/apps', async (req, res) => {
  try {
    const apps = [];
    let url = `${BASE_URL}/v1/apps?limit=200&fields[apps]=name,bundleId,sku`;

    while (url) {
      const { data } = await axios.get(url, { headers: appleHeaders() });
      apps.push(
        ...data.data.map((a) => ({
          id: a.id,
          name: a.attributes.name,
          bundleId: a.attributes.bundleId,
          sku: a.attributes.sku,
        }))
      );
      url = data.links?.next || null;
    }

    res.json({ apps, count: apps.length });
  } catch (err) {
    console.error('Error fetching apps:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.errors?.[0]?.detail || err.message,
    });
  }
});

// ── API: All-time download stats ─────────────────────────────
app.get('/api/downloads/alltime', async (req, res) => {
  const progressId = req.query.progressId;
  try {
    const vendorNumber = getConfig().apple.vendorNumber;
    if (!vendorNumber) {
      return res.status(400).json({ error: 'Vendor number not configured. Complete setup first.' });
    }

    console.log('All-time: fetching smart range from 2010 to now...');
    if (progressId) updateProgress(progressId, 'downloading', 'Fetching all-time Apple download reports (2010–now)...', 10);
    const now = new Date();
    const toStr = now.toISOString().split('T')[0];
    const allRows = await fetchSmartRange(vendorNumber, '2010-01-01', toStr, progressId);
    console.log(`All-time: Got ${allRows.length} total rows`);

    if (progressId) updateProgress(progressId, 'aggregating', 'Aggregating download data...', 90);
    const result = aggregateRows(allRows);
    if (progressId) clearProgress(progressId);
    res.json({
      ...result,
      period: { from: '2010', to: 'Now' },
      frequency: 'ALL_TIME',
    });
  } catch (err) {
    if (progressId) clearProgress(progressId);
    console.error('All-time error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Smart range (auto-selects yearly/monthly/daily) ─────
app.get('/api/downloads/range', async (req, res) => {
  const progressId = req.query.progressId;
  try {
    const { from, to } = req.query;
    const vendorNumber = getConfig().apple.vendorNumber;

    if (!vendorNumber) {
      return res.status(400).json({ error: 'Vendor number not configured. Complete setup first.' });
    }
    if (!from || !to) {
      return res.status(400).json({ error: 'Both "from" and "to" query params are required.' });
    }

    console.log(`Smart range: ${from} → ${to}`);
    if (progressId) updateProgress(progressId, 'downloading', `Fetching Apple reports: ${from} → ${to}`, 10);
    const allRows = await fetchSmartRange(vendorNumber, from, to, progressId);
    console.log(`Smart range: Got ${allRows.length} total rows`);

    if (progressId) updateProgress(progressId, 'aggregating', 'Aggregating download data...', 90);
    const result = aggregateRows(allRows);
    if (progressId) clearProgress(progressId);
    res.json({
      ...result,
      period: { from, to },
      frequency: 'SMART',
    });
  } catch (err) {
    if (progressId) clearProgress(progressId);
    console.error('Smart range error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Download stats ──────────────────────────────────────
app.get('/api/downloads', async (req, res) => {
  try {
    const { date, from, to, frequency = 'DAILY' } = req.query;
    const vendorNumber = getConfig().apple.vendorNumber;

    if (!vendorNumber) {
      return res.status(400).json({
        error: 'Vendor number not configured. Complete setup first.',
      });
    }

    // Determine which dates to fetch
    let datesToFetch = [];

    if (date) {
      datesToFetch = [date];
    } else if (from && to) {
      datesToFetch = buildDateList(from, to, frequency);
    } else {
      // Default: 2 days ago (Apple reports have ~2 day delay)
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000)
        .toISOString()
        .split('T')[0];
      datesToFetch = [twoDaysAgo];
    }

    // Fetch all reports (with concurrency limit)
    const allRows = [];
    const errors = [];
    const BATCH_SIZE = datesToFetch.length > 20 ? 3 : 5;
    const BATCH_DELAY = datesToFetch.length > 20 ? 500 : 0;

    console.log(`Fetching ${datesToFetch.length} ${frequency} report(s) in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < datesToFetch.length; i += BATCH_SIZE) {
      const batch = datesToFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((d) => fetchSalesReport(vendorNumber, d, frequency))
      );

      let batchSuccess = 0;
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          allRows.push(...results[j].value);
          batchSuccess++;
        } else {
          const err = results[j].reason;
          const status = err.response?.status;
          // 404 = no data for that period (normal for future/early months)
          if (status !== 404) {
            console.log(`  Report ${batch[j]}: ${status || 'error'} - ${err.message}`);
            if (status !== 400) {
              errors.push({ date: batch[j], error: err.message });
            }
          }
        }
      }

      if (BATCH_DELAY && i + BATCH_SIZE < datesToFetch.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }

    console.log(`Got ${allRows.length} rows from ${datesToFetch.length} reports`);

    // Product type identifiers that represent NEW downloads
    const downloadTypes = new Set([
      '1',    // Free or Paid Apps
      '1F',   // Free Apps (Universal)
      '1T',   // Paid Apps (Universal)
      'F1',   // Free Apps (iPhone)
      'FI1',  // Free Apps (iPad)
      '1E',   // Free App (Custom)
      '1EP',  // Paid App (Custom)
      '1EU',  // Paid App (Universal Custom)
    ]);

    // Update types (track separately)
    const updateTypes = new Set(['7', '7F', '7T', 'F7']);

    // Re-download types
    const redownloadTypes = new Set(['3', '3F', '3T', 'F3']);

    // In-App Purchase types
    const iapTypes = new Set(['IA1', 'IA9', 'IAY', 'IA1-M', 'IAC', 'FI1']);

    // Aggregate by app
    const byApp = {};
    let totalDownloads = 0;
    let totalUpdates = 0;
    let totalRedownloads = 0;
    let totalIAP = 0;
    let totalProceeds = 0;

    for (const row of allRows) {
      const type = (row['Product Type Identifier'] || '').trim();
      const units = parseInt(row['Units'] || '0', 10);
      const title = (row['Title'] || 'Unknown').trim();
      const appleId = (row['Apple Identifier'] || '').trim();
      const sku = (row['SKU'] || '').trim();
      const country = (row['Country Code'] || '??').trim();
      const version = (row['Version'] || '').trim();
      const proceeds = parseFloat(row['Developer Proceeds'] || '0');
      const key = appleId || sku || title;

      if (!byApp[key]) {
        byApp[key] = {
          appleId,
          sku,
          title,
          downloads: 0,
          updates: 0,
          redownloads: 0,
          iap: 0,
          proceeds: 0,
          countries: {},
          versions: {},
        };
      }

      if (downloadTypes.has(type)) {
        byApp[key].downloads += units;
        byApp[key].countries[country] =
          (byApp[key].countries[country] || 0) + units;
        totalDownloads += units;
        if (version) {
          byApp[key].versions[version] = (byApp[key].versions[version] || 0) + units;
        }
      } else if (updateTypes.has(type)) {
        byApp[key].updates += units;
        totalUpdates += units;
      } else if (redownloadTypes.has(type)) {
        byApp[key].redownloads += units;
        totalRedownloads += units;
      } else if (iapTypes.has(type)) {
        byApp[key].iap += units;
        totalIAP += units;
      }

      if (proceeds && !isNaN(proceeds)) {
        byApp[key].proceeds += proceeds * units;
        totalProceeds += proceeds * units;
      }
    }

    // Sort by downloads descending
    const apps = Object.values(byApp).sort((a, b) => b.downloads - a.downloads);

    // Convert versions to sorted arrays (top 10)
    for (const app of apps) {
      app.versions = Object.entries(app.versions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([version, installs]) => ({ version, installs }));
    }

    // Top countries across all apps
    const globalCountries = {};
    for (const a of apps) {
      for (const [c, u] of Object.entries(a.countries)) {
        globalCountries[c] = (globalCountries[c] || 0) + u;
      }
    }
    const topCountries = Object.entries(globalCountries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, units]) => ({ code, units }));

    res.json({
      totalDownloads,
      totalUpdates,
      totalRedownloads,
      totalIAP,
      totalProceeds: Math.round(totalProceeds * 100) / 100,
      appCount: apps.length,
      apps,
      topCountries,
      period: date
        ? { date }
        : { from: from || datesToFetch[0], to: to || datesToFetch[0] },
      frequency,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    const errData = err.response?.data;
    let errorDetail = err.message;
    
    // Try to parse gzipped error responses from Apple
    if (errData && Buffer.isBuffer(errData)) {
      try {
        const decompressed = zlib.gunzipSync(Buffer.from(errData));
        const parsed = JSON.parse(decompressed.toString('utf-8'));
        errorDetail = parsed.errors?.[0]?.detail || JSON.stringify(parsed);
      } catch (_) {
        try { errorDetail = errData.toString('utf-8'); } catch (_2) {}
      }
    } else if (errData?.errors) {
      errorDetail = errData.errors.map(e => e.detail).join('; ');
    }
    
    console.error('Error fetching downloads:', errorDetail);

    if (err.response?.status === 404) {
      return res.json({
        totalDownloads: 0,
        totalUpdates: 0,
        appCount: 0,
        apps: [],
        topCountries: [],
        period: {},
        frequency: req.query.frequency || 'DAILY',
        message: 'No report data available for this date/period.',
      });
    }

    res.status(err.response?.status || 500).json({
      error: errorDetail,
    });
  }
});

// ── Sales Report Fetcher ─────────────────────────────────────
async function fetchSalesReport(vendorNumber, reportDate, frequency) {
  const params = {
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[frequency]': frequency,
    'filter[reportDate]': reportDate,
    'filter[vendorNumber]': vendorNumber,
  };

  const { data } = await axios.get(`${BASE_URL}/v1/salesReports`, {
    headers: appleHeaders('application/a-gzip'),
    params,
    responseType: 'arraybuffer',
  });

  const decompressed = zlib.gunzipSync(Buffer.from(data));
  const text = decompressed.toString('utf-8');

  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] || '').trim();
    });
    return obj;
  });
}

// ── Batch fetch with concurrency control ─────────────────────
async function batchFetch(vendorNumber, dates, frequency) {
  const allRows = [];
  const BATCH_SIZE = dates.length > 20 ? 3 : 5;
  const BATCH_DELAY = dates.length > 20 ? 300 : 0;

  for (let i = 0; i < dates.length; i += BATCH_SIZE) {
    const batch = dates.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((d) => fetchSalesReport(vendorNumber, d, frequency))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allRows.push(...r.value);
    }
    if (BATCH_DELAY && i + BATCH_SIZE < dates.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
  return allRows;
}

// ── Smart range fetcher (mixes yearly/monthly/daily) ─────────
async function fetchSmartRange(vendorNumber, fromStr, toStr, progressId) {
  const allRows = [];
  const fromDate = new Date(fromStr + (fromStr.length <= 7 ? '-01' : '') + 'T00:00:00');
  const toDate = new Date(toStr + (toStr.length <= 7 ? '-28' : '') + 'T00:00:00');
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400000);

  const fromYear = fromDate.getFullYear();
  const fromMonth = fromDate.getMonth() + 1;
  const toYear = toDate.getFullYear();
  const toMonth = toDate.getMonth() + 1;
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // 1) Full past years → YEARLY reports
  const yearlyDates = [];
  for (let y = fromYear; y <= Math.min(toYear, currentYear - 1); y++) {
    yearlyDates.push(String(y));
  }
  if (yearlyDates.length > 0) {
    console.log(`  Smart range: ${yearlyDates.length} yearly reports (${yearlyDates[0]}-${yearlyDates[yearlyDates.length-1]})`);
    if (progressId) updateProgress(progressId, 'downloading', `Fetching ${yearlyDates.length} yearly reports...`, 20);
    const rows = await batchFetch(vendorNumber, yearlyDates, 'YEARLY');
    allRows.push(...rows);
  }

  // 2) Partial years (months within range that aren't covered by yearly) → MONTHLY
  const monthlyDates = [];
  // If toYear == currentYear, we need monthly for completed months of current year
  if (toYear >= currentYear) {
    const startM = (fromYear === currentYear) ? fromMonth : 1;
    const endM = Math.min(toMonth, currentMonth - 1); // only completed months
    for (let m = startM; m <= endM; m++) {
      monthlyDates.push(`${currentYear}-${String(m).padStart(2, '0')}`);
    }
  }
  // Also handle case where from and to are same year and it's a past year (already covered by yearly)
  // But if the range doesn't cover the full year, we need monthly for that partial year
  if (fromYear === toYear && fromYear < currentYear) {
    // Already covered by yearly — yearly gives full year data, can't slice by month
    // This is a limitation: yearly report includes entire year
  }
  if (monthlyDates.length > 0) {
    console.log(`  Smart range: ${monthlyDates.length} monthly reports (${monthlyDates[0]} - ${monthlyDates[monthlyDates.length-1]})`);
    if (progressId) updateProgress(progressId, 'downloading', `Fetching ${monthlyDates.length} monthly reports...`, 45);
    const rows = await batchFetch(vendorNumber, monthlyDates, 'MONTHLY');
    allRows.push(...rows);
  }

  // 3) Current month days (if range includes current month) → DAILY
  if (toYear === currentYear && toMonth === currentMonth) {
    const monthStart = new Date(currentYear, currentMonth - 1, 1);
    const endDay = twoDaysAgo < toDate ? twoDaysAgo : toDate;
    if (endDay >= monthStart) {
      const dailyDates = [];
      let d = new Date(monthStart);
      while (d <= endDay) {
        dailyDates.push(d.toISOString().split('T')[0]);
        d.setDate(d.getDate() + 1);
      }
      if (dailyDates.length > 0) {
        console.log(`  Smart range: ${dailyDates.length} daily reports (current month)`);
        if (progressId) updateProgress(progressId, 'downloading', `Fetching ${dailyDates.length} daily reports (current month)...`, 70);
        const rows = await batchFetch(vendorNumber, dailyDates, 'DAILY');
        allRows.push(...rows);
      }
    }
  }

  return allRows;
}

// ── Aggregate rows into download stats ───────────────────────
function aggregateRows(allRows) {
  const downloadTypes = new Set(['1','1F','1T','F1','FI1','1E','1EP','1EU']);
  const updateTypes = new Set(['7','7F','7T','F7']);
  const redownloadTypes = new Set(['3','3F','3T','F3']);
  const iapTypes = new Set(['IA1','IA9','IAY','IA1-M','IAC','FI1']);

  const byApp = {};
  let totalDownloads = 0;
  let totalUpdates = 0;
  let totalRedownloads = 0;
  let totalIAP = 0;
  let totalProceeds = 0;

  for (const row of allRows) {
    const type = (row['Product Type Identifier'] || '').trim();
    const units = parseInt(row['Units'] || '0', 10);
    const title = (row['Title'] || 'Unknown').trim();
    const appleId = (row['Apple Identifier'] || '').trim();
    const sku = (row['SKU'] || '').trim();
    const country = (row['Country Code'] || '??').trim();
    const version = (row['Version'] || '').trim();
    const proceeds = parseFloat(row['Developer Proceeds'] || '0');
    const key = appleId || sku || title;

    if (!byApp[key]) {
      byApp[key] = { appleId, sku, title, downloads: 0, updates: 0, redownloads: 0, iap: 0, proceeds: 0, countries: {}, versions: {} };
    }

    if (downloadTypes.has(type)) {
      byApp[key].downloads += units;
      byApp[key].countries[country] = (byApp[key].countries[country] || 0) + units;
      totalDownloads += units;
      if (version) {
        byApp[key].versions[version] = (byApp[key].versions[version] || 0) + units;
      }
    } else if (updateTypes.has(type)) {
      byApp[key].updates += units;
      totalUpdates += units;
    } else if (redownloadTypes.has(type)) {
      byApp[key].redownloads += units;
      totalRedownloads += units;
    } else if (iapTypes.has(type)) {
      byApp[key].iap += units;
      totalIAP += units;
    }

    if (proceeds && !isNaN(proceeds)) {
      byApp[key].proceeds += proceeds * units;
      totalProceeds += proceeds * units;
    }
  }

  const apps = Object.values(byApp).sort((a, b) => b.downloads - a.downloads);

  // Convert versions to sorted arrays (top 10)
  for (const app of apps) {
    app.versions = Object.entries(app.versions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([version, installs]) => ({ version, installs }));
  }

  const globalCountries = {};
  for (const a of apps) {
    for (const [c, u] of Object.entries(a.countries)) {
      globalCountries[c] = (globalCountries[c] || 0) + u;
    }
  }
  const topCountries = Object.entries(globalCountries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([code, units]) => ({ code, units }));

  return { totalDownloads, totalUpdates, totalRedownloads, totalIAP, totalProceeds: Math.round(totalProceeds * 100) / 100, appCount: apps.length, apps, topCountries };
}

// ── Date range helper ────────────────────────────────────────
function buildDateList(from, to, frequency) {
  const dates = [];

  if (frequency === 'MONTHLY') {
    const [sy, sm] = from.split('-').map(Number);
    const [ey, em] = to.split('-').map(Number);
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      dates.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
      if (dates.length > 120) break;
    }
    return dates;
  }

  if (frequency === 'YEARLY') {
    const sy = parseInt(from.split('-')[0], 10);
    const ey = parseInt(to.split('-')[0], 10);
    for (let y = sy; y <= ey && dates.length < 20; y++) {
      dates.push(String(y));
    }
    return dates;
  }

  // DAILY or WEEKLY
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  const step = frequency === 'WEEKLY' ? 7 : 1;
  const maxCount = 365;
  let current = new Date(start);
  let count = 0;
  while (current <= end && count < maxCount) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + step);
    count++;
  }
  return dates;
}

// ══════════════════════════════════════════════════════════════
// ── GOOGLE PLAY ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

// Dynamic Google config — reloaded when config changes
let GOOGLE_DEVELOPER_ID = getConfig().google.developerId || process.env.GOOGLE_DEVELOPER_ID;
let GOOGLE_BUCKET_NAME = GOOGLE_DEVELOPER_ID
  ? `pubsite_prod_rev_${GOOGLE_DEVELOPER_ID}`
  : null;
let GOOGLE_PACKAGES = (getConfig().google.packages || process.env.GOOGLE_PACKAGES || '').split(',').map(p => p.trim()).filter(Boolean);

function getBucketName() {
  const devId = getConfig().google.developerId;
  return devId ? `pubsite_prod_rev_${devId}` : GOOGLE_BUCKET_NAME;
}

function reloadGoogleConfig() {
  const config = getConfig().google;
  GOOGLE_DEVELOPER_ID = config.developerId || process.env.GOOGLE_DEVELOPER_ID;
  GOOGLE_BUCKET_NAME = GOOGLE_DEVELOPER_ID ? `pubsite_prod_rev_${GOOGLE_DEVELOPER_ID}` : null;
  GOOGLE_PACKAGES = (config.packages || process.env.GOOGLE_PACKAGES || '').split(',').map(p => p.trim()).filter(Boolean);
  _googleAuth = null;
}

// ── Google Auth for googleapis ───────────────────────────────
let _googleAuth = null;
function getGoogleAuth(scopes) {
  const config = getConfig().google;
  const saFile = config.serviceAccountFile || process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (!saFile) return null;
  return new google.auth.GoogleAuth({
    keyFile: path.resolve(saFile),
    scopes: scopes || ['https://www.googleapis.com/auth/androidpublisher'],
  });
}

// ── Discover apps via Play Developer Reporting API ───────────
// This is the best source: finds all apps without needing package names.
async function discoverAppsViaReportingAPI() {
  const auth = getGoogleAuth(['https://www.googleapis.com/auth/playdeveloperreporting']);
  if (!auth) throw new Error('Google service account not configured');

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const { data } = await axios.get(
    'https://playdeveloperreporting.googleapis.com/v1beta1/apps:search',
    { headers: { Authorization: `Bearer ${token.token}` } }
  );

  if (!data.apps || data.apps.length === 0) {
    throw new Error('No apps found via Reporting API');
  }

  return data.apps.map(a => ({
    packageName: a.packageName,
    title: a.displayName || prettifyPackageName(a.packageName),
  }));
}

// ── Discover apps via Android Publisher API ──────────────────
// Since there's no "list all apps" endpoint, we try known packages
// or packages provided via config or GOOGLE_PACKAGES env var.

async function discoverAppsViaPublisher() {
  const auth = getGoogleAuth();
  if (!auth) throw new Error('Google service account not configured');

  const androidpublisher = google.androidpublisher({ version: 'v3', auth });
  const apps = [];
  const packages = GOOGLE_PACKAGES;

  for (const pkg of packages) {
    try {
      const edit = await androidpublisher.edits.insert({
        packageName: pkg,
        requestBody: {},
      });
      const editId = edit.data.id;

      // Get app details
      const details = await androidpublisher.edits.details.get({
        packageName: pkg,
        editId,
      });

      // Try to get actual app title from listings
      let title = prettifyPackageName(pkg);
      try {
        const lang = details.data.defaultLanguage || 'en-US';
        const listing = await androidpublisher.edits.listings.get({
          packageName: pkg,
          editId,
          language: lang,
        });
        if (listing.data.title) title = listing.data.title;
      } catch (listErr) {
        // Listing not available — use prettified name
      }

      await androidpublisher.edits.delete({ packageName: pkg, editId }).catch(() => {});

      apps.push({
        packageName: pkg,
        title,
        language: details.data.defaultLanguage || 'en-US',
        contactEmail: details.data.contactEmail || '',
      });
    } catch (e) {
      console.log(`  Publisher API: ${pkg} → ${e.message}`);
    }
  }

  return apps;
}

// ── API: Discover Google Play apps via Publisher API ──────────
app.get('/api/google/apps/publisher', async (req, res) => {
  try {
    if (GOOGLE_PACKAGES.length === 0) {
      return res.status(400).json({
        error: 'No packages configured. Add GOOGLE_PACKAGES=org.example.app1,org.example.app2 to .env',
      });
    }
    const apps = await discoverAppsViaPublisher();
    console.log(`Publisher API: Found ${apps.length}/${GOOGLE_PACKAGES.length} apps`);
    res.json({ apps, count: apps.length, source: 'publisher_api' });
  } catch (err) {
    console.error('Publisher apps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── gsutil helpers (uses gcloud auth from logged-in user) ─────
const os = require('os');

// Detect gsutil path at startup
let GSUTIL_PATH = 'gsutil';
(function detectGsutil() {
  const candidates = [
    'gsutil',
    '/opt/homebrew/share/google-cloud-sdk/bin/gsutil',
    '/usr/local/share/google-cloud-sdk/bin/gsutil',
    path.join(os.homedir(), 'google-cloud-sdk/bin/gsutil'),
    path.join(os.homedir(), 'Downloads/google-cloud-sdk/bin/gsutil'),
  ];
  for (const candidate of candidates) {
    try {
      require('child_process').execFileSync(candidate, ['version'], {
        timeout: 5000, stdio: 'pipe'
      });
      GSUTIL_PATH = candidate;
      console.log(`gsutil found: ${GSUTIL_PATH}`);
      return;
    } catch (_) {}
  }
  console.warn('WARNING: gsutil not found. Google Play GCS data will not be available.');
  console.warn('Install: brew install google-cloud-sdk && gcloud auth login');
})();

function gsutilExec(args, maxBuffer = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(GSUTIL_PATH, args, { maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr || err.message;
        if (msg.includes('ENOENT') || msg.includes('not found'))
          return reject(new Error('gsutil is not installed. Install: brew install google-cloud-sdk && gcloud auth login'));
        if (msg.includes('credentials') || msg.includes('authenticate') || msg.includes('login'))
          return reject(new Error('gsutil authentication failed. Run: gcloud auth login'));
        if (msg.includes('AccessDeniedException') || msg.includes('403'))
          return reject(new Error('Access denied to GCS bucket. Ensure your Google account has Play Console access.'));
        return reject(new Error(msg));
      }
      resolve(stdout);
    });
  });
}

// List files in GCS bucket with a prefix
async function gsutilLs(prefix) {
  const uri = `gs://${GOOGLE_BUCKET_NAME}/${prefix}`;
  try {
    const stdout = await gsutilExec(['ls', uri]);
    return stdout.trim().split('\n').filter(Boolean);
  } catch (e) {
    if (e.message.includes('matched no objects')) return [];
    throw e;
  }
}

// Parse a local Google Play CSV file (may be gzipped, UTF-16LE encoded)
function parseLocalCSV(filePath) {
  let buf = fs.readFileSync(filePath);

  // Check if gzipped (magic bytes 1f 8b)
  if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
    buf = zlib.gunzipSync(buf);
  }

  // Google Play CSVs are UTF-16LE encoded
  let text;
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    text = buf.toString('utf16le').substring(1); // skip BOM
  } else if (buf.length >= 2 && buf[1] === 0x00) {
    text = buf.toString('utf16le');
  } else {
    text = buf.toString('utf-8');
  }

  // Strip any remaining BOM
  text = text.replace(/^\uFEFF/, '').trim();
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ''; });
    return obj;
  });
}

// Bulk download GCS files matching a pattern using gsutil cp
async function gsutilBulkDownload(gcsPattern, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    // Note: avoid -m flag — it uses Python multiprocessing (fork) which crashes on macOS with Python 3.13
    execFile(GSUTIL_PATH, ['cp', gcsPattern, destDir],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;
          // "CommandException: No URLs matched" is expected when no data exists
          if (msg.includes('No URLs matched') || msg.includes('CommandException')) {
            // Not an error — just no files matched that pattern
          } else if (msg.includes('ENOENT') || msg.includes('not found')) {
            return reject(new Error('gsutil is not installed. Install: brew install google-cloud-sdk && gcloud auth login'));
          } else if (msg.includes('credentials') || msg.includes('authenticate') || msg.includes('login')) {
            return reject(new Error('gsutil authentication failed. Run: gcloud auth login'));
          } else if (msg.includes('AccessDeniedException') || msg.includes('403')) {
            return reject(new Error('Access denied to GCS bucket. Ensure your Google account has Play Console access.'));
          } else {
            return reject(new Error(msg));
          }
        }
        // Get list of downloaded files
        const files = fs.readdirSync(destDir)
          .filter(f => f.endsWith('.csv'))
          .map(f => path.join(destDir, f));
        resolve(files);
      }
    );
  });
}

// ── CSV Parser ───────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

async function downloadGCSCSV(localFilePath) {
  return parseLocalCSV(localFilePath);
}

// ── Prettify package name ────────────────────────────────────
function prettifyPackageName(pkg) {
  const parts = pkg.split('.');
  let name = parts[parts.length - 1];
  if (['app', 'android', 'main'].includes(name)) name = parts[parts.length - 2] || name;
  return name.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Aggregate Google Play install rows ───────────────────────
function aggregateGoogleRows(rows, titleMap = {}, versionRows = [], launchDates = {}) {
  const byApp = {};
  let totalDownloads = 0;
  let totalUpdates = 0;
  let totalUninstalls = 0;

  for (const row of rows) {
    const pkg = (row['Package Name'] || row['Package name'] || 'Unknown').trim();
    const country = (row['Country'] || '??').trim();
    const installs = parseInt(
      row['Daily Device Installs'] || row['Daily User Installs'] || row['Install events'] || '0',
      10
    );
    const updates = parseInt(
      row['Daily Device Upgrades'] || row['Update events'] || '0',
      10
    );
    const uninstalls = parseInt(
      row['Daily Device Uninstalls'] || row['Daily User Uninstalls'] || row['Uninstall events'] || '0',
      10
    );
    if (isNaN(installs)) continue;

    const key = pkg;
    if (!byApp[key]) {
      byApp[key] = {
        packageName: pkg,
        title: titleMap[pkg] || prettifyPackageName(pkg),
        downloads: 0,
        updates: 0,
        uninstalls: 0,
        countries: {},
        versions: {},
      };
      if (launchDates[pkg]) byApp[key].launchDate = launchDates[pkg];
    }

    byApp[key].downloads += installs;
    byApp[key].updates += updates;
    if (!isNaN(uninstalls)) {
      byApp[key].uninstalls += uninstalls;
      totalUninstalls += uninstalls;
    }
    if (country && country !== '??' && country !== 'Unknown') {
      byApp[key].countries[country] =
        (byApp[key].countries[country] || 0) + installs;
    }
    totalDownloads += installs;
    totalUpdates += updates;
  }

  // Aggregate version data
  for (const row of versionRows) {
    const pkg = (row['Package Name'] || row['Package name'] || 'Unknown').trim();
    const ver = (row['App Version Code'] || row['App version code'] || '').trim();
    if (!ver || !byApp[pkg]) continue;
    const installs = parseInt(
      row['Daily Device Installs'] || row['Daily User Installs'] || row['Install events'] || '0', 10
    );
    if (!isNaN(installs) && installs > 0) {
      byApp[pkg].versions[ver] = (byApp[pkg].versions[ver] || 0) + installs;
    }
  }

  // Convert versions to sorted arrays (top 10)
  const apps = Object.values(byApp).sort((a, b) => b.downloads - a.downloads);
  for (const app of apps) {
    app.versions = Object.entries(app.versions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, installs]) => ({ code, installs }));
  }

  const globalCountries = {};
  for (const a of apps) {
    for (const [c, u] of Object.entries(a.countries)) {
      globalCountries[c] = (globalCountries[c] || 0) + u;
    }
  }
  const topCountries = Object.entries(globalCountries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([code, units]) => ({ code, units }));

  return { totalDownloads, totalUpdates, totalUninstalls, appCount: apps.length, apps, topCountries };
}

// ── Detect launch dates (earliest data month) per app from GCS ──
let cachedLaunchDates = null;
let launchDatesCacheTime = 0;
async function detectLaunchDates() {
  // Cache for 1 hour
  if (cachedLaunchDates && Date.now() - launchDatesCacheTime < 3600000) {
    return cachedLaunchDates;
  }
  try {
    const allFiles = await gsutilLs('stats/installs/');
    const earliest = {};
    for (const file of allFiles) {
      const match = file.match(/installs_(.+?)_(\d{6})_country\.csv/);
      if (!match) continue;
      const pkg = match[1];
      const ym = match[2]; // e.g. "201912"
      if (!earliest[pkg] || ym < earliest[pkg]) earliest[pkg] = ym;
    }
    // Convert YYYYMM to readable date
    const result = {};
    for (const [pkg, ym] of Object.entries(earliest)) {
      const y = ym.substring(0, 4);
      const m = ym.substring(4, 6);
      result[pkg] = `${y}-${m}`;
    }
    cachedLaunchDates = result;
    launchDatesCacheTime = Date.now();
    return result;
  } catch (e) {
    console.log('Launch date detection failed:', e.message.substring(0, 60));
    return {};
  }
}

// ── Track latest available Google data date ──────────────────
let googleLatestDate = null;
let googleLatestDateTime = 0;

async function getGoogleLatestDate() {
  if (googleLatestDate && Date.now() - googleLatestDateTime < 3600000) {
    return googleLatestDate;
  }
  // Download one current-month CSV to find the max date
  const today = new Date();
  const ym = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gplay-latest-'));
  try {
    const pat = `gs://${GOOGLE_BUCKET_NAME}/stats/installs/installs_*_${ym}_country.csv`;
    await gsutilBulkDownload(pat, tmpDir);
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.csv'));
    if (files.length === 0) return googleLatestDate;
    const rows = parseLocalCSV(path.join(tmpDir, files[0]));
    let maxDate = '';
    for (const row of rows) {
      if (row['Date'] && row['Date'] > maxDate) maxDate = row['Date'];
    }
    if (maxDate) {
      googleLatestDate = maxDate;
      googleLatestDateTime = Date.now();
    }
    return googleLatestDate;
  } catch (e) {
    console.log('Latest date detection:', e.message.substring(0, 60));
    return googleLatestDate;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function updateLatestDate(rows) {
  for (const row of rows) {
    if (row['Date'] && (!googleLatestDate || row['Date'] > googleLatestDate)) {
      googleLatestDate = row['Date'];
      googleLatestDateTime = Date.now();
    }
  }
}

// ── Fetch & filter Google CSV files for a date range ─────────
async function fetchGoogleRange(fromDate, toDate, progressId) {
  const fromYM = fromDate.substring(0, 4) + fromDate.substring(5, 7);
  const toYM = toDate.substring(0, 4) + toDate.substring(5, 7);

  // Create temp dir for this download batch
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gplay-'));

  try {
    // Build list of GCS patterns to download (one per year-month)
    const countryPatterns = [];
    const versionPatterns = [];
    let ym = fromYM;
    while (ym <= toYM) {
      countryPatterns.push(`gs://${GOOGLE_BUCKET_NAME}/stats/installs/installs_*_${ym}_country.csv`);
      versionPatterns.push(`gs://${GOOGLE_BUCKET_NAME}/stats/installs/installs_*_${ym}_app_version.csv`);
      // Increment year-month
      let y = parseInt(ym.substring(0, 4));
      let m = parseInt(ym.substring(4, 6)) + 1;
      if (m > 12) { m = 1; y++; }
      ym = `${y}${String(m).padStart(2, '0')}`;
    }

    console.log(`  Downloading ${countryPatterns.length} month(s) of country + version CSVs...`);
    if (progressId) updateProgress(progressId, 'downloading', `Downloading ${countryPatterns.length} month(s) of CSV data from Google Cloud Storage...`, 10);

    // Bulk download all matching files
    const totalPatterns = countryPatterns.length + versionPatterns.length;
    let downloadedPatterns = 0;
    for (const pat of [...countryPatterns, ...versionPatterns]) {
      try {
        await gsutilBulkDownload(pat, tmpDir);
      } catch (e) {
        console.log(`  Warning: ${e.message.substring(0, 80)}`);
      }
      downloadedPatterns++;
      if (progressId) {
        const pct = 10 + Math.round((downloadedPatterns / totalPatterns) * 50);
        updateProgress(progressId, 'downloading', `Downloaded ${downloadedPatterns}/${totalPatterns} file groups...`, pct);
      }
    }

    const countryFiles = fs.readdirSync(tmpDir)
      .filter(f => /_country\.csv$/.test(f))
      .map(f => path.join(tmpDir, f));
    const versionFiles = fs.readdirSync(tmpDir)
      .filter(f => /_app_version\.csv$/.test(f))
      .map(f => path.join(tmpDir, f));

    console.log(`  Downloaded ${countryFiles.length} country + ${versionFiles.length} version CSV files for ${fromYM}-${toYM}`);

    if (progressId) updateProgress(progressId, 'parsing', `Parsing ${countryFiles.length} country CSV files...`, 65);

    // Parse country files
    const allRows = [];
    for (let fi = 0; fi < countryFiles.length; fi++) {
      const file = countryFiles[fi];
      try {
        const rows = parseLocalCSV(file);
        for (const row of rows) {
          const d = row['Date'];
          if (d >= fromDate && d <= toDate) allRows.push(row);
        }
      } catch (e) {
        console.log(`  Warning parsing ${path.basename(file)}: ${e.message.substring(0, 60)}`);
      }
      if (progressId && fi % 5 === 0) {
        const pct = 65 + Math.round((fi / countryFiles.length) * 15);
        updateProgress(progressId, 'parsing', `Parsed ${fi + 1}/${countryFiles.length} country files (${allRows.length} rows)...`, pct);
      }
    }

    if (progressId) updateProgress(progressId, 'parsing', `Parsing ${versionFiles.length} version CSV files...`, 82);

    // Parse version files
    const versionRows = [];
    for (const file of versionFiles) {
      try {
        const rows = parseLocalCSV(file);
        for (const row of rows) {
          const d = row['Date'];
          if (d >= fromDate && d <= toDate) versionRows.push(row);
        }
      } catch (e) {
        console.log(`  Warning parsing version ${path.basename(file)}: ${e.message.substring(0, 60)}`);
      }
    }
    // Update latest date cache from parsed data
    updateLatestDate(allRows);
    return { countryRows: allRows, versionRows };
  } finally {
    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── API: List Google Play Apps ───────────────────────────────
app.get('/api/google/apps', async (req, res) => {
  // Strategy: Reporting API (best) → GCS → Publisher API → error

  // 1. Try Reporting API first (fastest, finds all apps)
  try {
    const apps = await discoverAppsViaReportingAPI();
    console.log(`Google Play (Reporting API): Found ${apps.length} apps`);
    return res.json({ apps, count: apps.length, source: 'reporting_api' });
  } catch (reportErr) {
    console.log('Reporting API failed:', reportErr.message.substring(0, 80));
  }

  // 2. Try GCS bucket via gsutil
  let gcsError = null;
  try {
    if (GOOGLE_BUCKET_NAME) {
      const allFiles = await gsutilLs('stats/installs/');

      const packages = new Set();
      for (const file of allFiles) {
        const match = file.match(/installs_(.+?)_\d{6}_(overview|country)\.csv/);
        if (match) packages.add(match[1]);
      }

      if (packages.size > 0) {
        // Merge with Reporting API names map for better titles
        const titleMap = {};
        try {
          const reportApps = await discoverAppsViaReportingAPI();
          reportApps.forEach(a => { titleMap[a.packageName] = a.title; });
        } catch (_) {}

        const apps = [...packages].sort().map((pkg) => ({
          packageName: pkg,
          title: titleMap[pkg] || prettifyPackageName(pkg),
        }));

        console.log(`Google Play (GCS/gsutil): Found ${apps.length} apps`);
        return res.json({ apps, count: apps.length, source: 'gcs' });
      }
    }
  } catch (err) {
    gcsError = err;
    console.log('GCS/gsutil failed:', err.message.substring(0, 80));
  }

  // 3. Fallback: Publisher API with configured packages
  try {
    if (GOOGLE_PACKAGES.length > 0) {
      const apps = await discoverAppsViaPublisher();
      if (apps.length > 0) {
        console.log(`Google Play (Publisher API): Found ${apps.length} apps`);
        return res.json({ apps, count: apps.length, source: 'publisher_api' });
      }
    }
  } catch (pubErr) {
    console.log('Publisher API failed:', pubErr.message.substring(0, 80));
  }

  // All failed
  const err = gcsError || new Error('Google Play not configured.');
  console.error('Google apps error:', err.message);
  res.status(500).json({ error: 'Could not list Google Play apps. Check service account configuration.' });
});

// ── API: Google Play Downloads (single date or short range) ──
app.get('/api/google/downloads', async (req, res) => {
  try {
    if (!GOOGLE_BUCKET_NAME) {
      return res.status(400).json({ error: 'Google Play not configured.' });
    }

    const { date, from, to } = req.query;
    const progressId = req.query.progressId;

    let fromDate, toDate;
    if (date) {
      fromDate = toDate = date;
    } else if (from && to) {
      fromDate = from;
      toDate = to;
    } else {
      const d = new Date(Date.now() - 86400000);
      fromDate = toDate = d.toISOString().split('T')[0];
    }

    console.log(`Google downloads: ${fromDate} → ${toDate}`);
    if (progressId) updateProgress(progressId, 'starting', `Fetching Google Play data: ${fromDate} → ${toDate}`, 5);

    const { countryRows, versionRows } = await fetchGoogleRange(fromDate, toDate, progressId);
    console.log(`  Parsed ${countryRows.length} country rows, ${versionRows.length} version rows`);

    if (progressId) updateProgress(progressId, 'aggregating', 'Aggregating download data...', 90);

    // Get real app names + launch dates from Reporting API / GCS
    const titleMap = {};
    try {
      const reportApps = await discoverAppsViaReportingAPI();
      reportApps.forEach(a => { titleMap[a.packageName] = a.title; });
    } catch (_) {}
    const launchDates = await detectLaunchDates();

    const result = aggregateGoogleRows(countryRows, titleMap, versionRows, launchDates);
    if (progressId) clearProgress(progressId);
    res.json({
      ...result,
      period: { from: fromDate, to: toDate },
      frequency: 'DAILY',
      latestDataDate: googleLatestDate,
    });
  } catch (err) {
    if (progressId) clearProgress(progressId);
    console.error('Google downloads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Google Play All-Time Downloads ──────────────────────
app.get('/api/google/downloads/alltime', async (req, res) => {
  const progressId = req.query.progressId;
  try {
    if (!GOOGLE_BUCKET_NAME) {
      return res.status(400).json({ error: 'Google Play not configured.' });
    }

    console.log('Google all-time: bulk downloading all install reports via gsutil...');
    if (progressId) updateProgress(progressId, 'downloading', 'Downloading all-time install reports from Google Cloud Storage...', 5);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gplay-alltime-'));

    try {
      // Download ALL country + version CSVs in one batch
      if (progressId) updateProgress(progressId, 'downloading', 'Downloading country CSV files (this may take several minutes)...', 10);
      await gsutilBulkDownload(
        `gs://${GOOGLE_BUCKET_NAME}/stats/installs/installs_*_country.csv`,
        tmpDir
      );
      if (progressId) updateProgress(progressId, 'downloading', 'Downloading version CSV files...', 40);
      await gsutilBulkDownload(
        `gs://${GOOGLE_BUCKET_NAME}/stats/installs/installs_*_app_version.csv`,
        tmpDir
      ).catch(e => console.log('  Version CSVs warning:', e.message.substring(0, 60)));

      const countryFiles = fs.readdirSync(tmpDir)
        .filter(f => /_country\.csv$/.test(f))
        .sort();
      const versionFiles = fs.readdirSync(tmpDir)
        .filter(f => /_app_version\.csv$/.test(f))
        .sort();

      console.log(`  Downloaded ${countryFiles.length} country + ${versionFiles.length} version CSV files`);
      if (progressId) updateProgress(progressId, 'parsing', `Parsing ${countryFiles.length} country CSV files...`, 55);

      const allRows = [];
      for (let i = 0; i < countryFiles.length; i++) {
        try {
          const rows = parseLocalCSV(path.join(tmpDir, countryFiles[i]));
          allRows.push(...rows);
        } catch (e) {
          console.log(`  Warning parsing ${countryFiles[i]}: ${e.message.substring(0, 60)}`);
        }
        if (i > 0 && i % 100 === 0) {
          console.log(`  Parsed ${i}/${countryFiles.length} country files...`);
        }
        if (progressId && i % 20 === 0) {
          const pct = 55 + Math.round((i / countryFiles.length) * 20);
          updateProgress(progressId, 'parsing', `Parsed ${i + 1}/${countryFiles.length} country files (${allRows.length} rows)...`, pct);
        }
      }

      if (progressId) updateProgress(progressId, 'parsing', `Parsing ${versionFiles.length} version CSV files...`, 78);

      const versionRows = [];
      for (const file of versionFiles) {
        try {
          const rows = parseLocalCSV(path.join(tmpDir, file));
          versionRows.push(...rows);
        } catch (e) { /* skip */ }
      }

      console.log(`  Total: ${allRows.length} country rows, ${versionRows.length} version rows`);
      if (progressId) updateProgress(progressId, 'aggregating', 'Aggregating download data across all apps...', 88);

      // Get real app names + launch dates
      const titleMap = {};
      try {
        const reportApps = await discoverAppsViaReportingAPI();
        reportApps.forEach(a => { titleMap[a.packageName] = a.title; });
      } catch (_) {}
      const launchDates = await detectLaunchDates();

      updateLatestDate(allRows);
      const result = aggregateGoogleRows(allRows, titleMap, versionRows, launchDates);
      if (progressId) clearProgress(progressId);
      res.json({
        ...result,
        period: { from: 'All Time', to: 'Now' },
        frequency: 'ALL_TIME',
        latestDataDate: googleLatestDate,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (progressId) clearProgress(progressId);
    console.error('Google all-time error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Google Play Smart Range ─────────────────────────────
app.get('/api/google/downloads/range', async (req, res) => {
  const progressId = req.query.progressId;
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Both "from" and "to" are required.' });
    }

    if (!GOOGLE_BUCKET_NAME) {
      return res.status(400).json({ error: 'Google Play not configured.' });
    }

    console.log(`Google range: ${from} → ${to}`);
    if (progressId) updateProgress(progressId, 'starting', `Fetching Google Play data: ${from} → ${to}`, 5);

    const { countryRows, versionRows } = await fetchGoogleRange(from, to, progressId);
    console.log(`  Parsed ${countryRows.length} country rows, ${versionRows.length} version rows`);

    if (progressId) updateProgress(progressId, 'aggregating', 'Aggregating download data...', 90);

    // Get real app names + launch dates
    const titleMap = {};
    try {
      const reportApps = await discoverAppsViaReportingAPI();
      reportApps.forEach(a => { titleMap[a.packageName] = a.title; });
    } catch (_) {}
    const launchDates = await detectLaunchDates();

    const result = aggregateGoogleRows(countryRows, titleMap, versionRows, launchDates);
    if (progressId) clearProgress(progressId);
    res.json({
      ...result,
      period: { from, to },
      frequency: 'SMART',
      latestDataDate: googleLatestDate,
    });
  } catch (err) {
    if (progressId) clearProgress(progressId);
    console.error('Google range error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const configured = {
    apple: isAppleConfigured(),
    google: isGoogleConfigured(),
  };
  const gsutilAvailable = GSUTIL_PATH !== 'gsutil' || (() => {
    try { require('child_process').execFileSync('gsutil', ['version'], { timeout: 3000, stdio: 'pipe' }); return true; } catch (_) { return false; }
  })();
  const currentBucket = getBucketName();
  // Detect latest Google data date if not cached yet
  if (gsutilAvailable && currentBucket && !googleLatestDate) {
    await getGoogleLatestDate().catch(() => {});
  }
  res.json({ status: 'ok', configured, gsutilAvailable, googleLatestDate, needsSetup: !configured.apple && !configured.google });
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────┐');
  console.log('  │       App Analytics Dashboard         │');
  console.log(`  │   → http://localhost:${PORT}              │`);
  console.log('  └──────────────────────────────────────┘');
  console.log('');
});
