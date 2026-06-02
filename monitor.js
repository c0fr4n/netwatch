/**
 * NetWatch — Monitor unificado Bosque + Callecalle
 * Envía alertas a Google Chat cuando dispositivos cambian de estado.
 * Reporte diario a las 08:00 (L-V) por servidor.
 */

const axios = require("axios");
const https = require("https");
require("dotenv").config();

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const SERVERS = {
  bosque: {
    label: "Bosque",
    url: process.env.BOSQUE_URL,
    user: process.env.BOSQUE_USER,
    pass: process.env.BOSQUE_PASS,
    webhook: process.env.BOSQUE_WEBHOOK || process.env.GOOGLE_SPACES_WEBHOOK,
  },
  callecalle: {
    label: "Callecalle",
    url: process.env.CALLECALLE_URL,
    user: process.env.CALLECALLE_USER,
    pass: process.env.CALLECALLE_PASS,
    webhook: process.env.CALLECALLE_WEBHOOK || process.env.GOOGLE_SPACES_WEBHOOK,
  },
};

// Per-server state
const serverState = {};
for (const key of Object.keys(SERVERS)) {
  serverState[key] = {
    alertedDevices: new Set(),
    lastReportDate: null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shouldIgnoreDevice(device) {
  const group = (device.groupName || device.group || "").toLowerCase();
  return group.includes("no considerar");
}

function isOnline(d) {
  return (
    d.power === true || d.power === "true" ||
    d.panelStatus === true || d.panelStatus === "true"
  );
}

function getChileTime() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Santiago" })
  );
}

function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

// ─── MagicINFO API ────────────────────────────────────────────────────────────
const tokenCache = {};

async function getToken(key) {
  const cfg = SERVERS[key];
  if (tokenCache[key] && tokenCache[key].expiry > Date.now())
    return tokenCache[key].token;

  const res = await axios.post(
    `${cfg.url}/restapi/v2.0/auth`,
    { username: cfg.user, password: cfg.pass },
    { httpsAgent }
  );
  tokenCache[key] = { token: res.data.token, expiry: Date.now() + 25 * 60 * 1000 };
  return tokenCache[key].token;
}

async function getDevices(key, token) {
  const cfg = SERVERS[key];
  const pageSize = 100;
  let page = 0;
  let all = [];
  let totalCount = null;

  while (true) {
    const res = await axios.post(
      `${cfg.url}/restapi/v2.0/rms/devices/filter`,
      {
        page, pageSize, startIndex: page * pageSize + 1,
        keyword: "", searchText: "",
        connectionStatus: "device_status_view_all",
        sortColumn: "device_name", sortOrder: "asc",
        sorted: [{ id: "deviceName", desc: false }],
        alarmTypes: [], deviceType: [], functionTypes: [],
        inputSources: [], tagIds: [],
      },
      { headers: { api_key: token }, httpsAgent }
    );
    const data = res.data;
    if (totalCount === null)
      totalCount = data.totalCount || data.total || data.count || null;
    const items = data.items || data.list || data.deviceList || [];
    all = all.concat(items);
    if (totalCount !== null && all.length >= totalCount) break;
    if (items.length < pageSize) break;
    if (items.length === 0) break;
    page++;
  }

  return all.filter((d) => !shouldIgnoreDevice(d));
}

// ─── Alerts ───────────────────────────────────────────────────────────────────
async function sendWebhook(webhook, text) {
  await axios.post(webhook, { text }, { httpsAgent });
}

async function sendDailyReport(key, devices) {
  const cfg = SERVERS[key];
  const st = serverState[key];
  const chile = getChileTime();
  st.lastReportDate = chile.toDateString();

  const timestamp = chile.toLocaleString("es-CL", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const total = devices.length;
  const connected = devices.filter(isOnline).length;
  const disconnected = total - connected;
  const pct = total > 0 ? Math.round((connected / total) * 100) : 0;
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);

  const offlineDevices = devices.filter((d) => !isOnline(d));
  let offlineSection = "";
  if (offlineDevices.length > 0) {
    const list = offlineDevices
      .slice(0, 20)
      .map((d) => `  • ${d.deviceName || d.deviceId} — ${d.groupName || "Sin grupo"}`)
      .join("\n");
    const extra =
      offlineDevices.length > 20
        ? `\n  _...y ${offlineDevices.length - 20} más_`
        : "";
    offlineSection = `\n\n*Pantallas desconectadas:*\n${list}${extra}`;
  }

  const text =
    `📊 *Reporte Diario ${cfg.label} — ${timestamp}*\n\n` +
    `*Disponibilidad:* ${pct}%\n${bar}\n\n` +
    `🟢 Conectadas: *${connected}* de ${total}\n` +
    `🔴 Desconectadas: *${disconnected}* de ${total}` +
    offlineSection +
    `\n\n_Reporte automático 08:00 hrs — NetWatch Arcoprime._`;

  await sendWebhook(cfg.webhook, text);
  console.log(`[REPORTE ${cfg.label}] ${connected}/${total} (${pct}%)`);
}

async function sendOfflineAlert(key, problems) {
  const cfg = SERVERS[key];
  const timestamp = new Date().toLocaleString("es-CL", {
    timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short",
  });

  const chunks = [];
  for (let i = 0; i < problems.length; i += 20)
    chunks.push(problems.slice(i, i + 20));

  for (const chunk of chunks) {
    const lines = chunk.map((p) => {
      const issueList = p.issues.map((i) => `  • ${i}`).join("\n");
      return `*${p.name}*\n${issueList}`;
    });

    const text =
      `🚨 *Alerta ${cfg.label} — ${timestamp}*\n\n` +
      `Problemas en *${problems.length}* pantalla(s):\n\n` +
      lines.join("\n\n") +
      `\n\n_NetWatch — Monitor automático Arcoprime._`;

    await sendWebhook(cfg.webhook, text);
  }
  console.log(`[ALERTA ${cfg.label}] ${problems.length} dispositivos`);
}

async function sendRecoveryAlert(key, recovered) {
  const cfg = SERVERS[key];
  const timestamp = new Date().toLocaleString("es-CL", {
    timeZone: "America/Santiago", dateStyle: "short", timeStyle: "short",
  });
  const names = recovered.map((r) => `*${r.name}*`).join(", ");
  const text =
    `✅ *Recuperación ${cfg.label} — ${timestamp}*\n\n` +
    `Dispositivos reconectados:\n${names}`;
  await sendWebhook(cfg.webhook, text);
}

// ─── Monitor cycle ────────────────────────────────────────────────────────────
function evaluateDevice(device) {
  const issues = [];
  if (!isOnline(device)) issues.push("🔴 Pantalla offline");
  if (
    device.errorStatus &&
    device.errorStatus !== "NONE" &&
    device.errorStatus !== "0"
  )
    issues.push(`⚠️ Error: ${device.errorStatus}`);
  if (device.temperature && device.temperature > 70)
    issues.push(`🌡️ Temperatura alta: ${device.temperature}°C`);
  return issues;
}

async function runMonitorForServer(key) {
  const cfg = SERVERS[key];
  if (!cfg.url || !cfg.webhook) {
    console.log(`[${cfg.label}] Omitido — URL o webhook no configurados`);
    return;
  }

  const st = serverState[key];
  const chile = getChileTime();

  try {
    const token = await getToken(key);
    const devices = await getDevices(key, token);
    console.log(`[${cfg.label}] ${devices.length} dispositivos`);

    // Reporte diario L-V 08:00
    if (
      isWeekday(chile) &&
      chile.getHours() === 8 &&
      chile.getMinutes() <= 5 &&
      st.lastReportDate !== chile.toDateString()
    ) {
      await sendDailyReport(key, devices);
    }

    const problems = [];
    const currentlyHealthy = new Set();

    for (const device of devices) {
      const issues = evaluateDevice(device);
      const id = device.deviceId || device.id;
      if (issues.length > 0) {
        problems.push({
          deviceId: id,
          name: device.deviceName || id,
          issues,
        });
      } else {
        currentlyHealthy.add(id);
      }
    }

    const recovered = [];
    for (const deviceId of st.alertedDevices) {
      if (currentlyHealthy.has(deviceId)) {
        const device = devices.find((d) => (d.deviceId || d.id) === deviceId);
        if (device)
          recovered.push({ deviceId, name: device.deviceName || deviceId });
        st.alertedDevices.delete(deviceId);
      }
    }

    const newProblems = problems.filter((p) => !st.alertedDevices.has(p.deviceId));
    for (const p of problems) st.alertedDevices.add(p.deviceId);

    if (newProblems.length > 0) await sendOfflineAlert(key, newProblems);
    if (recovered.length > 0) await sendRecoveryAlert(key, recovered);

    if (newProblems.length === 0 && recovered.length === 0)
      console.log(`[${cfg.label}] Todo OK`);
  } catch (error) {
    console.error(`[ERROR ${cfg.label}] ${error.message}`);
    try {
      await sendWebhook(
        cfg.webhook,
        `🔥 *Monitor ${cfg.label} — Error interno*\n\n\`${error.message}\``
      );
    } catch (e) {
      console.error("No se pudo enviar alerta de error:", e.message);
    }
  }
}

async function runMonitor() {
  console.log(`[${new Date().toISOString()}] Ciclo de monitoreo...`);
  await Promise.allSettled(Object.keys(SERVERS).map(runMonitorForServer));
}

runMonitor();

if (process.env.MONITOR_INTERVAL) {
  const ms = parseInt(process.env.MONITOR_INTERVAL) * 1000;
  setInterval(runMonitor, ms);
  console.log(`Modo continuo: cada ${process.env.MONITOR_INTERVAL}s`);
}
