// index.js — ESM ✅ Solo BOTONES — Logo inicial, tono cálido, match aeropuertos tolerante
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

dotenv.config();
const app = express();
app.use(express.json({ limit: "15mb" }));

/* ====== ENV ====== */
const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.API_VERSION || "v23.0";
const VERIFY_TOKEN = String(process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = String(process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = String(process.env.PHONE_NUMBER_ID || "").trim();

const TAR_SHEET_ID = String(process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AER_HINT = String(process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MAR_HINT = String(process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TER_HINT = String(process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COU_HINT = String(process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();

const LOG_SHEET_ID = String(process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB = String(process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);
const LOGO_URL = String(
  process.env.LOGO_URL ||
    "https://www.conektarsa.com/wp-content/uploads/2022/06/cropped-Logo-1-2048x521.png"
).trim();

/* ====== Google OAuth ====== */
function credPath(file) {
  const p1 = path.join("/etc/secrets", file);
  try {
    fs.accessSync(p1);
    return p1;
  } catch {}
  return path.join(process.cwd(), "credentials", file);
}
const CLIENT_PATH = credPath("oauth_client.json");
const TOKEN_PATH = credPath("oauth_token.json");

function getOAuth() {
  const missing = [];
  try {
    fs.accessSync(CLIENT_PATH);
  } catch {
    missing.push("oauth_client.json");
  }
  try {
    fs.accessSync(TOKEN_PATH);
  } catch {
    missing.push("oauth_token.json");
  }
  if (missing.length) throw new Error("Faltan credenciales Google: " + missing.join(", "));
  const rawClient = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const installed = rawClient.installed || rawClient.web || rawClient;
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  const o = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris?.[0]
  );
  o.setCredentials(tokens);
  return o;
}
function sheetsClient() {
  return google.sheets({ version: "v4", auth: getOAuth() });
}

/* ====== Utils ====== */
const norm = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s()]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const toNum = (s) => {
  if (typeof s === "number") return s;
  const m = String(s || "").replace(/\./g, "").replace(/,/g, ".").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const fmt = (n) => (isFinite(n) ? Number(n).toFixed(2) : "0.00");
const chargeable = (kg, vol) => Math.max(Math.ceil(kg || 0), Math.ceil(vol || 0));

function headerIndex(header, ...names) {
  const H = header.map((h) => norm(h));
  const targets = names.map((x) => norm(x));
  return H.findIndex((h) => targets.some((t) => h === t || h.includes(t)));
}

/* ====== WhatsApp helpers ====== */
async function waSend(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "(no body)");
    console.error("WA error", res.status, t);
  }
  return res.ok;
}
const sendText = (to, body) =>
  waSend({ messaging_product: "whatsapp", to, type: "text", text: { body } });
const sendButtons = (to, text, buttons) =>
  waSend({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
    },
  });
const sendImage = (to, link, caption = "") =>
  waSend({ messaging_product: "whatsapp", to, type: "image", image: { link, caption } });

/* ====== Resolución robusta de pestañas ====== */
const tabCache = new Map(); // sheetId -> { normTitle: realTitle }
async function resolveTabTitle(sheetId, hint, extras = []) {
  const n = norm(hint);
  if (!tabCache.has(sheetId)) {
    const sheets = sheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "sheets(properties(title))",
    });
    const map = {};
    for (const s of meta.data.sheets || []) {
      const t = s.properties?.title || "";
      map[norm(t)] = t;
    }
    tabCache.set(sheetId, map);
  }
  const map = tabCache.get(sheetId);
  const entries = Object.entries(map);
  if (map[n]) return map[n];
  const tryList = [n, ...extras.map(norm)];
  for (const q of tryList) {
    const exact = entries.find(([k]) => k === q);
    if (exact) return exact[1];
    const starts = entries.find(([k]) => k.startsWith(q));
    if (starts) return starts[1];
    const incl = entries.find(([k]) => k.includes(q));
    if (incl) return incl[1];
  }
  if (n.startsWith("marit")) {
    const alt = entries.find(([k]) => k.startsWith("martim") || k.startsWith("marit"));
    if (alt) return alt[1];
  }
  throw new Error(`No pude encontrar la pestaña "${hint}".`);
}
async function readTabRange(sheetId, tabHint, a1Core, extras = []) {
  const title = await resolveTabTitle(sheetId, tabHint, extras);
  const range = `'${title}'!${a1Core}`; // SIEMPRE entre comillas
  const sheets = sheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return r.data.values || [];
}

/* ====== LOG en Sheets ====== */
async function logSolicitud(values) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: LOG_SHEET_ID,
    range: `${LOG_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

/* ====== COUNTRY → REGION (Courier) ====== */
const COUNTRY_TO_REGION = {
  // América Sur
  "argentina": "america sur",
  "brasil": "america sur",
  "chile": "america sur",
  "uruguay": "america sur",
  "paraguay": "america sur",
  "bolivia": "america sur",
  "peru": "america sur",
  "colombia": "america sur",
  "ecuador": "america sur",
  "venezuela": "america sur",
  // USA & Canadá
  "estados unidos": "usa & canadá",
  "usa": "usa & canadá",
  "eeuu": "usa & canadá",
  "united states": "usa & canadá",
  "canada": "usa & canadá",
  "canadá": "usa & canadá",
  // Europa
  "españa": "europa",
  "portugal": "europa",
  "francia": "europa",
  "alemania": "europa",
  "italia": "europa",
  "paises bajos": "europa",
  "reino unido": "europa",
  "uk": "europa",
  "holanda": "europa",
  "belgica": "europa",
  "suiza": "europa",
  "suecia": "europa",
  "noruega": "europa",
  "dinamarca": "europa",
  "irlanda": "europa",
  "polonia": "europa",
  "chequia": "europa",
  "austria": "europa",
  // Asia / ME
  "china": "asia",
  "hong kong": "asia",
  "india": "asia",
  "japon": "asia",
  "japón": "asia",
  "corea": "asia",
  "singapur": "asia",
  "singapore": "asia",
  "tailandia": "asia",
  "vietnam": "asia",
  "malasia": "asia",
  "indonesia": "asia",
  "emiratos arabes": "asia",
  "emiratos árabes": "asia",
  "arabia saudita": "asia",
  "qatar": "asia",
  "turquia": "asia",
  "turquía": "asia",
  "doha": "asia",
  "dubai": "asia",
};

/* ====== Sinónimos ciudades/IATA para Aéreo ====== */
const AIR_ALIASES = {
  "shanghai": "shanghai (pvg)|pvg|shanghai",
  "beijing": "beijing (pek)|pek|beijing|pekin|pekin|peking",
  "guangzhou": "guangzhou (can)|can|canton|guangzhou",
  "shenzhen": "shenzhen (szx)|szx|shenzhen",
  "hong kong": "hong kong (hkg)|hkg|hong kong",
  "tokyo": "tokyo (nrt)|nrt|tokyo|tokio",
  "osaka": "osaka (kix)|kix|osaka",
  "seoul": "seoul (icn)|icn|seul|seoul",
  "delhi": "delhi (del)|del|delhi|new delhi",
  "mumbai": "mumbai (bom)|bom|bombay|mumbai",
  "dubai": "dubai (dxb)|dxb|dubai",
  "doha": "doha (doh)|doh|doha",
  "singapore": "singapore (sin)|sin|singapur|singapore",
  "frankfurt": "frankfurt (fra)|fra|frankfurt",
  "paris": "paris (cdg)|cdg|paris",
  "amsterdam": "amsterdam (ams)|ams|amsterdam",
};
function buildAirMatchers() {
  const list = [];
  for (const [k, v] of Object.entries(AIR_ALIASES)) {
    const parts = v.split("|").map((x) => norm(x));
    list.push({ key: k, parts });
  }
  return list;
}
const AIR_MATCHERS = buildAirMatchers();

/* ====== COTIZADORES ====== */
async function cotizarAereo({ origen, kg, vol }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_AER_HINT, "A1:H10000", [
    "aereos",
    "aéreos",
    "aereo",
  ]);
  if (!rows.length) throw new Error("Aereos vacío");
  const header = rows[0];
  const data = rows.slice(1);

  const iOrigen = headerIndex(header, "origen");
  const iDest = headerIndex(header, "destino");
  const iPrecio = headerIndex(header, "precio medio", "precio usd medio", "precio");
  const iMinKg = headerIndex(header, "minimo en kg", "mínimo en kg");

  const want = norm(origen);
  const userTokens = [want];
  const alias = AIR_MATCHERS.find((a) => a.parts.some((p) => want.includes(p) || p.includes(want)));
  if (alias) userTokens.push(...alias.parts);

  const row = data.find((r) => {
    const cell = norm(r[iOrigen] || "");
    const dest = norm(r[iDest] || "");
    const okDest = dest.includes("eze");
    const okOri = userTokens.some((t) => t && cell.includes(t));
    return okDest && okOri;
  });
  if (!row) return null;

  const pricePerKg = toNum(row[iPrecio]);
  const minKg = toNum(row[iMinKg]) || AEREO_MIN_KG;
  const fact = Math.max(chargeable(kg, vol), 1);
  const applyMin = fact < minKg;
  const facturable = applyMin ? minKg : fact;

  return {
    pricePerKg,
    minKg,
    facturableKg: facturable,
    applyMin,
    totalUSD: pricePerKg * facturable,
    destino: "Buenos Aires (EZE)",
  };
}

async function cotizarMaritimo({ origen, modalidad }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_MAR_HINT, "A1:H10000", [
    "maritimos",
    "marítimos",
    "martimos",
    "mar",
  ]);
  if (!rows.length) throw new Error("Maritimos vacío");
  const header = rows[0];
  const data = rows.slice(1);

  const iOrigen = headerIndex(header, "origen");
  const iDest = headerIndex(header, "destino");
  const iMod = headerIndex(header, "modalidad");
  const iPrecio = headerIndex(header, "precio medio", "precio usd medio", "precio");

  const want = norm(origen);
  const row = data.find(
    (r) =>
      norm(r[iDest]).includes("buenos aires") &&
      norm(r[iMod]) === norm(modalidad) &&
      (norm(r[iOrigen]) === want || norm(r[iOrigen]).includes(want))
  );
  if (!row) return null;
  return { modalidad, totalUSD: toNum(row[iPrecio]), destino: "Puerto de Buenos Aires" };
}

async function cotizarTerrestre({ origen }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_TER_HINT, "A1:H10000", [
    "terrestres",
    "terrestre",
  ]);
  if (!rows.length) throw new Error("Terrestres vacío");
  const header = rows[0];
  const data = rows.slice(1);

  const iOrigen = headerIndex(header, "origen");
  const iDest = headerIndex(header, "destino");
  const iPrecio = headerIndex(header, "precio medio", "precio usd medio", "precio");

  const want = norm(origen);
  const row = data.find(
    (r) =>
      norm(r[iDest]).includes("buenos aires") &&
      (norm(r[iOrigen]) === want || norm(r[iOrigen]).includes(want))
  );
  if (!row) return null;
  return { totalUSD: toNum(row[iPrecio]), destino: "Buenos Aires" };
}

async function cotizarCourier({ pais, kg }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_COU_HINT, "A1:Z10000", ["courier"]);
  if (!rows.length) throw new Error("Courier vacío");
  const header = rows[0];
  const data = rows.slice(1);

  const iPeso = headerIndex(header, "peso", "peso (kg)");
  const iAS = headerIndex(header, "america sur");
  const iUS = headerIndex(header, "usa", "usa & canada", "usa & canadá");
  const iEU = headerIndex(header, "europa");
  const iASIA = headerIndex(header, "asia");

  const region = COUNTRY_TO_REGION[norm(pais)] || "europa";
  const col = region === "america sur" ? iAS : region === "usa & canadá" ? iUS : region === "asia" ? iASIA : iEU;

  const wanted = Number(kg);
  let exact = data.find((r) => toNum(r[iPeso]) === wanted);
  let usado = wanted;
  let ajustado = false;
  if (!exact) {
    let best = null;
    let bestDiff = Infinity;
    for (const r of data) {
      const p = toNum(r[iPeso]);
      const d = Math.abs(p - wanted);
      if (d < bestDiff) {
        best = r;
        bestDiff = d;
      }
    }
    exact = best;
    usado = toNum(best[iPeso]);
    ajustado = true;
  }

  return {
    region,
    escalonKg: usado,
    ajustado,
    totalUSD: toNum(exact[col]),
    destino: "Buenos Aires (EZE)",
  };
}

/* ====== UI (solo BOTONES) ====== */
async function sendHome(to) {
  await sendImage(to, LOGO_URL, "Conektar S.A. — Logística internacional");
  return sendButtons(to, "¡Bienvenido/a al *Cotizador de Fletes de Conektar S.A.*! 👋\nElegí cómo querés cotizar:", [
    { id: "menu_maritimo", title: "🚢 Marítimo" },
    { id: "menu_aereo", title: "✈️ Aéreo" },
    { id: "menu_terrestre", title: "🚛 Terrestre" },
  ]);
}

/* ====== WEBHOOK VERIFY ====== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ====== SESIONES ====== */
const sessions = new Map();
function getS(id) {
  if (!sessions.has(id)) sessions.set(id, { step: "start", data: {} });
  return sessions.get(id);
}

/* ====== WEBHOOK EVENTS ====== */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const s = getS(from);

    const type = msg.type;
    const bodyTxt = type === "text" ? (msg.text?.body || "").trim() : "";
    const lower = norm(bodyTxt);

    if (type === "text" && ["hola", "menu", "inicio", "volver", "start", "hi", "hola!"].includes(lower)) {
      sessions.delete(from);
      await sendHome(from);
      return res.sendStatus(200);
    }

    // ===== BOTONES =====
    if (type === "interactive") {
      const id = msg.interactive?.button_reply?.id;

      if (id === "menu_maritimo" || id === "menu_aereo" || id === "menu_terrestre") {
        s.data.tipo = id.replace("menu_", "");
        s.step = "empresa";
        await sendText(from, "🔹 *¿A nombre de qué empresa es la consulta?*");
        return res.sendStatus(200);
      }

      if (id === "mar_LCL" || id === "mar_FCL" || id === "mar_volver") {
        if (id === "mar_volver") {
          await sendHome(from);
          sessions.delete(from);
          return res.sendStatus(200);
        }
        s.data.modalidad = id === "mar_LCL" ? "LCL" : "FCL";
        if (s.data.modalidad === "FCL") {
          s.step = "mar_equipo";
          await sendButtons(from, "⚓ *Elegí equipo*", [
            { id: "mar_FCL20", title: "1×20’" },
            { id: "mar_FCL40", title: "1×40’" },
            { id: "mar_FCL40HC", title: "1×40’ HC" },
          ]);
        } else {
          s.step = "origen";
          await sendText(from, "📍 *Origen* (puerto de salida, ej.: *Shanghai*, *Ningbo*, *Shenzhen*).");
        }
        return res.sendStatus(200);
      }

      if (id === "aer_carga" || id === "aer_courier" || id === "aer_volver") {
        if (id === "aer_volver") {
          await sendHome(from);
          sessions.delete(from);
          return res.sendStatus(200);
        }
        s.data.subtipo = id === "aer_carga" ? "carga" : "courier";
        s.step = s.data.subtipo === "carga" ? "origen" : "pais";
        if (s.data.subtipo === "carga") {
          await sendText(
            from,
            "✈️ *Origen* (podés escribir *PVG*, *Shanghai*, *Tokio/Tokyo/NRT*, *Pekín/Beijing/PEK*, etc.)"
          );
        } else {
          await sendText(from, "🌍 *País de origen* (ej.: España, China, Estados Unidos).");
        }
        return res.sendStatus(200);
      }

      if (id === "mar_FCL20" || id === "mar_FCL40" || id === "mar_FCL40HC") {
        s.data.modalidad = id.replace("mar_", "");
        s.step = "origen";
        await sendText(from, "📍 *Origen* (puerto de salida, ej.: *Shanghai*, *Ningbo*, *Shenzhen*).");
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ===== TEXTO =====
    if (type === "text") {
      if (s.step === "start") {
        await sendHome(from);
        return res.sendStatus(200);
      }

      if (s.step === "empresa") {
        s.data.empresa = bodyTxt;

        if (s.data.tipo === "maritimo") {
          s.step = "maritimo_modalidad";
          await sendButtons(from, "🚢 *Marítimo seleccionado.* Elegí modalidad:", [
            { id: "mar_LCL", title: "LCL" },
            { id: "mar_FCL", title: "FCL" },
            { id: "mar_volver", title: "Volver" },
          ]);
          return res.sendStatus(200);
        }

        if (s.data.tipo === "aereo") {
          s.step = "aereo_subtipo";
          await sendButtons(from, "✈️ ¿Qué necesitás cotizar?", [
            { id: "aer_carga", title: "Carga general" },
            { id: "aer_courier", title: "Courier" },
            { id: "aer_volver", title: "Volver" },
          ]);
          return res.sendStatus(200);
        }

        if (s.data.tipo === "terrestre") {
          s.step = "origen";
          await sendText(from, "🚛 *Origen* (ciudad/país, ej.: *San Pablo – Brasil*, *Curitiba – Brasil*).");
          return res.sendStatus(200);
        }
      }

      if (s.step === "origen") {
        s.data.origen = bodyTxt;

        if (s.data.tipo === "aereo" && s.data.subtipo === "carga") {
          s.step = "peso";
          await sendText(from, "⚖️ *Peso (kg)* (entero).");
          return res.sendStatus(200);
        }

        if (s.data.tipo === "maritimo") {
          const r = await cotizarMaritimo({ origen: s.data.origen, modalidad: s.data.modalidad });
          if (!r) {
            await sendText(
              from,
              "❌ No encontré esa *ruta/modalidad* en tu planilla (Marítimos). Probá con el nombre tal cual figura."
            );
            return res.sendStatus(200);
          }
          const resp =
            "✅ *Tarifa estimada (Marítimo " +
            s.data.modalidad +
            ")*\n" +
            "USD " +
            fmt(r.totalUSD) +
            " *todo-in freight* + *Gastos Locales*.\n\n" +
            "*Validez:* " +
            VALIDEZ_DIAS +
            " días\n" +
            "*Nota:* No incluye impuestos ni gastos locales.\n\n" +
            "✨ *Tu consulta ha sido registrada correctamente.*\n" +
            "Nuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n" +
            "📧 comercial@conektarsa.com";
          await sendText(from, resp);
          await logSolicitud([
            new Date().toISOString(),
            from,
            "",
            s.data.empresa,
            "whatsapp",
            "maritimo",
            s.data.origen,
            r.destino,
            "",
            "",
            s.data.modalidad,
            r.totalUSD,
            `Marítimo ${s.data.modalidad} ${s.data.origen}→${r.destino}`,
          ]);
          sessions.delete(from);
          return res.sendStatus(200);
        }

        if (s.data.tipo === "terrestre") {
          const r = await cotizarTerrestre({ origen: s.data.origen });
          if (!r) {
            await sendText(
              from,
              "❌ No encontré esa ruta en *Terrestres*. Probá exactamente como figura en la planilla."
            );
            return res.sendStatus(200);
          }
          const resp =
            "✅ *Tarifa estimada (Terrestre)*\n" +
            "USD " +
            fmt(r.totalUSD) +
            " + *Gastos Locales*.\n\n" +
            "*Validez:* " +
            VALIDEZ_DIAS +
            " días\n" +
            "*Nota:* No incluye impuestos ni gastos locales.\n\n" +
            "✨ *Tu consulta ha sido registrada correctamente.*\n" +
            "Nuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n" +
            "📧 comercial@conektarsa.com";
          await sendText(from, resp);
          await logSolicitud([
            new Date().toISOString(),
            from,
            "",
            s.data.empresa,
            "whatsapp",
            "terrestre",
            s.data.origen,
            r.destino,
            "",
            "",
            "",
            r.totalUSD,
            `Terrestre ${s.data.origen}→${r.destino}`,
          ]);
          sessions.delete(from);
          return res.sendStatus(200);
        }
      }

      if (s.step === "peso") {
        const kg = Math.max(0, Math.round(toNum(bodyTxt)));
        s.data.kg = kg;
        s.step = "peso_vol";
        await sendText(from, "📦 *Peso volumétrico (kg)* (opcional, poné 0 si no sabés).");
        return res.sendStatus(200);
      }

      if (s.step === "peso_vol") {
        s.data.vol = Math.max(0, toNum(bodyTxt));
        const r = await cotizarAereo({
          origen: s.data.origen,
          kg: s.data.kg,
          vol: s.data.vol || 0,
        });
        if (!r) {
          await sendText(
            from,
            "❌ No encontré esa ruta en *Aéreos*. Probá con *ciudad* o *código IATA* (ej.: PVG, PEK, NRT)."
          );
          return res.sendStatus(200);
        }

        const unit = "USD " + fmt(r.pricePerKg) + " por KG (FOB)";
        const lineMin = r.applyMin ? "\n*Mínimo facturable:* " + r.minKg + " kg" : "";
        const total = "USD " + fmt(r.totalUSD);

        const resp =
          "✅ *Tarifa estimada (Aéreo – Carga general)*\n" +
          unit +
          " + *Gastos Locales*." +
          lineMin +
          "\n\n" +
          "*Kilos facturables:* " +
          r.facturableKg +
          "\n" +
          "*Total estimado:* " +
          total +
          "\n\n" +
          "*Validez:* " +
          VALIDEZ_DIAS +
          " días\n" +
          "*Nota:* No incluye impuestos ni gastos locales.\n\n" +
          "✨ *Tu consulta ha sido registrada correctamente.*\n" +
          "Nuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n" +
          "📧 comercial@conektarsa.com";
        await sendText(from, resp);
        await logSolicitud([
          new Date().toISOString(),
          from,
          "",
          s.data.empresa,
          "whatsapp",
          "aereo",
          s.data.origen,
          r.destino,
          s.data.kg,
          s.data.vol || "",
          "",
          r.totalUSD,
          `Aéreo ${s.data.origen}→${r.destino}; unit:${fmt(r.pricePerKg)}; fact:${r.facturableKg}kg; min:${r.minKg}`,
        ]);
        sessions.delete(from);
        return res.sendStatus(200);
      }

      if (s.step === "pais") {
        s.data.pais = bodyTxt;
        s.step = "peso_courier";
        await sendText(from, "⚖️ *Peso (kg)* (podés poner decimales: 1.5, 2, 2.5, etc.)");
        return res.sendStatus(200);
      }

      if (s.step === "peso_courier") {
        const kg = toNum(bodyTxt);
        s.data.kg = kg;
        const r = await cotizarCourier({ pais: s.data.pais, kg });
        if (!r) {
          await sendText(from, "❌ No pude calcular courier. Revisá la pestaña *Courier*.");
          return res.sendStatus(200);
        }
        const nota = r.ajustado
          ? "\n*Nota:* ajustado al escalón de " + r.escalonKg + " kg de la tabla."
          : "";
        const resp =
          "✅ *Tarifa estimada (Courier)*\n" +
          "*Peso:* " +
          fmt(s.data.kg) +
          " kg" +
          nota +
          "\n" +
          "*Total:* USD " +
          fmt(r.totalUSD) +
          " + *Gastos Locales*\n\n" +
          "*Validez:* " +
          VALIDEZ_DIAS +
          " días\n" +
          "*Nota:* No incluye impuestos ni gastos locales.\n\n" +
          "✨ *Tu consulta ha sido registrada correctamente.*\n" +
          "Nuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n" +
          "📧 comercial@conektarsa.com";
        await sendText(from, resp);
        await logSolicitud([
          new Date().toISOString(),
          from,
          "",
          s.data.empresa,
          "whatsapp",
          "courier",
          s.data.pais,
          r.destino,
          s.data.kg,
          "",
          "",
          r.totalUSD,
          `Courier ${s.data.pais}(${r.region})→${r.destino}; escalon:${r.escalonKg}`,
        ]);
        sessions.delete(from);
        return res.sendStatus(200);
      }

      await sendHome(from);
      return res.sendStatus(200);
    }

    await sendText(from, "Escribí *inicio* para comenzar.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("webhook error", e);
    return res.sendStatus(200);
  }
});

/* ====== Salud ====== */
app.get("/", (_req, res) => res.status(200).send("Conektar - Bot Cotizador de Fletes ✅"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`🚀 Bot en http://localhost:${PORT}`);
});
