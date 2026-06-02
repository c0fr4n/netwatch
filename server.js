const express = require("express");
const axios = require("axios");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { createClient } = require("redis");
require("dotenv").config();

// ─── Lista de exclusión Bosque ────────────────────────────────────────────────
const _noConsiderarRaw = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config", "no-considerar-bosque.json"), "utf8"));
  } catch { return { names: [], macs: [] }; }
})();
const NO_CONSIDERAR_BOSQUE = {
  names: new Set(_noConsiderarRaw.names.map(n => n.toLowerCase())),
  macs:  new Set(_noConsiderarRaw.macs.map(m => m.toLowerCase())),
};
console.log(`[Config] Bosque exclusiones: ${NO_CONSIDERAR_BOSQUE.names.size} dispositivos cargados`);

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

// ─── MagicINFO helpers ────────────────────────────────────────────────────────
function shouldIgnoreDevice(device, serverKey) {
  const group = (device.groupName || device.group || "").toLowerCase();
  if (group.includes("no considerar")) return true;

  if (serverKey === "bosque") {
    const name = (device.deviceName || "").toLowerCase();
    const mac  = (device.macAddress || "").toLowerCase();
    if (name && NO_CONSIDERAR_BOSQUE.names.has(name)) return true;
    if (mac  && NO_CONSIDERAR_BOSQUE.macs.has(mac))   return true;
  }

  return false;
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

  return allDevices.filter((d) => !shouldIgnoreDevice(d, serverKey));
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
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await redis.connect();
  console.log("[Redis] Conectado");
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

  try {
    const results = {};
    await Promise.all(
      servers.map(async (key) => {
        const cfg = SERVERS[key];
        if (!cfg.url) { results[key] = { ok: false, error: "No configurado" }; return; }
        const s = state[key];
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
        results[key] = {
          ok: true,
          label: cfg.label,
          devices,
          cached,
          cacheAge: s.devicesCacheTime
            ? Math.round((Date.now() - s.devicesCacheTime) / 1000)
            : 0,
        };
      })
    );
    res.json({ ok: true, servers: results, umbralMin: UMBRAL_MIN });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
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

app.listen(PORT, () =>
  console.log(`NetWatch corriendo en puerto ${PORT}`)
);
