# NetWatch — Monitor MagicINFO Arcoprime

Monitor unificado para los servidores MagicINFO **Bosque** y **Callecalle**.
Consolida dos repositorios anteriores en uno solo.

## Estructura

```
netwatch/
├── server.js          # Servidor web + API REST (Express)
├── monitor.js         # Script de alertas (Google Chat)
├── public/
│   └── index.html     # Dashboard (Bosque / Callecalle / Ambos)
├── package.json
├── .env.example
└── railway.json
```

## Variables de entorno

Copia `.env.example` a `.env` y completa:

| Variable | Descripción |
|---|---|
| `BOSQUE_URL` | URL base MagicINFO Bosque |
| `BOSQUE_USER` / `BOSQUE_PASS` | Credenciales Bosque |
| `BOSQUE_WEBHOOK` | Webhook Google Chat Bosque |
| `CALLECALLE_URL` | URL base MagicINFO Callecalle |
| `CALLECALLE_USER` / `CALLECALLE_PASS` | Credenciales Callecalle |
| `CALLECALLE_WEBHOOK` | Webhook Google Chat Callecalle |
| `REDIS_URL` | Redis para persistencia de alertas |
| `PORT` | Puerto del servidor (default: 3000) |
| `MONITOR_INTERVAL` | Segundos entre ciclos del monitor (solo `monitor.js`) |

> Si no defines `BOSQUE_WEBHOOK` / `CALLECALLE_WEBHOOK`, se usa `GOOGLE_SPACES_WEBHOOK` como fallback para ambos.

## Instalación local

```bash
npm install
cp .env.example .env
# editar .env
node server.js
```

## Deploy en Railway

1. Crea un nuevo proyecto en Railway
2. Agrega un servicio Redis
3. Conecta este repositorio
4. Define las variables de entorno
5. Deploy automático con `railway.json`

## API

| Endpoint | Descripción |
|---|---|
| `GET /api/devices?server=both\|bosque\|callecalle` | Lista de dispositivos |
| `GET /api/alerts?server=both\|bosque\|callecalle` | Historial de alertas |
| `DELETE /api/alerts?server=both\|bosque\|callecalle` | Limpiar alertas |
| `GET /api/status` | Estado de servidores y caché |

## Monitor de alertas

`monitor.js` se puede correr por separado (cron o standalone):

```bash
MONITOR_INTERVAL=300 node monitor.js
```

Envía alertas a Google Chat cuando:
- Una pantalla se desconecta (nuevo evento)
- Una pantalla se recupera
- Reporte diario L-V a las 08:00 (por servidor)
