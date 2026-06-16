const express = require("express");
const axios = require("axios");
const https = require("https");
const fs    = require("fs");
const path = require("path");
const { createClient } = require("redis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const UMBRAL_MIN = 90;
const MAX_ALERTS = 200;
const CACHE_TTL = 5 * 60 * 1000;

// ─── Server configs ───────────────────────────────────────────────────────────
const SERVERS = {
  bosque: {
    label: "Bosque",
    url: process.env.BOSQUE_URL,
    user: process.env.BOSQUE_USER,
    pass: process.env.BOSQUE_PASS,
  },
  callecalle: {
    label: "Callecalle",
    url: process.env.CALLECALLE_URL,
    user: process.env.CALLECALLE_USER,
    pass: process.env.CALLECALLE_PASS,
  },
};

// ─── Per-server in-memory state ───────────────────────────────────────────────
const state = {};
for (const key of Object.keys(SERVERS)) {
  state[key] = {
    cachedToken: null,
    tokenExpiry: null,
    devicesCache: null,
    devicesCacheTime: null,
  };
}

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: { family: 4 },
});
redis.on("error", (err) => console.error("[Redis Error]", err.message));

function redisKey(server, type) {
  return `netwatch:${server}:${type}`;
}

async function loadFromRedis(key) {
  try {
    const r = await redis.get(key);
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}
async function saveToRedis(key, data) {
  try {
    await redis.set(key, JSON.stringify(data));
  } catch (e) {
    console.error(`[Redis] save ${key}:`, e.message);
  }
}

// ─── Cambio de marca config ───────────────────────────────────────────────────
const CM_PATH = path.join(__dirname, "config", "cambio-de-marca-bosque.json");
let CM_NAMES = new Set();
let CM_MACS  = new Set();
try {
  const cmData = JSON.parse(fs.readFileSync(CM_PATH, "utf8"));
  CM_NAMES = new Set((cmData.names || []).map(n => n.toLowerCase()));
  CM_MACS  = new Set((cmData.macs  || []).map(m => m.toLowerCase()));
  console.log(`[CambioMarca] ${CM_NAMES.size} dispositivos cargados desde JSON`);
} catch(e) {
  console.warn("[CambioMarca] No se pudo cargar config:", e.message);
}

// ─── MagicINFO helpers ────────────────────────────────────────────────────────
// In-memory excluded set (synced from Redis on start + mutations)
let excludedIds = new Set();

async function loadExcluded() {
  try {
    const raw = await redis.get("netwatch:bosque:excluded");
    excludedIds = new Set(raw ? JSON.parse(raw) : []);
  } catch { excludedIds = new Set(); }
}
async function saveExcluded() {
  try {
    await redis.set("netwatch:bosque:excluded", JSON.stringify([...excludedIds]));
  } catch(e) { console.error("[Excluded] save:", e.message); }
}

// ─── Cambio de marca set (manual additions via UI) ────────────────────────────
let brandChangeIds = new Set();

async function loadBrandChange() {
  try {
    const raw = await redis.get("netwatch:bosque:brand-change");
    brandChangeIds = new Set(raw ? JSON.parse(raw) : []);
  } catch { brandChangeIds = new Set(); }
}
async function saveBrandChange() {
  try {
    await redis.set("netwatch:bosque:brand-change", JSON.stringify([...brandChangeIds]));
  } catch(e) { console.error("[BrandChange] save:", e.message); }
}

// Detecta por nombre de grupo O por JSON config (auto)
function isBrandChangeByConfig(device) {
  const group = (device.groupName || device.group || "").toLowerCase().replace(/[\s]+/g, "_");
  if (group.includes("cambio_de_marca")) return true;
  const name = (device.deviceName || "").toLowerCase();
  const mac  = (device.macAddress  || "").toLowerCase();
  return CM_NAMES.has(name) || CM_MACS.has(mac);
}

// Detecta por config O por lista manual Redis
function isBrandChange(device) {
  if (isBrandChangeByConfig(device)) return true;
  const id = device.deviceId || device.macAddress;
  return brandChangeIds.has(id);
}

function shouldIgnoreDevice(device) {
  const group = (device.groupName || device.group || "").toLowerCase();
  return group.includes("no considerar");
}

function isManuallyExcluded(device) {
  const id = device.deviceId || device.macAddress;
  return excludedIds.has(id);
}

function isOnline(d) {
  return (
    d.power === true ||
    d.power === "true" ||
    d.panelStatus === true ||
    d.panelStatus === "true"
  );
}

async function getToken(serverKey) {
  const s = state[serverKey];
  const cfg = SERVERS[serverKey];
  if (s.cachedToken && s.tokenExpiry && Date.now() < s.tokenExpiry)
    return s.cachedToken;

  const response = await axios.post(
    `${cfg.url}/restapi/v2.0/auth`,
    { username: cfg.user, password: cfg.pass },
    { httpsAgent }
  );
  s.cachedToken = response.data.token;
  s.tokenExpiry = Date.now() + 25 * 60 * 1000;
  return s.cachedToken;
}

async function getAllDevices(serverKey, token) {
  const cfg = SERVERS[serverKey];
  const pageSize = 100;
  let page = 0;
  let allDevices = [];
  let totalCount = null;

  while (true) {
    const response = await axios.post(
      `${cfg.url}/restapi/v2.0/rms/devices/filter`,
      {
        page, pageSize,
        startIndex: page * pageSize + 1,
        keyword: "", searchText: "",
        connectionStatus: "device_status_view_all",
        sortColumn: "device_name", sortOrder: "asc",
        sorted: [{ id: "deviceName", desc: false }],
        alarmTypes: [], deviceType: [], functionTypes: [],
        inputSources: [], tagIds: [],
      },
      { headers: { api_key: token }, httpsAgent }
    );

    const data = response.data;
    if (totalCount === null)
      totalCount = data.totalCount || data.total || data.count || null;

    const items = data.items || data.list || data.deviceList || [];
    allDevices = allDevices.concat(items);

    if (totalCount !== null && allDevices.length >= totalCount) break;
    if (items.length < pageSize) break;
    if (items.length === 0) break;
    page++;
  }

  // Devolver todos los dispositivos etiquetados; el cliente controla visibilidad
  return allDevices.filter((d) => !isManuallyExcluded(d));
}

// ─── Change detection ─────────────────────────────────────────────────────────
async function detectChanges(serverKey, devices) {
  const now = Date.now();
  const timestamp = new Date(now).toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    dateStyle: "short",
    timeStyle: "short",
  });

  const prevStates =
    (await loadFromRedis(redisKey(serverKey, "states"))) || {};
  const alerts =
    (await loadFromRedis(redisKey(serverKey, "alerts"))) || [];
  let changed = false;

  devices.forEach((d) => {
    const id = d.deviceId || d.macAddress;
    const name = d.deviceName || id;
    const group = d.groupName || "Sin grupo";
    const online = isOnline(d);

    // Silenciar alertas para dispositivos excluidos (grupo, manual o cambio de marca)
    if (shouldIgnoreDevice(d) || isManuallyExcluded(d) || isBrandChange(d)) { prevStates[id] = online; return; }

    if (prevStates[id] !== undefined && prevStates[id] !== online) {
      alerts.unshift({
        id: now + "_" + id,
        type: online ? "recovery" : "offline",
        name,
        group,
        server: serverKey,
        msg: online
          ? "Volvió a conectarse"
          : `Desconectado (umbral: ${UMBRAL_MIN} min)`,
        time: timestamp,
        ts: now,
      });
      changed = true;
    }
    prevStates[id] = online;
  });

  while (alerts.length > MAX_ALERTS) alerts.pop();
  await saveToRedis(redisKey(serverKey, "states"), prevStates);
  if (changed) await saveToRedis(redisKey(serverKey, "alerts"), alerts);

  return alerts;
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function pollServer(serverKey) {
  const cfg = SERVERS[serverKey];
  if (!cfg.url) return;
  try {
    const token = await getToken(serverKey);
    const devices = await getAllDevices(serverKey, token);
    await detectChanges(serverKey, devices);
    state[serverKey].devicesCache = devices;
    state[serverKey].devicesCacheTime = Date.now();
    console.log(
      `[${new Date().toISOString()}] [${cfg.label}] Poll: ${devices.length} dispositivos`
    );
  } catch (e) {
    console.error(`[Poll ${cfg.label}] ${e.message}`);
  }
}

async function pollAll() {
  await Promise.allSettled(Object.keys(SERVERS).map(pollServer));
  await saveDailySnapshot();
}

// ─── Daily snapshots (histórico por fecha) ────────────────────────────────────
const SNAPSHOT_RETENTION_DAYS = 90;

async function saveDailySnapshot() {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" }); // YYYY-MM-DD
    const devices = [];
    for (const key of Object.keys(SERVERS)) {
      (state[key].devicesCache || []).forEach((d) => {
        devices.push({
          n:   d.deviceName || "",
          g:   d.groupName || "",
          s:   key,
          ip:  d.ipAddress || "",
          mac: d.macAddress || "",
          mo:  d.deviceModelName || "",
          on:  isOnline(d) ? 1 : 0,
          ex:  key === "bosque" && (shouldIgnoreDevice(d) || isManuallyExcluded(d) || isBrandChange(d)) ? 1 : 0,
        });
      });
    }
    if (devices.length === 0) return;

    await saveToRedis(`netwatch:snapshot:${today}`, {
      date: today,
      ts: Date.now(),
      devices,
    });

    let idx = (await loadFromRedis("netwatch:snapshots:index")) || [];
    if (!idx.includes(today)) { idx.push(today); idx.sort(); }
    while (idx.length > SNAPSHOT_RETENTION_DAYS) {
      const old = idx.shift();
      try { await redis.del(`netwatch:snapshot:${old}`); } catch {}
    }
    await saveToRedis("netwatch:snapshots:index", idx);
  } catch (e) {
    console.error("[Snapshot]", e.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await redis.connect();
  console.log("[Redis] Conectado");
  await loadExcluded();
  console.log(`[Excluded] ${excludedIds.size} pantallas excluidas cargadas`);
  await loadBrandChange();
  console.log(`[BrandChange] ${brandChangeIds.size} pantallas "Cambio de marca" manuales cargadas`);
  await pollAll();
  setInterval(pollAll, 5 * 60 * 1000);
}

start();

// ─── API ──────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// GET /api/devices?server=bosque|callecalle|both
app.get("/api/devices", async (req, res) => {
  const serverParam = req.query.server || "both";
  const servers =
    serverParam === "both"
      ? Object.keys(SERVERS)
      : [serverParam].filter((k) => SERVERS[k]);

  const results = {};
  await Promise.all(
    servers.map(async (key) => {
      const cfg = SERVERS[key];
      if (!cfg.url) { results[key] = { ok: false, error: "No configurado" }; return; }
      const s = state[key];
      try {
        const cached =
          s.devicesCache &&
          s.devicesCacheTime &&
          Date.now() - s.devicesCacheTime < CACHE_TTL;
        const devices = cached
          ? s.devicesCache
          : await getAllDevices(key, await getToken(key));
        if (!cached) {
          await detectChanges(key, devices);
          s.devicesCache = devices;
          s.devicesCacheTime = Date.now();
        }
        // Tag devices with exclusion flags; include all so frontend controls visibility
        const taggedDevices = devices.map(d => {
          const isBosque = key === "bosque";
          const byConf   = isBosque && isBrandChangeByConfig(d);
          const byManual = isBosque && brandChangeIds.has(d.deviceId || d.macAddress);
          return {
            ...d,
            _groupExcluded:       isBosque && shouldIgnoreDevice(d),
            _manualExcluded:      isBosque && isManuallyExcluded(d),
            _brandChange:         byConf || byManual,
            _brandChangeManual:   byManual && !byConf,   // puede quitarse vía UI
          };
        });
        results[key] = {
          ok: true,
          label: cfg.label,
          devices: taggedDevices,
          cached,
          cacheAge: s.devicesCacheTime
            ? Math.round((Date.now() - s.devicesCacheTime) / 1000)
            : 0,
        };
      } catch (error) {
        // Un servidor caído no debe tumbar al otro. Devolver caché viejo si existe.
        console.error(`[/api/devices ${cfg.label}] ${error.message}`);
        if (s.devicesCache) {
          results[key] = {
            ok: true,
            label: cfg.label,
            devices: s.devicesCache,
            cached: true,
            stale: true,
            cacheAge: s.devicesCacheTime
              ? Math.round((Date.now() - s.devicesCacheTime) / 1000)
              : null,
          };
        } else {
          results[key] = { ok: false, label: cfg.label, error: error.message };
        }
      }
    })
  );
  res.json({ ok: true, servers: results, umbralMin: UMBRAL_MIN });
});

// GET /api/alerts?server=bosque|callecalle|both
app.get("/api/alerts", async (req, res) => {
  const serverParam = req.query.server || "both";
  const servers =
    serverParam === "both"
      ? Object.keys(SERVERS)
      : [serverParam].filter((k) => SERVERS[k]);

  try {
    let allAlerts = [];
    for (const key of servers) {
      const a = (await loadFromRedis(redisKey(key, "alerts"))) || [];
      allAlerts = allAlerts.concat(a);
    }
    // Sort by ts desc
    allAlerts.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json({ ok: true, alerts: allAlerts.slice(0, MAX_ALERTS) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete("/api/alerts", async (req, res) => {
  const serverParam = req.query.server || "both";
  const servers =
    serverParam === "both"
      ? Object.keys(SERVERS)
      : [serverParam].filter((k) => SERVERS[k]);
  try {
    for (const key of servers)
      await saveToRedis(redisKey(key, "alerts"), []);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/status", async (req, res) => {
  const status = {};
  for (const [key, cfg] of Object.entries(SERVERS)) {
    const s = state[key];
    const alerts = (await loadFromRedis(redisKey(key, "alerts"))) || [];
    status[key] = {
      label: cfg.label,
      server: cfg.url,
      deviceCount: s.devicesCache?.length ?? null,
      alertCount: alerts.length,
      cacheAge: s.devicesCacheTime
        ? Math.round((Date.now() - s.devicesCacheTime) / 1000)
        : null,
    };
  }
  res.json({
    ok: true,
    servers: status,
    redis: redis.isOpen ? "conectado" : "desconectado",
    umbralMin: UMBRAL_MIN,
  });
});

// ─── Excluded devices API (Bosque only) ──────────────────────────────────────

// GET /api/excluded — list excluded device IDs
app.get("/api/excluded", async (req, res) => {
  res.json({ ok: true, excluded: [...excludedIds] });
});

// POST /api/excluded { deviceId } — add to excluded
app.post("/api/excluded", async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId requerido" });
  excludedIds.add(deviceId);
  await saveExcluded();
  res.json({ ok: true, excluded: [...excludedIds] });
});

// DELETE /api/excluded/:deviceId — remove from excluded
app.delete("/api/excluded/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  excludedIds.delete(deviceId);
  await saveExcluded();
  res.json({ ok: true, excluded: [...excludedIds] });
});

// ─── Cambio de marca API (Bosque only) ───────────────────────────────────────

// GET /api/brand-change — list brand-change device IDs (manual only)
app.get("/api/brand-change", async (req, res) => {
  res.json({ ok: true, brandChange: [...brandChangeIds] });
});

// POST /api/brand-change { deviceId } — add to brand-change
app.post("/api/brand-change", async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId requerido" });
  brandChangeIds.add(deviceId);
  await saveBrandChange();
  res.json({ ok: true, brandChange: [...brandChangeIds] });
});

// DELETE /api/brand-change/:deviceId — remove from brand-change
app.delete("/api/brand-change/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  brandChangeIds.delete(deviceId);
  await saveBrandChange();
  res.json({ ok: true, brandChange: [...brandChangeIds] });
});

// ─── Snapshots API (histórico por fecha) ──────────────────────────────────────

// GET /api/snapshots — fechas con snapshot disponible
app.get("/api/snapshots", async (req, res) => {
  const idx = (await loadFromRedis("netwatch:snapshots:index")) || [];
  res.json({ ok: true, dates: idx });
});

// GET /api/snapshots/:date — datos completos de esa fecha (YYYY-MM-DD)
app.get("/api/snapshots/:date", async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ ok: false, error: "Formato de fecha inválido (YYYY-MM-DD)" });
  const snap = await loadFromRedis(`netwatch:snapshot:${date}`);
  if (!snap)
    return res.status(404).json({ ok: false, error: "Sin datos para esa fecha" });
  res.json({ ok: true, snapshot: snap });
});

app.listen(PORT, () =>
  console.log(`NetWatch corriendo en puerto ${PORT}`)
);
