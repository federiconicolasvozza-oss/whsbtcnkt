// index.js — Conektar S.A. • Bot Cotizaciones + Costeo Importe + Flete Local
// v4.0 — Flete Local ($ ARS), rating+EXW+Despachante+Email log, courier PF/Empresa, títulos árbol, formato CIF

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import Fuse from "fuse.js";

dotenv.config();
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== ENV ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = "v23.0";

/* Tarifa Sheets (cotizador + matriz) */
const TAR_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AEREOS = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aéreos").trim();
const TAB_MARITIMOS = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Marítimos").trim();
const TAB_TERRESTRES = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COURIER = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();
const TAB_CLASIFICACION = (process.env.GOOGLE_TARIFFS_TAB_CLASIFICACION || "Clasificación").trim();
const TAB_LOCAL = (process.env.GOOGLE_TARIFFS_TAB_FLETE_LOCAL || "Flete Local").trim();

const LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB      = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();
const TAB_USUARIOS = (process.env.GOOGLE_LOG_TAB_USUARIOS || "Usuarios").trim();
const TAB_CALCULOS = (process.env.GOOGLE_CALC_TAB || "calculos").trim();

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);

const LOGO_URL = (process.env.LOGO_URL ||
  "https://conektarsa.com/wp-content/uploads/2025/09/Conektarsa_logo_Whapp.jpg").trim();

/* Parámetros cálculo */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01);
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03);
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06);

let AIRPORT_CATALOG = [];
let SEAPORT_CATALOG = [];
let fuseAirports = null;
let fuseSeaports = null;

const FUSE_CONFIG = {
  includeScore: true,
  threshold: 0.45,
  ignoreLocation: true,
  minMatchCharLength: 2,
  distance: 120,
  keys: ["label", "tokens"]
};
const FUSE_AUTO_CONFIRM = 0.05;
const FUSE_SUGGEST_LIMIT = 0.22;
const FUSE_REJECT_LIMIT = 0.32;
const FUSE_MAX_RESULTS = 7;

/* ========= Google OAuth ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename);
  const fromRepo = path.join(process.cwd(), "credentials", filename);
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

function getOAuth() {
  const missing = [];
  try { fs.accessSync(CLIENT_PATH);} catch { missing.push("oauth_client.json"); }
  try { fs.accessSync(TOKEN_PATH);}  catch { missing.push("oauth_token.json"); }
  if (missing.length) throw new Error("Faltan credenciales Google: " + missing.join(", "));
  const raw = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const installed = raw.installed || raw.web || raw;
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  const o = new google.auth.OAuth2(installed.client_id, installed.client_secret, installed.redirect_uris?.[0]);
  o.setCredentials(tokens);
  return o;
}
const sheetsClient = () => google.sheets({ version: "v4", auth: getOAuth() });

/* ========= Utils ========= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const norm = s => (s||"").toString().toLowerCase()
  .normalize("NFD").replace(/\p{Diacritic}/gu,"")
  .replace(/[^\p{L}\p{N}\s()]/gu,"").replace(/\s+/g," ").trim();

// ✅ Parser robusto: coma/punto/miles
const toNum = (s) => {
  if (typeof s === "number") return s;
  if (!s) return NaN;

  let str = String(s).trim();
  const original = str;

  str = str.replace(/[^\d.,-]/g, "");

  if (!str || str === "-" || str === "." || str === ",") {
    return NaN;
  }

  if (!/\d/.test(original)) {
    return NaN;
  }

  const hasDot = str.includes(".");
  const hasComma = str.includes(",");

  if (hasDot && hasComma) {
    str = str.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    str = str.replace(",", ".");
  } else if (hasDot && !hasComma) {
    const last = str.lastIndexOf(".");
    str = str.replace(/\./g, "");
    if (last !== -1) str = str.slice(0,last) + "." + str.slice(last);
  }

  const n = Number(str);
  return isFinite(n) ? n : NaN;
};

const fmtUSD = n => isFinite(n)
  ? Number(n).toLocaleString("en-US",{minimumFractionDigits:2, maximumFractionDigits:2})
  : "0.00";

const fmtARS = n => isFinite(n)
  ? Number(n).toLocaleString("es-AR",{minimumFractionDigits:2, maximumFractionDigits:2})
  : "0,00";
// formato simple para números (ej: m³, kg)
const fmt = (n) => isFinite(n)
  ? Number(n).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  : "0";

const chargeable = (kg, volKg) => Math.max(Math.ceil(kg||0), Math.ceil(volKg||0));

function headerIndex(header, ...names) {
  const H = header.map(h => norm(h));
  const targets = names.map(x => norm(x));
  return H.findIndex(h => targets.some(t => h === t || h.includes(t)));
}
const clip20 = s => (s||"").toString().slice(0,20);
const clip24 = s => (s||"").toString().slice(0,24);

const FREE_MAILS = ["gmail.com","googlemail.com","yahoo.com","yahoo.com.ar","hotmail.com","hotmail.com.ar","outlook.com","outlook.com.ar","live.com","icloud.com","aol.com","msn.com"];
const isCorporateEmail = (mail) => {
  if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(mail||"")) return false;
  const dom = String(mail).trim().toLowerCase().split("@")[1];
  return dom && !FREE_MAILS.includes(dom);
};

/* ========= WhatsApp ========= */
async function sendMessage(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>"(no body)");
    console.error("❌ WA error", res.status, txt);
  }
  return res.ok;
}
const sendText = (to, body) =>
  sendMessage({ messaging_product:"whatsapp", to, type:"text", text:{ body } });

const sendButtons = (to, text, buttons) =>
  sendMessage({
    messaging_product:"whatsapp",
    to,
    type:"interactive",
    interactive:{
      type:"button",
      body:{ text },
      action:{ buttons: buttons.slice(0,3).map(b=>({ type:"reply", reply:{ id:b.id, title: clip20(b.title||"") } })) }
    }
  });

const sendList = (to, text, rows, sectionTitle="Opciones", btnTitle="Elegir") =>
  sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text },
      action: { button: clip20(btnTitle||"Elegir"), sections: [{ title: clip24(sectionTitle||"Opciones"), rows }] }
    }
  });

const sendImage = (to, link, caption="") =>
  sendMessage({ messaging_product:"whatsapp", to, type:"image", image:{ link, caption } });

async function sendTypingIndicator(to, durationMs = 3000) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        typing: "on"
      })
    });

    await sleep(Math.min(durationMs, 3000));

  } catch (e) {
    console.error("typing indicator error", e?.message || e);
  }
}

/* ---- Menús / rating / upsell ---- */
const WELCOME_TEXT =
  "⚡ *Asistente Logístico de Conektar*\n\n" +
  "Cotizo fletes internacionales en segundos:\n" +
  "✈️ Aéreo  •  🚢 Marítimo  •  🚚 Terrestre\n\n" +
  "También:\n" +
  "🧮 Costeo de importación (FOB → CIF)\n" +
  "🚚 Transporte local Argentina\n\n" +
  "⚠️ Cotizaciones orientativas, no reemplazan confirmación formal.\n\n" +
  "Escribí *menu* para volver al inicio.";

const sendMainActions = async (to) => {
  return sendButtons(to, "¿Qué te gustaría hacer hoy?", [
    { id:"action_cotizar",  title:"🌍 Cotiz. Flete Intl" },
    { id:"action_calcular", title:"🧮 Costeo Impo" },
    { id:"action_local",    title:"🚚 Flete Local" },
  ]);
};

const askReturnMenu = (to) =>
  sendButtons(to, "¿Volvemos al menú?", [
    { id:"menu_si", title:"🔁 Sí, volver" },
    { id:"menu_no", title:"❌ No" },
  ]);

const sendReview = (to) => {
  const rows = [
    { id:"rate_1", title:"⭐",        description:"Muy bajo" },
    { id:"rate_2", title:"⭐⭐",       description:"Bajo" },
    { id:"rate_3", title:"⭐⭐⭐",      description:"Ok" },
    { id:"rate_4", title:"⭐⭐⭐⭐",     description:"Muy bueno" },
    { id:"rate_5", title:"⭐⭐⭐⭐⭐",    description:"Excelente" },
  ];
  return sendList(to, "¿Cómo calificarías al bot del 1 al 5?", rows, "Calificación", "Elegir");
};

const sendModos = (to) =>
  sendButtons(to, "Elegí el modo de transporte:", [
    { id:"menu_maritimo",  title:"🚢 Marítimo" },
    { id:"menu_aereo",     title:"✈️ Aéreo" },
    { id:"menu_terrestre", title:"🚚 Terrestre" },
  ]);

const sendTiposMaritimo = (to) =>
  sendButtons(to, "Marítimo seleccionado. ¿Es LCL o FCL?", [
    { id:"mar_LCL", title:"LCL" },
    { id:"mar_FCL", title:"FCL" },
  ]);

const sendContenedores = (to) =>
  sendButtons(to, "Elegí el tipo de contenedor:", [
    { id:"mar_FCL20",  title:"20' ST" },
    { id:"mar_FCL40",  title:"40' ST" },
    { id:"mar_FCL40HC",title:"40' HC" },
  ]);

const upsellDespacho = (to) =>
  sendButtons(to, "🧑‍⚖️ ¿Sabías que también somos *despachantes de aduana*? ¿Querés que te coticemos el servicio?", [
    { id:"desp_si", title:"🙋 Sí" },
    { id:"desp_no", title:"No, gracias" }
  ]);

const endFlow = async (to) => {
  await askReturnMenu(to);
  await sendReview(to);
};

/* ========= Tabs ========= */
const tabCache = new Map();
async function resolveTabTitle(sheetId, tabName, tags = []) {
  const n = norm(tabName);
  if (!tabCache.has(sheetId)) {
    const meta = await sheetsClient().spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets(properties(title))" });
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
  const tryList = [n, ...tags.map(norm)];
  for (const q of tryList) {
    const exact = entries.find(([k])=>k===q); if (exact) return exact[1];
    const starts= entries.find(([k])=>k.startsWith(q)); if (starts) return starts[1];
    const incl  = entries.find(([k])=>k.includes(q));   if (incl) return incl[1];
  }
  if (n.startsWith("marit")) {
    const alt = entries.find(([k])=>k.startsWith("martim") || k.startsWith("marit"));
    if (alt) return alt[1];
  }
  throw new Error(`No pude encontrar la pestaña "${tabName}".`);
}
async function readTabRange(sheetId, tabName, range, tags = []) {
  const title = await resolveTabTitle(sheetId, tabName, tags);
  const rangeA1 = `'${title}'!${range}`;
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: sheetId, range: rangeA1 });
  return res.data.values || [];
}

/* ========= LOG ========= */
async function logSolicitud(values) {
  try {
    await sheetsClient().spreadsheets.values.append({
      spreadsheetId: LOG_SHEET_ID,
      range: `${LOG_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] }
    });
  } catch (e) {
    console.error("logSolicitud error", e?.message || e);
  }
}
async function logCalculo(values){
  try{
    await sheetsClient().spreadsheets.values.append({
      spreadsheetId: LOG_SHEET_ID,
      range: `${TAB_CALCULOS}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] }
    });
  }catch(e){ console.error("logCalculo error", e?.message || e); }
}
async function logRating(waId, empresa, valor){
  try{
    await sheetsClient().spreadsheets.values.append({
      spreadsheetId: LOG_SHEET_ID,
      range: `${LOG_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        new Date().toISOString(), waId, "", empresa, "whatsapp", "rating",
        "", "", "", "", "", valor, "rating del bot"
      ]] }
    });
  }catch(e){ console.error("logRating error", e?.message||e); }
}

/* ========= Courier regiones ========= */
const COUNTRY_TO_REGION = {
  "argentina":"america sur","brasil":"america sur","chile":"america sur","uruguay":"america sur","paraguay":"america sur","bolivia":"america sur","peru":"america sur","colombia":"america sur","ecuador":"america sur","venezuela":"america sur",
  "estados unidos":"usa & canadá","usa":"usa & canadá","eeuu":"usa & canadá","united states":"usa & canadá","canada":"usa & canadá","canadá":"usa & canadá",
  "españa":"europa","portugal":"europa","francia":"europa","alemania":"europa","italia":"europa","paises bajos":"europa","reino unido":"europa","uk":"europa","holanda":"europa","belgica":"europa","suiza":"europa","suecia":"europa","noruega":"europa","dinamarca":"europa","irlanda":"europa","polonia":"europa","chequia":"europa","austria":"europa",
  "china":"asia","hong kong":"asia","india":"asia","japon":"asia","japón":"asia","corea":"asia","singapur":"asia","tailandia":"asia","vietnam":"asia","malasia":"asia","indonesia":"asia","emiratos arabes":"asia","emiratos árabes":"asia","arabia saudita":"asia","qatar":"asia","turquia":"asia","turquía":"asia","doha":"asia","dubai":"asia"
};

/* ========= Aeropuertos alias ========= */
const AIR_ALIASES = {
  "shanghai":"shanghai (pvg)|pvg|shanghai",
  "beijing":"beijing (pek)|pek|beijing|pekin|peking",
  "guangzhou":"guangzhou (can)|can|canton|guangzhou",
  "shenzhen":"shenzhen (szx)|szx|shenzhen",
  "hong kong":"hong kong (hkg)|hkg|hong kong",
  "tokyo":"tokyo (nrt)|nrt|tokyo|tokio",
  "osaka":"osaka (kix)|kix|osaka",
  "seoul":"seoul (icn)|icn|seul|seoul",
  "delhi":"delhi (del)|del|delhi|new delhi",
  "mumbai":"mumbai (bom)|bom|bombay|mumbai",
  "dubai":"dubai (dxb)|dxb|dubai",
  "doha":"doha (doh)|doh|doha",
  "singapore":"singapore (sin)|sin|singapur|singapore",
  "frankfurt":"frankfurt (fra)|fra|frankfurt",
  "paris":"paris (cdg)|cdg|paris",
  "amsterdam":"amsterdam (ams)|ams|amsterdam"
};
const AIR_MATCHERS = Object.entries(AIR_ALIASES).map(([k,v]) => ({ key:k, parts:v.split("|").map(norm) }));

const AIR_ALIAS_MAP = Object.fromEntries(
  Object.entries(AIR_ALIASES).map(([k, v]) => [norm(k), v.split("|")])
);

const toTokens = (value) => {
  const tokens = new Set();
  const push = (x) => { const t = norm(x); if (t) tokens.add(t); };
  push(value);
  const clean = (value || "").toString().replace(/[()\[\]]/g, " ");
  clean.split(/[\/,;|-]/).forEach(push);
  clean.split(/\s+/).forEach(push);
  return Array.from(tokens).filter(Boolean);
};

async function loadTransportCatalogs() {
  if (!TAR_SHEET_ID) {
    AIRPORT_CATALOG = [];
    SEAPORT_CATALOG = [];
    fuseAirports = null;
    fuseSeaports = null;
    return;
  }

  try {
    const rows = await readTabRange(TAR_SHEET_ID, TAB_AEREOS, "A1:Z10000", ["aereos", "aéreos", "aereo"]);
    if (rows.length) {
      const header = rows[0];
      const data = rows.slice(1);
      const iOrigen = headerIndex(header, "origen");
      const seen = new Map();
      if (iOrigen !== -1) {
        for (const row of data) {
          const label = (row[iOrigen] || "").toString().trim();
          if (!label) continue;
          const extras = AIR_ALIAS_MAP[norm(label)] || [];
          const tokens = new Set(toTokens(label));
          for (const extra of extras) {
            for (const token of toTokens(extra)) tokens.add(token);
          }
          const entry = { label, norm: norm(label), tokens: Array.from(tokens).filter(Boolean) };
          if (!seen.has(entry.norm)) seen.set(entry.norm, entry);
        }
      }
      AIRPORT_CATALOG = Array.from(seen.values());
      fuseAirports = AIRPORT_CATALOG.length ? new Fuse(AIRPORT_CATALOG, FUSE_CONFIG) : null;
    }
  } catch (e) {
    console.error("loadTransportCatalogs (air)", e?.message || e);
    AIRPORT_CATALOG = [];
    fuseAirports = null;
  }

  try {
    console.log("DEBUG cotizarMaritimo - TAB_MARITIMOS:", TAB_MARITIMOS);
console.log("DEBUG cotizarMaritimo - Tipo de TAB_MARITIMOS:", typeof TAB_MARITIMOS);
    const rows = await readTabRange(TAR_SHEET_ID, TAB_MARITIMOS, "A1:Z10000", ["maritimos", "marítimos", "martimos", "mar"]);
    if (rows.length) {
      const header = rows[0];
      const data = rows.slice(1);
      const iOrigen = headerIndex(header, "origen");
      const seen = new Map();
      if (iOrigen !== -1) {
        for (const row of data) {
          const label = (row[iOrigen] || "").toString().trim();
          if (!label) continue;
          const entry = { label, norm: norm(label), tokens: toTokens(label) };
          if (!seen.has(entry.norm)) seen.set(entry.norm, entry);
        }
      }
      SEAPORT_CATALOG = Array.from(seen.values());
      fuseSeaports = SEAPORT_CATALOG.length ? new Fuse(SEAPORT_CATALOG, FUSE_CONFIG) : null;
    }
  } catch (e) {
    console.error("loadTransportCatalogs (sea)", e?.message || e);
    SEAPORT_CATALOG = [];
    fuseSeaports = null;
  }

  console.log(`📚 Catálogos cargados: ✈️ ${AIRPORT_CATALOG.length} aeropuertos, 🚢 ${SEAPORT_CATALOG.length} puertos.`);
}

// Guardar empresa del usuario
async function saveUserEmpresa(telefono, empresa) {
  try {
    const timestamp = new Date().toISOString().split("T")[0];
    await sheetsClient().spreadsheets.values.append({
      spreadsheetId: LOG_SHEET_ID,
      range: `${TAB_USUARIOS}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[telefono, empresa, timestamp]] }
    });
    console.log(`✅ Empresa guardada: ${telefono} → ${empresa}`);
  } catch (e) {
    console.error("saveUserEmpresa error", e?.message || e);
  }
}

// Recuperar empresa del usuario
async function getUserEmpresa(telefono) {
  try {
    const rows = await sheetsClient().spreadsheets.values.get({
      spreadsheetId: LOG_SHEET_ID,
      range: `${TAB_USUARIOS}!A:B`
    });
    const data = rows.data.values || [];
    const row = data.find(r => r[0] === telefono);
    return row ? row[1] : null;
  } catch (e) {
    console.error("getUserEmpresa error", e?.message || e);
    return null;
  }
}

async function resolveFuzzySelection(from, s, action, value) {
  const chosen = (value || "").toString().trim();
  if (!chosen) return;

  if (action === "mar_origen") {
    s.origen_puerto = chosen;
    await askResumen(from, s);
  } else if (action === "aer_origen") {
    s.origen_aeropuerto = chosen;

    // Verificar ruta ANTES de continuar
    const rutaExiste = await verificarRutaAerea(chosen);

    if (!rutaExiste) {
      await sendButtons(from,
        `❌ No encontré rutas disponibles desde *${chosen}*.\n¿Qué querés hacer?`,
        [
          { id:"retry_aer_origen", title:"🔄 Otro aeropuerto" },
          { id:"menu_si", title:"🏠 Menú" }
        ]
      );
      s.step = "waiting_retry";
      return;
    }

    s.step = "aer_peso";
    await sendText(from, "⚖️ *Peso (kg)* (entero).");
  } else if (action === "c_mar_origen") {
    s.origen_puerto = chosen;
    s.step = "c_confirm";
    await confirmCalc(from, s);
  }
}

async function fuzzySearchPlace({ from, s, query, kind, action }) {
  const input = (query || "").toString().trim();
  if (!input) {
    await sendText(from, "Ingresá un valor válido.");
    return true;
  }

  s._fuzzy = null;
  s._fuzzyPrevStep = null;

  const isAir = kind === "air";
  const catalog = isAir ? AIRPORT_CATALOG : SEAPORT_CATALOG;
  const fuse = isAir ? fuseAirports : fuseSeaports;
  const label = isAir ? "aeropuerto" : "puerto";

  // Sin catálogo → error crítico
  if (!catalog.length || !fuse) {
    await sendButtons(from,
      `⚠️ No tengo catálogo actualizado de ${label}s.\nContactá al equipo.`,
      [{ id: "menu_si", title: "🏠 Menú principal" }]
    );
    s.step = "main";
    return true;
  }

  const results = fuse.search(input, { limit: FUSE_MAX_RESULTS });

  // ❌ SIN RESULTADOS
  if (!results.length || results[0].score > 0.6) {
    await sendButtons(from,
      `❌ No encontré "${input}" en ${label}s.\n¿Reintentar con otro nombre?`,
      [
        { id: `fz_${kind}_retry`, title: "🔄 Sí, reintentar" },
        { id: "menu_si", title: "🏠 Menú" }
      ]
    );
    s._fuzzy = { kind, action };
    s._fuzzyPrevStep = s.step;
    s.step = "fuzzy_waiting";
    return true;
  }

  const best = results[0];
  const inputNorm = norm(input);

  // ✅ MATCH PERFECTO
  if (best && best.item) {
    const bestNorm = best.item.norm || norm(best.item.label);
    if (best.score <= FUSE_AUTO_CONFIRM || bestNorm === inputNorm) {
      await sendText(from, `✅ Usaremos *${best.item.label}*.`);
      await resolveFuzzySelection(from, s, action, best.item.label);
      return true;
    }
  }

  const closeMatches = results.filter(r => r.score <= FUSE_REJECT_LIMIT);

  // ⚠️ MATCH DUDOSO
  if (!closeMatches.length) {
    await sendButtons(from,
      `⚠️ No encontré coincidencias claras para "${input}".\n¿Reintentar?`,
      [
        { id: `fz_${kind}_retry`, title: "🔄 Sí" },
        { id: "menu_si", title: "🏠 Menú" }
      ]
    );
    s._fuzzy = { kind, action };
    s._fuzzyPrevStep = s.step;
    s.step = "fuzzy_waiting";
    return true;
  }

  // UNA SUGERENCIA
  const first = closeMatches[0];
  if (closeMatches.length === 1 && first.score <= FUSE_SUGGEST_LIMIT) {
    s._fuzzy = {
      kind, action, query: input,
      options: closeMatches.map(r => ({ label: r.item.label, score: r.score }))
    };
    s._fuzzyPrevStep = s.step;
    s.step = "fuzzy_confirm";
    await sendButtons(from, `¿Quisiste decir *${first.item.label}*?`, [
      { id: `fz_${kind}_0`, title: "✅ Sí" },
      { id: `fz_${kind}_retry`, title: "✏️ No, otro" }
    ]);
    return true;
  }

  // MÚLTIPLES OPCIONES
  const options = closeMatches.slice(0, FUSE_MAX_RESULTS).map((r, idx) => ({
    label: r.item.label, score: r.score, index: idx
  }));

  s._fuzzy = { kind, action, query: input, options };
  s._fuzzyPrevStep = s.step;
  s.step = "fuzzy_select";

  const rows = options.map((opt) => ({
    id: `fz_${kind}_${opt.index}`,
    title: clip24(opt.label),
    description: opt.label.length > 24 ? opt.label : undefined
  }));
  rows.push({
    id: `fz_${kind}_retry`,
    title: "✏️ Otro",
    description: "Escribir otro nombre"
  });

  await sendList(from, `Elegí el ${label}:`, rows, isAir ? "Aeropuertos" : "Puertos", "Elegir");
  return true;
}

/* ========= Cotizadores (tarifas) ========= */
async function cotizarAereo({ origen, kg, vol }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_AEREOS, "A1:Z10000", ["aereos","aéreos","aereo"]);
  if (!rows.length) throw new Error("Aereos vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");
  const iMinKg  = headerIndex(header,"minimo en kg","mínimo en kg");

  const want = norm(origen);
  const tokens = [want];
  const alias = AIR_MATCHERS.find(a => a.parts.some(p => want.includes(p) || p.includes(want)));
  if (alias) tokens.push(...alias.parts);

  const row = data.find(r => {
    const cell = norm(r[iOrigen]||"");
    const dest = norm(r[iDest]||"");
    return dest.includes("eze") && tokens.some(t => t && cell.includes(t));
  });
  if (!row) return null;

  const pricePerKg = toNum(row[iPrecio]);
  const minKg = toNum(row[iMinKg]) || AEREO_MIN_KG;
  const fact = Math.max(chargeable(kg, vol), 1);
  const applyMin = fact < minKg;
  const facturable = applyMin ? minKg : fact;

  return { pricePerKg, minKg, facturableKg: facturable, applyMin, totalUSD: pricePerKg * facturable, destino: "Ezeiza (EZE)" };
}

async function verificarRutaAerea(origen) {
  try {
    const rows = await readTabRange(TAR_SHEET_ID, TAB_AEREOS, "A1:Z10000", ["aereos","aéreos","aereo"]);
    if (!rows.length) return false;

    const header = rows[0], data = rows.slice(1);
    const iOrigen = headerIndex(header,"origen");
    const iDest   = headerIndex(header,"destino");

    const want = norm(origen);
    const tokens = [want];
    const alias = AIR_MATCHERS.find(a => a.parts.some(p => want.includes(p) || p.includes(want)));
    if (alias) tokens.push(...alias.parts);

    const row = data.find(r => {
      const cell = norm(r[iOrigen]||"");
      const dest = norm(r[iDest]||"");
      return dest.includes("eze") && tokens.some(t => t && cell.includes(t));
    });

    return !!row;
  } catch {
    return true; // fail-safe: permitir continuar si hay error
  }
}
async function cotizarMaritimo({ origen, modalidad, wm=null, m3=null }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_MARITIMOS, "A1:Z10000", ["maritimos","marítimos","martimos","mar"]);
  console.log("DEBUG Marítimos - TAB_MARITIMOS:");
  console.log("DEBUG Marítimos - Filas leídas:", rows ? rows.length : "null");
  console.log("DEBUG Marítimos - Primera fila (headers):", rows ? rows[0] : "sin datos");
  if (!rows) {
    console.error("DEBUG Marítimos - La pestaña está vacía o no existe");
    return null;
  }
  if (!rows.length) throw new Error("Maritimos vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iMod    = headerIndex(header,"modalidad");
  const iPrecioNormal = headerIndex(header,"precio medio","precio usd medio","precio","precio w/m","w/m");
  const iPrecioVoluminoso = headerIndex(header,"de 5 a 10 m3");
  const iTiempoTransito = headerIndex(header,"dias de transito","tiempo de transito");

  const want = norm(origen);
  const row = data.find(r => {
    const dest = norm(r[iDest]||"");
    const mod  = norm(r[iMod]||"").replace(/\s+/g,"");
    const wantMod = norm(modalidad).replace(/\s+/g,"");
    const org = norm(r[iOrigen]||"");
    return dest.includes("buenos aires") && mod===wantMod && (org.includes(want) || want.includes(org));
  });
  if (!row) return null;

  // Determinar si aplica tarifa voluminosa
  const esVoluminoso = (m3 && m3 >= 5 && m3 <= 10);
  const iPrecio = (esVoluminoso && iPrecioVoluminoso !== -1) ? iPrecioVoluminoso : iPrecioNormal;

  // DEBUG temporal
  console.log(`[DEBUG LCL] m3=${m3}, esVoluminoso=${esVoluminoso}, iPrecioVoluminoso=${iPrecioVoluminoso}, iPrecioNormal=${iPrecioNormal}, usando columna=${iPrecio}`);
  if (row && iPrecio !== -1) {
    console.log(`[DEBUG LCL] Valor en columna ${iPrecio}:`, row[iPrecio]);
  }

  const base = toNum(row[iPrecio]);
  const total = (wm && /lcl/i.test(modalidad)) ? (base * wm) : base;

  // Leer tiempo de tránsito
  const diasTransito = (iTiempoTransito !== -1 && row[iTiempoTransito])
    ? toNum(row[iTiempoTransito])
    : null;

  return {
    modalidad,
    totalUSD: total,
    destino: "Puerto de Buenos Aires",
    tarifaBase: base,
    wm,
    diasTransito,
    esVoluminoso
  };
}

async function cotizarTerrestre({ origen }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_TERRESTRES, "A1:Z10000", ["terrestres","terrestre"]);
  if (!rows.length) throw new Error("Terrestres vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");

  const want = norm(origen);
  const row = data.find(r => {
    const org = norm(r[iOrigen]||"");
    return norm(r[iDest]).includes("buenos aires") && (org.includes(want) || want.includes(org));
  });
  if (!row) return null;
  return { totalUSD: toNum(row[iPrecio]), destino: "Buenos Aires" };
}

async function cotizarCourier({ pais, kg }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_COURIER, "A1:Z10000", ["courier"]);
  if (!rows.length) throw new Error("Courier vacío");
  const header = rows[0], data = rows.slice(1);
  const iPeso = headerIndex(header,"peso","peso (kg)");
  const iAS   = headerIndex(header,"america sur");
  const iUS   = headerIndex(header,"usa","usa & canada","usa & canadá");
  const iEU   = headerIndex(header,"europa");
  const iASIA = headerIndex(header,"asia");

  const region = COUNTRY_TO_REGION[norm(pais)] || "europa";
  const col = region === "america sur" ? iAS : region === "usa & canadá" ? iUS : region === "asia" ? iASIA : iEU;

  const wanted = Number(kg);
  let exact = data.find(r => toNum(r[iPeso]) === wanted);
  let usado = wanted, ajustado = false;
  if (!exact) {
    let best=null, bestDiff=Infinity;
    for (const r of data) { const p=toNum(r[iPeso]); const d=Math.abs(p-wanted); if (d<bestDiff){best=r;bestDiff=d;} }
    exact = best; usado = toNum(best[iPeso]); ajustado = true;
  }
  return { region, escalonKg: usado, ajustado, totalUSD: toNum(exact[col]), destino: "Ezeiza (EZE)" };
}

async function analizarConveniencia(s) {
  const sugerencias = [];

  if (s.maritimo_tipo === "LCL") {
    const wm = Math.max(Number(s.lcl_tn) || 0, Number(s.lcl_m3) || 0);
    if (wm > 20) {
      sugerencias.push(
        `💡 Con ${wm.toFixed(1)} W/M, te conviene un contenedor 40' completo (hasta 67m³). Puede ser más económico y tenés espacio exclusivo.`
      );
    } else if (wm > 10) {
      sugerencias.push(
        `💡 Tu carga ocupa ${wm.toFixed(1)} W/M. Un contenedor 20' completo puede costarte similar y te da hasta 33m³ exclusivos.`
      );
    }
  }

  if (s.maritimo_tipo === "LCL" && (Number(s.lcl_tn) || 0) > 15) {
    sugerencias.push(
      `⚠️ ${Number(s.lcl_tn)} toneladas supera el límite usual de LCL (15t). Te conviene FCL para evitar restricciones de manipulación.`
    );
  }

  if (s.modo === "aereo" && s.aereo_tipo === "carga_general") {
    const kg = Number(s.peso_kg) || 0;
    if (kg > 2000) {
      sugerencias.push(
        `💡 ${kg} kg por aéreo puede ser muy costoso. Marítimo puede ahorrarte 60-70% del costo (con 30-35 días más de tránsito).`
      );
    } else if (kg > 1000) {
      sugerencias.push(
        `💡 Con ${kg} kg, marítimo puede ser significativamente más económico. Si no es urgente, puede valerte la pena.`
      );
    } else if (kg > 500) {
      sugerencias.push(
        `💡 ${kg} kg está en el límite. Si tu envío no es urgente, marítimo puede ahorrarte 40-50% del costo.`
      );
    }
  }

  if (s.modo === "aereo" && s.aereo_tipo === "carga_general") {
    const pesoReal = Number(s.peso_kg) || 0;
    const pesoVol = ((Number(s.vol_cbm) || 0) * 167);
    if (pesoReal > 0 && pesoVol / pesoReal > 2.5) {
      sugerencias.push(
        `⚠️ Tu carga es liviana pero muy voluminosa. Aéreo cobra ${pesoVol.toFixed(0)} kg volumétricos vs ${pesoReal} kg reales. Marítimo puede ser mucho más económico.`
      );
    }
  }

  if (s.modo === "aereo" && s.aereo_tipo === "courier" && (Number(s.peso_kg) || 0) > 30) {
    sugerencias.push(
      `💡 Para más de 30 kg, carga aérea general suele ser 40-50% más económica que courier. ¿Querés que te cotice aéreo normal?`
    );
  }

  return sugerencias.slice(0, 2);
}

/* ========= Estado ========= */
const sessions = new Map();
const emptyState = () => ({
  empresa:null, welcomed:false, askedEmpresa:false, step:"start",
  // cotizador
  modo:null, maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_pf:null,
  terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  // LCL extras
  lcl_tn:null, lcl_m3:null, lcl_apilable:null,
  // calculadora
  flow:null, producto_desc:null, categoria:null, matriz:null,
  fob_unit:null, cantidad:null, fob_total:null,
  calc_modo:null, calc_maritimo_tipo:null, calc_contenedor:null,
  // árbol
  sel_n1:null, sel_n2:null, sel_n3:null,
  _tree:null, _find:null, _matches:null,
  _fuzzy:null, _fuzzyPrevStep:null,
  // email
  email:null,
  // flete local
  local_cap:null, local_tipo:null, local_dist:null,
});
function getS(id){
  if(!sessions.has(id)) {
    sessions.set(id, { data: { ...emptyState() } });
    // Cargar empresa guardada
    getUserEmpresa(id).then(empresa => {
      if (empresa) {
        const s = sessions.get(id);
        if (s) s.data.empresa = empresa;
      }
    });
  }
  return sessions.get(id);
}

/* ========= Matriz (Clasificación dentro del mismo Sheet) ========= */
async function readMatrix() {
  if (!TAR_SHEET_ID) return [];
  const rows = await readTabRange(TAR_SHEET_ID, TAB_CLASIFICACION, "A1:Z10000", ["clasificacion","clasificación"]);
  if (!rows.length) return [];
  const header = rows[0].map(h => (h||"").toString().trim());
  const find = (...lbl) => header.findIndex(h => lbl.map(x=>x.toLowerCase()).some(t => h.toLowerCase()===t || h.toLowerCase().includes(t)));

  const idx = {
    NIV1: find("NIVEL_1","NIVEL 1"),
    NIV2: find("NIVEL_2","NIVEL 2"),
    NIV3: find("NIVEL_3","NIVEL 3"),
    SUB : find("SUBCATEGORIA","SUBCATEGORÍA","PRODUCTO","SUBCATEGORIA/PRODUCTO"),
    TASA: find("Tasa Estadisti","Tasa Estadistica","Tasa Estadística"),
    IVA : find("% IVA","IVA","IVA %"),
    IVA_A:find("% IVA ADIC","IVA ADICIONAL","IVA ADIC"),
    DI  : find("DERECHOS IM","% DERECHOS","DERECHOS"),
    IIBB: find("% IIBB","IIBB"),
    IIGG: find("% IIGG","IIGG"),
    INT : find("IMPUESTOS INTE","IMPUESTOS INT","INTERNOS"),
    NOTA: find("NOTAS","OBS","NOTAS / IMPUESTOS_IMPO","IMPUESTOS_IMPO")
  };

  const data = rows.slice(1).map(r => ({
    NIV1: r[idx.NIV1] || "",
    NIV2: r[idx.NIV2] || "",
    NIV3: r[idx.NIV3] || "",
    SUB : r[idx.SUB]  || "",
    tasa_est: isFinite(toNum(r[idx.TASA])) ? toNum(r[idx.TASA])/100 : TASA_ESTATISTICA,
    iva     : isFinite(toNum(r[idx.IVA])) ? toNum(r[idx.IVA])/100 : 0.21,
    iva_ad  : isFinite(toNum(r[idx.IVA_A])) ? toNum(r[idx.IVA_A])/100 : 0.00,
    di      : isFinite(toNum(r[idx.DI])) ? toNum(r[idx.DI])/100 : 0.00,
    iibb    : isFinite(toNum(r[idx.IIBB])) ? toNum(r[idx.IIBB])/100 : 0.035,
    iigg    : isFinite(toNum(r[idx.IIGG])) ? toNum(r[idx.IIGG])/100 : RATE_IIGG,
    internos: isFinite(toNum(r[idx.INT])) ? toNum(r[idx.INT])/100 : 0.00,
    nota    : (r[idx.NOTA] || "").toString()
  })).filter(x => (x.NIV1||x.NIV2||x.NIV3||x.SUB));

  return data;
}
let MATRIX_CACHE=null;
async function getMatrix(){ if (MATRIX_CACHE) return MATRIX_CACHE; MATRIX_CACHE = await readMatrix(); return MATRIX_CACHE||[]; }

function indexMatrix(M){
  return M.map(r=>({
    niv1: (r.NIV1||"").toString(),
    niv2: (r.NIV2||"").toString(),
    niv3: (r.NIV3||"").toString(),
    sub : (r.SUB ||"").toString(),
    iva:r.iva, iva_ad:r.iva_ad, di:r.di, iibb:r.iibb, iigg:r.iigg, internos:r.internos, nota:r.nota, tasa_est:r.tasa_est
  }));
}
function distinct(arr, keyFn){
  const s = new Set(); const out=[];
  for(const x of arr){ const k=keyFn(x); if(k && !s.has(k)){ s.add(k); out.push(k); } }
  return out;
}

/* ========= UI calculadora ========= */
const askProdMetodo = (to) => sendButtons(to,
  "Sobre tu producto, ¿preferís *Descripción*, *Categoría* o ver *Populares*?",
  [{ id:"calc_desc", title:"📝 Descrip." },{ id:"calc_cat",  title:"📂 Categoría" },{ id:"calc_pop",  title:"⭐ Populares" }]
);
const populares = ["🧱 Materiales","🪛 Ferreteria","🧬Biotecnolgía","🚙 Vehículos","🖥️ Componentes PC","🧪Químicos"];
const listFrom = (arr, pref) => arr.slice(0,10).map((t,i)=>({
  id:`${pref}_${i}`,
  title: clip24(t)
}));

/* ========= VERIFY ========= */
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ========= WEBHOOK ========= */
app.post("/webhook", async (req,res)=>{
  try{
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from  = msg.from;
    const { data: s } = await getS(from);
    const type  = msg.type;
    const text  = (type==="text") ? (msg.text?.body || "").trim() : "";
    const lower = norm(text);
    const btnId = (type==="interactive") ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "") : "";

    // Bienvenida ÚNICA
    const showWelcomeOnce = async () => {
      if (s.welcomed) return;
      s.welcomed = true;
      await sendImage(from, LOGO_URL, "");
      await sleep(400);
      await sendText(from, WELCOME_TEXT);
      await sleep(400);
      if (!s.askedEmpresa) {
        await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
        s.step = "ask_empresa";
        s.askedEmpresa = true;
      }
    };

    // Cualquier primer mensaje → bienvenida
    if (!s.welcomed) { await showWelcomeOnce(); return res.sendStatus(200); }

    // Comandos globales
    if (type==="text" && ["menu","inicio","start","volver","reset"].includes(lower)) {
      if (lower==="inicio" || lower==="reset") { sessions.delete(from); await getS(from); }
      await sendMainActions(from);
      return res.sendStatus(200);
    }

    /* ===== INTERACTIVE (botones/listas) ===== */
    if (type==="interactive") {

      // ===== Menú principal
      if (btnId==="action_cotizar"){ s.flow=null; s.step="choose_modo"; await sendModos(from); }
      else if (btnId==="action_calcular"){ s.flow="calc"; s.step="calc_prod_m"; await askProdMetodo(from); }
      else if (btnId==="action_local"){ s.flow="local"; s.step="local_cap";
        const caps = ["1 Pallet - 2 m3 -500 Kg","3 Pallet - 9 m3 - 1500 Kg","6 Pallet - 14 m3 - 3200 Kg","12 Pallet - 20 m3 - 10 TN","20' ST","40' ST","40' HC"];
        s._localCaps = caps;
        await sendList(from, "Elegí *Capacidad*:", listFrom(caps,"cap"), "Capacidad", "Elegir");
      }

      // ===== Cotizador clásico
      else if (btnId.startsWith("menu_")){
        s.modo = btnId.replace("menu_","");
        if (s.modo==="maritimo"){ s.step="mar_tipo"; await sendTiposMaritimo(from); }
        if (s.modo==="aereo"){
          s.step="aereo_subtipo";
          await sendButtons(from, "✈️ *Aéreo:* ¿Qué necesitás cotizar?", [
            { id:"aer_carga",   title:"Carga gral." },
            { id:"aer_courier", title:"Courier" }
          ]);
        }
        if (s.modo==="terrestre"){ s.terrestre_tipo="FTL"; s.step="ter_origen"; await sendText(from,"🚛 *Terrestre Full (Camión completo):* Indicá ciudad."); }
      }
      else if (btnId==="mar_LCL"){
        s.maritimo_tipo = "LCL";
        s.lcl_tn = null;
        s.lcl_m3 = null;
        s.lcl_apilable = null;
        s.step="lcl_tn";
        await sendText(from,"⚖️ Ingresá las *TONELADAS* totales (ej.: 2.5)");
      }
      else if (btnId==="mar_FCL"){ 
        s.maritimo_tipo = "FCL"; s.step="mar_equipo"; await sendContenedores(from);
      }
  else if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
  const cont = btnId==="mar_FCL20" ? "20" : btnId==="mar_FCL40" ? "40" : "40HC";
  
  if (s.flow === "calc") {
  // Calculadora
  s.calc_maritimo_tipo = "FCL";
  s.calc_contenedor = cont;
  s.step = "c_mar_origen";  // ✅ Nuevo paso
  await sendText(from, "📍 *Puerto de ORIGEN* (ej.: Houston / Shanghai / Hamburgo).");
  } else {
      // Cotizador clásico
      s.maritimo_tipo = "FCL";
      s.contenedor = cont;
      s.lcl_tn = null;
      s.lcl_m3 = null;
      s.lcl_apilable = null;
      s.step = "mar_origen";
      await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Houston / Shanghai / Hamburgo).");
    }
  }
  else if (btnId==="lcl_api_si"){
    s.lcl_apilable = "Sí";
    s.step="mar_origen";
    await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
  }
  else if (btnId==="lcl_api_no"){
    s.lcl_apilable = "No";
    s.step="mar_origen";
    await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
  }
  else if (btnId==="lcl_api_ns"){
    s.lcl_apilable = "No lo sé (cotizado como apilable)";
    s.step="mar_origen";
    await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).\n\n_Nota: La carga se cotizará como apilable. Es importante confirmar este dato con tu proveedor._");
  }
  else if (btnId==="aer_carga" || btnId==="aer_courier"){
    s.aereo_tipo = btnId==="aer_carga" ? "carga_general" : "courier";
    if (s.aereo_tipo==="carga_general"){ s.step="aer_origen"; await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad. Ej.: PVG / Shanghai)."); }
    else { s.step="courier_pf"; await sendButtons(from,"Para *Courier*, ¿quién importa?",[{id:"pf","title":"👤 Persona Física"},{id:"emp","title":"🏢 Empresa"}]); }
  }
      else if (btnId==="pf" || btnId==="emp"){ 
        s.courier_pf = btnId==="pf" ? "PF" : "EMP";
        s.step="courier_origen"; await sendText(from,"🌍 *País/Ciudad ORIGEN* (ej.: España / China / USA).");
      }

      else if (btnId.startsWith("fz_")) {
        const parts = btnId.split("_");
        const kind = parts[1] || "";
        const target = parts.slice(2).join("_") || "";
        const state = s._fuzzy;
        const label = kind === "air" ? "aeropuerto" : "puerto";
        if (!state || state.kind !== kind) {
          await sendText(from, `La selección expiró. Volvé a ingresar el ${label}.`);
          return res.sendStatus(200);
        }

        const prevStep = s._fuzzyPrevStep || s.step;
        s._fuzzy = null;
        s._fuzzyPrevStep = null;
        s.step = prevStep;

        let value = state.query;
        if (target !== "manual") {
          const idx = Number(target);
          if (!Number.isNaN(idx) && state.options?.[idx]) {
            value = state.options[idx].label;
            await sendText(from, `✅ Elegiste *${value}*.`);
          } else {
            await sendText(from, `⚠️ No pude identificar la opción seleccionada.\n\nPor favor, verificá que esté bien escrito e intentá nuevamente.`);
            s.step = s._fuzzyPrevStep || s.step;
            return res.sendStatus(200);
          }
        } else {
          await sendText(from, `Uso tu ${label}: *${value}*.`);
        }

        await resolveFuzzySelection(from, s, state.action, value);
        return res.sendStatus(200);
      }

      else if (btnId === "retry_aer_origen") {
        s.step = "aer_origen";
        await sendText(from, "✈️ Escribí el *AEROPUERTO ORIGEN* nuevamente (IATA o ciudad. Ej.: FRA / Frankfurt).");
        return res.sendStatus(200);
      }
      else if (btnId === "retry_mar_origen") {
        s.step = "mar_origen";
        await sendText(from, "📍 Escribí el *PUERTO DE ORIGEN* nuevamente (ej.: Shanghai / Hamburg).");
        return res.sendStatus(200);
      }
      else if (btnId.startsWith("fz_") && btnId.endsWith("_retry")) {
        const kind = btnId.includes("air") ? "air" : "sea";
        const label = kind === "air" ? "aeropuerto" : "puerto";
        s.step = s._fuzzyPrevStep || (kind === "air" ? "aer_origen" : "mar_origen");
        s._fuzzy = null;
        await sendText(from, `Escribí el ${label} nuevamente:`);
        return res.sendStatus(200);
      }
      else if (btnId==="confirmar"){ s.step="cotizar"; }
      else if (btnId==="editar"){ await sendMainActions(from); s.step="main"; }
      else if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); }

      // EXW + Upsell (Courier ya no lo pregunta)
      else if (btnId==="exw_si"){ s.step="exw_dir"; await sendText(from,"📍 *Dirección EXW* (calle, ciudad, CP, país).");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","exw_si","","","","","","Cliente indicó EXW = Sí"]);
      }
      else if (btnId==="exw_no"){ s.step="upsell";
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","exw_no","","","","","","Cliente indicó EXW = No"]);
        await upsellDespacho(from);
      }
      else if (btnId==="desp_si"){ await sendText(from,"¡Genial! Nuestro equipo te contactará para cotizar el despacho. 🙌");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","despachante_si","","","","","","Solicitó cotización de despacho"]);
        await endFlow(from); sessions.delete(from);
      }
      else if (btnId==="desp_no"){ await sendText(from,"¡Gracias por tu consulta! 🙌");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","despachante_no","","","","","","No desea cotización de despacho"]);
        await endFlow(from); sessions.delete(from);
      }

      // ===== Calculadora (árbol + búsqueda)
      else if (btnId==="calc_desc"){ s.step="calc_desc_wait"; await sendText(from,"Escribí una *breve descripción* (p.ej., “químicos”, “memorias RAM”)."); }
     else if (btnId==="calc_cat"){
  const M = await getMatrix(); 
  const V = indexMatrix(M);
  const n1Raw = V.filter(x => x.niv1).map(x => x.niv1);
  const n1 = [...new Set(n1Raw)].filter(Boolean);
  console.log("DEBUG N1 encontrados:", n1.length, n1);
  if (!n1.length) {
    await sendText(from, "⚠️ No encontré industrias. Usá 'Descripción'.");
    return res.sendStatus(200);
  }
  await sendList(from, "Elegí *Nivel 1: Industria*:", listFrom(n1,"n1"), "Nivel 1: Industria", "Elegir");
  s._tree = { V, n1 }; 
  s.step="calc_n1_pick";
}
else if (/^n1_\d+$/.test(btnId) && s.step==="calc_n1_pick"){
  const label = msg.interactive?.list_reply?.title || "";
  s.sel_n1 = label;
  const V = s._tree.V;
  
  const n2Raw = V.filter(x => {
    const n1Match = norm(x.niv1).includes(norm(label)) || norm(label).includes(norm(x.niv1));
    return n1Match && x.niv2;
  }).map(x => x.niv2);
  
  const n2 = [...new Set(n2Raw)].filter(Boolean);
  
  console.log("DEBUG N1 seleccionado:", label);
  console.log("DEBUG N2 encontrados:", n2.length, n2);
  
  if (!n2.length) {
    await sendText(from, "⚠️ No encontré sectores para esta industria. Probá con 'Descripción' o escribí 'menu'.");
    s.step = "start";
    return res.sendStatus(200);
  }
  
  await sendList(from, "Elegí *Nivel 2: Sector*:", listFrom(n2,"n2"), "Nivel 2: Sector", "Elegir");
  s._tree.n2 = n2; 
  s.step="calc_n2_pick";
}
else if (/^n2_\d+$/.test(btnId) && s.step==="calc_n2_pick"){
  const label = msg.interactive?.list_reply?.title || "";
  s.sel_n2 = label;
  const V = s._tree.V;
  
  const n3Raw = V.filter(x => {
    const n1Match = norm(x.niv1).includes(norm(s.sel_n1)) || norm(s.sel_n1).includes(norm(x.niv1));
    const n2Match = norm(x.niv2) === norm(label);
    return n1Match && n2Match && x.niv3;
  }).map(x => x.niv3);
  
  const n3 = [...new Set(n3Raw)].filter(Boolean);
  
  console.log("DEBUG N2 seleccionado:", label);
  console.log("DEBUG N3 encontrados:", n3.length, n3);
  
  if (!n3.length) {
    await sendText(from, "⚠️ No encontré categorías para este sector. Escribí 'menu' para volver.");
    s.step = "start";
    return res.sendStatus(200);
  }
  
  await sendList(from, "Elegí *Nivel 3: Categoría*:", listFrom(n3,"n3"), "Nivel 3: Categoría", "Elegir");
  s._tree.n3 = n3; 
  s.step="calc_n3_pick";
}
else if (/^n3_\d+$/.test(btnId) && s.step==="calc_n3_pick"){ 
  const label = msg.interactive?.list_reply?.title || "";
  s.sel_n3 = label;
  const V = s._tree.V;
  
  const subsRaw = V.filter(x => {
    const n1Match = norm(x.niv1).includes(norm(s.sel_n1)) || norm(s.sel_n1).includes(norm(x.niv1));
    const n2Match = norm(x.niv2) === norm(s.sel_n2);
    const n3Match = norm(x.niv3) === norm(label);
    return n1Match && n2Match && n3Match && x.sub;
  }).map(x => x.sub);
  
  const subs = [...new Set(subsRaw)].filter(Boolean);
  
  console.log("DEBUG N3 seleccionado:", label);
  console.log("DEBUG Subcategorías encontradas:", subs.length, subs);
  
  if (!subs.length) {
    await sendText(from, "⚠️ No encontré productos para esta categoría. Escribí 'menu' para volver.");
    s.step = "start";
    return res.sendStatus(200);
  }
  
  await sendList(from, "Elegí *Nivel 4: Producto / Subcategoría*:", listFrom(subs,"sub"), "Nivel 4: Producto", "Elegir");
  s._tree.subs = subs;
  s.step="calc_sub_pick";
}
else if (/^sub_\d+$/.test(btnId) && s.step === "calc_sub_pick") {
  const label = msg.interactive?.list_reply?.title || "";
  const clipSel = clip24(label);
  const clipN1 = clip24(s.sel_n1 || "");
  const clipN2 = clip24(s.sel_n2 || "");
  const clipN3 = clip24(s.sel_n3 || "");

  const M = await getMatrix();
  const fila = M.find(row => {
    const subMatch = clip24(row.SUB || "") === clipSel;
    const n1Match = clip24(row.NIV1 || "") === clipN1;
    const n2Match = clip24(row.NIV2 || "") === clipN2;
    const n3Match = clip24(row.NIV3 || "") === clipN3;
    return subMatch && n1Match && n2Match && n3Match;
  });

  if (!fila) {
    await sendText(from, "⚠️ No encontré datos para este producto. Escribí 'menu' para volver.");
    s.step = "start";
    return res.sendStatus(200);
  }

  const categoria = fila.SUB || fila.NIV3 || label;
  const descParts = [s.sel_n3 || fila.NIV3, label || categoria].filter(Boolean);
  s.matriz = fila;
  s.categoria = categoria;
  s.producto_desc = descParts.join(" / ") || categoria;

  s.step = "calc_fob_unit";
  await sendText(from, "💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).");
  return res.sendStatus(200);
}
else if (btnId === "calc_pop") {
  const M = await getMatrix();
  const directMatches = [
    M.find(x => norm(x.NIV2).includes("ferreteria")),
    M.find(x => norm(x.NIV3).includes("herramienta")),
    M.find(x => norm(x.SUB).includes("quimico")),
    M.find(x => norm(x.NIV2).includes("maquinaria")),
    M.find(x => norm(x.SUB).includes("vehiculo")),
  ].filter(Boolean);
  
  if (!directMatches.length) {
    await sendText(from, "No encontré productos populares. Usá 'Categoría' o 'Descripción'.");
    return res.sendStatus(200);
  }
  
  const opciones = directMatches.map((m,i) => ({
    id: `pop_direct_${i}`,
    title: clip24(m.SUB || m.NIV3),
    description: `${m.NIV1} > ${m.NIV2}`
  }));

  s._popMatches = directMatches;
  await sendList(from, "⭐ Productos populares:", opciones, "Populares", "Elegir");
  s.step = "calc_pop_direct_pick";
}
else if (/^pop_direct_\d+$/.test(btnId) && s.step === "calc_pop_direct_pick") {
  const index = Number(btnId.split("_").pop());
  const fila = Array.isArray(s._popMatches) ? s._popMatches[index] : undefined;

  if (!fila) {
    await sendText(from, "⚠️ No encontré datos para este producto. Escribí 'menu' para volver.");
    s.step = "start";
    return res.sendStatus(200);
  }

  const categoria = fila.SUB || fila.NIV3 || fila.NIV2 || "";
  const descripcion = (fila.NIV3 && fila.SUB)
    ? `${fila.NIV3} / ${fila.SUB}`
    : categoria;
  s.matriz = fila;
  s.categoria = categoria;
  s.producto_desc = descripcion;

  s.step = "calc_fob_unit";
  await sendText(from, "💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).");
  return res.sendStatus(200);
}
// búsqueda libre picks
else if (/^n3s_\d+$/.test(btnId) && s.step==="calc_find_n3_pick"){
  const title = msg.interactive?.list_reply?.title;
  s.sel_n3 = title;
  const { V } = s._find;
  const subs = distinct(V.filter(x=>x.niv3===title), x=>x.sub).filter(Boolean);
  await sendList(from, "Elegí *Nivel 4: Producto / Subcategoría*:", listFrom(subs,"subf"), "Nivel 4: Producto", "Elegir");
  s._find.subs = subs; s.step="calc_find_sub_pick";
}
else if (/^subf_\d+$/.test(btnId) && s.step==="calc_find_sub_pick"){
  const label = msg.interactive?.list_reply?.title;
  const M = await getMatrix();
  const fila = M.find(x => clip24(x.SUB)===clip24(label)) || M[0];
  s.matriz = fila; s.categoria = label; s.producto_desc = `${s.sel_n3} / ${label}`;
  s.step="calc_fob_unit";
  await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).");
}

// Modo de transporte (calculadora)
else if (btnId==="c_maritimo"){ s.calc_modo="maritimo"; s.step="c_mar_tipo"; await sendButtons(from,"Marítimo: ¿LCL o FCL?",[{id:"c_lcl",title:"LCL"},{id:"c_fcl",title:"FCL"}]); }
else if (btnId==="c_aereo"){ s.calc_modo="aereo"; s.step="c_confirm"; await confirmCalc(from, s); }
else if (btnId==="c_lcl"){ s.calc_maritimo_tipo="LCL"; s.step="c_mar_origen"; await sendText(from, "📍 *Puerto de ORIGEN* (ej.: Houston / Shanghai / Hamburgo)."); }
else if (btnId==="c_fcl"){ s.calc_maritimo_tipo="FCL"; s.step="c_cont"; await sendContenedores(from); }
else if (btnId==="calc_edit"){ s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); }
else if (btnId==="calc_go"){
        await sendTypingIndicator(from, 3000);

        // === calcular CIF+impuestos
        const M = s.matriz || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa_est:TASA_ESTATISTICA, nota:"" };
        let fleteUSD = 0, fleteDetalle = "";
        try{
          if (s.calc_modo==="aereo"){
            const r = await cotizarAereo({ origen: s.origen_aeropuerto || "Shanghai", kg: s.peso_kg||0, vol: (s.vol_cbm||0)*167 });
            if (r){ fleteUSD = r.totalUSD; fleteDetalle = `Flete ✈️ (Aéreo): USD ${fmtUSD(fleteUSD)}`; }
          } else if (s.calc_modo==="maritimo"){
            const modalidad = s.calc_maritimo_tipo==="FCL" ? (s.calc_contenedor?`FCL${s.calc_contenedor}`:"FCL") : "LCL";
            const wmCalc = s.calc_maritimo_tipo==="LCL" ? Math.max((s.lcl_tn||0), (s.vol_cbm||0)) : null;
            const r = await cotizarMaritimo({
              origen: s.origen_puerto || "Shanghai",
              modalidad,
              wm: wmCalc,
              m3: s.calc_maritimo_tipo==="LCL" ? s.vol_cbm : null
            });
            if (r){
              fleteUSD = r.totalUSD;
              const tiempoCalc = r.diasTransito ? ` • ${r.diasTransito} días` : "";
              fleteDetalle = `Flete 🚢 (Marítimo ${modalidad}): USD ${fmtUSD(fleteUSD)}${tiempoCalc}`;
            }
          }
        }catch{}

        const insurance = INSURANCE_RATE * (s.fob_total||0);
        const cif = (s.fob_total||0) + fleteUSD + insurance;

        const di     = cif * (M.di ?? 0);
        const tasa   = cif * (M.tasa_est ?? TASA_ESTATISTICA);
        const baseIVA= cif + di + tasa;
        const iva    = baseIVA * (M.iva ?? 0);
        const ivaAd  = baseIVA * (M.iva_ad ?? 0);
        const iibb   = cif * (M.iibb ?? 0.035);
        const iigg   = baseIVA * (M.iigg ?? RATE_IIGG);
        const internos = (M.internos ?? 0) > 0 ? cif * (M.internos||0) : 0;

        const impTotal = di + tasa + iva + ivaAd + iibb + iigg + internos;
        const costoAdu = cif + impTotal;

        const body = [
"📦 *Resultado estimado (FOB → CIF)*",
"",
`FOB total: USD ${fmtUSD(s.fob_total)} (${s.cantidad||0} u. × ${fmtUSD(s.fob_unit||0)})`,
`${fleteDetalle || "Flete: *sin tarifa* (seguimos el cálculo y te contactamos)"}`,
`Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmtUSD(insurance)}`,
`CIF: USD ${fmtUSD(cif)}`,
"",
"🏛️ *Impuestos*",
`DI (${((M.di||0)*100).toFixed(1)}%): USD ${fmtUSD(di)}`,
`Tasa Estadística (${((M.tasa_est ?? TASA_ESTATISTICA)*100).toFixed(1)}% CIF): USD ${fmtUSD(tasa)}`,
`IVA (${((M.iva||0)*100).toFixed(1)}%): USD ${fmtUSD(iva)}`,
`IVA Adic. (${((M.iva_ad||0)*100).toFixed(1)}%): USD ${fmtUSD(ivaAd)}`,
`IIBB (${((M.iibb||0)*100).toFixed(1)}%): USD ${fmtUSD(iibb)}`,
`IIGG (${((M.iigg??RATE_IIGG)*100).toFixed(1)}%): USD ${fmtUSD(iigg)}` + ((M.internos||0)>0?`\nInternos (${(M.internos*100).toFixed(1)}%): USD ${fmtUSD(internos)}`:""),
"",
`📊 *Total impuestos:* USD ${fmtUSD(impTotal)}`,
"💰 *Costo final (CIF + imp.)*",
`Costo aduanero: USD ${fmtUSD(costoAdu)}`,
"",
`➡️ Costo unitario final: USD ${fmtUSD((costoAdu/(s.cantidad||1))||0)}`,
`📈 Incremento sobre FOB: +${(((costoAdu/(s.fob_total||1))-1)*100).toFixed(2)}%`,
"",
"📝 *Notas:*",
...(M.nota? M.nota.split("\n").map(x=>"* "+x.trim()) : []),
"* _No contempla gastos locales (liberación, despachante, almacenaje, etc.)._"
].join("\n");

        await sendText(from, body);

        await logCalculo([
          new Date().toISOString(), from, s.empresa, (s.producto_desc||s.categoria||s.sel_n3||""), (s.matriz?.SUB||s.matriz?.NIV3||""),
          s.fob_unit, s.cantidad, s.fob_total, s.peso_kg, s.vol_cbm,
          s.calc_modo, s.calc_maritimo_tipo||"", s.calc_contenedor||"",
          insurance, fleteUSD, cif, di, tasa, iva, ivaAd, iibb, iigg, internos, impTotal, costoAdu
        ]);

        // pedir email corporativo
        s.step = "ask_if_email";
        await sendButtons(from, "📧 ¿Deseás que te enviemos la cotización por correo?", [
          { id:"email_si", title:"✅ Sí" },
          { id:"email_no", title:"❌ No" }
        ]);
      }
      else if (btnId==="email_si"){
        s.step = "ask_email";
        await sendText(from, "Dejanos un *email corporativo* (ej.: nombre@empresa.com.ar).\n_(No se aceptan gmail, yahoo, hotmail, outlook)_");
      }
      else if (btnId==="email_no"){
        await sendText(from,"¡Gracias! Nuestro equipo te contactará a la brevedad.");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","email_rechazado", "", "", "", "", "", "", "Usuario no desea recibir email"]);
        await endFlow(from);
        sessions.delete(from);
      }
      // rating + volver
      else if (/^rate_[1-5]$/.test(btnId)){ 
        const val = Number(btnId.split("_")[1]);
        await sendText(from,"¡Gracias por tu calificación! ⭐"); 
        await logRating(from, s.empresa, val);
      }

      else if (btnId==="menu_si"){ await sendMainActions(from); s.step="main"; }
      else if (btnId==="menu_no"){ await sendText(from,"¡Gracias! Si necesitás algo más, escribinos cuando quieras."); }

      // === Flete Local ===
      else if (/^cap_\d+$/.test(btnId) && s.flow==="local" && s.step==="local_cap"){
        const label = msg.interactive?.list_reply?.title || "";
        const idx = Number(btnId.split("_")[1]);
        const caps = Array.isArray(s._localCaps) ? s._localCaps : [];
        s.local_cap = caps?.[idx] || label;
        s.step="local_tipo";
        await sendButtons(from, "Tipo de carga:", [
          { id:"lt_seca",  title:"Carga Seca" },
          { id:"lt_refr",  title:"Refrigerada" },
          { id:"lt_imo",   title:"IMO / Peligrosa" },
        ]);
      }
      else if (["lt_seca","lt_refr","lt_imo"].includes(btnId) && s.flow==="local"){
        s.local_tipo = btnId==="lt_seca"?"seca":btnId==="lt_refr"?"refrig":"pelig";
        s.step="local_dist";
        const dists = [
          {key:"CABA", title:"CABA"},
          {key:"BS30", title:"BS AS ≤ 30 km"},
          {key:"BS50", title:"BS AS ≤ 50 km"},
          {key:"BS70", title:"BS AS ≤ 70 km"},
          {key:"BS100",title:"BS AS ≤ 100 km"},
        ];
        await sendList(from, "Elegí *Distancia*:", dists.map((d,i)=>({id:`ld_${i}`,title:d.title})), "Distancia", "Elegir");
        s._localDists = dists;
      }
      else if (/^ld_\d+$/.test(btnId) && s.flow==="local" && s.step==="local_dist"){
        const title = msg.interactive?.list_reply?.title || "";
        const distKey = s._localDists.find(x=>x.title===title)?.key || "CABA";
        s.local_dist = distKey;

        // Buscar valor en sheet
        const rows = await readTabRange(TAR_SHEET_ID, TAB_LOCAL, "A1:Z10000", ["fletelocal","local"]);
        const header = rows[0], data = rows.slice(1);
        const iVeh  = headerIndex(header,"vehiculo","vehículo");
        const iTipo = headerIndex(header,"tipo");
        const iCap  = headerIndex(header,"capacidad");
        const iCABA = headerIndex(header,"caba");
        const i30   = headerIndex(header,"bs as hasta 30 km","30");
        const i50   = headerIndex(header,"bs as hasta 50 km","50");
        const i70   = headerIndex(header,"bs as hasta 70 km","70");
        const i100  = headerIndex(header,"bs as hasta 100 km","100");

        const tipoWanted = s.local_tipo==="refrig"?"refrigerado":s.local_tipo==="pelig"?"carga peligrosa":"carga seca";
        const row = data.find(r => norm(r[iCap])===norm(s.local_cap) && norm(r[iTipo]).includes(tipoWanted));
        if (!row){ await sendText(from,"❌ No encontré tarifa para esa combinación en *Flete Local*."); return res.sendStatus(200); }

        const col = distKey==="CABA"?iCABA:distKey==="BS30"?i30:distKey==="BS50"?i50:distKey==="BS70"?i70:i100;
        const monto = toNum(row[col]);
        const texto = [
          "✅ *Tarifa estimada (FLETE LOCAL)*",
          `Capacidad: *${s.local_cap}*`,
          `Tipo: *${s.local_tipo==="refrig"?"Refrigerada":s.local_tipo==="pelig"?"IMO / Peligrosa":"Carga Seca"}*`,
          `Distancia: *${title}*`,
          row[iVeh] ? `Vehículo: ${row[iVeh]}` : "",
          "",
          `*Total:* $ ${fmtARS(monto)}`,
          "",
          "_Nota: el valor no incluye IVA._"
        ].filter(Boolean).join("\n");
        await sendText(from, texto);

        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","flete_local", s.local_cap, title, "", "", s.local_tipo, monto, "Flete local"]);

        // cierre: rating + menú
        await endFlow(from); sessions.delete(from);
      }

      if (s.step !== "cotizar") return res.sendStatus(200);
    }

    /* ===== TEXTO ===== */
    if (type==="text") {
      if (s.step==="ask_empresa"){
        s.empresa = text;
        await saveUserEmpresa(from, text);
        await sendText(from, `Gracias. Empresa guardada: *${s.empresa}*`);
        await sendMainActions(from);
        s.step="main";
        return res.sendStatus(200);
      }

      // Email corporativo
      if (s.step==="ask_email"){
        const mail = text.trim();
        if (!isCorporateEmail(mail)){
          await sendText(from, "⚠️ Por favor ingresá un *correo corporativo válido* (ej.: nombre@empresa.com.ar). Evitá gmail/yahoo/hotmail/outlook.");
          return res.sendStatus(200);
        }
        s.email = mail;
        await sendText(from, "¡Perfecto! Guardamos tu correo para el envío de la cotización. ✅");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","email", "", "", "", "", "", "", `email=${mail}`]);

        // si no hay upsell pendiente, pedimos rating/cierre
        await upsellDespacho(from); s.step="upsell";
        return res.sendStatus(200);
      }

      // Cotizador clásico
      if (s.step==="mar_origen"){
        await sendTypingIndicator(from, 2000);
        if (await fuzzySearchPlace({ from, s, query: text, kind: "sea", action: "mar_origen" }))
          return res.sendStatus(200);
      }
      if (s.step==="aer_origen"){
        await sendTypingIndicator(from, 2000);
        if (await fuzzySearchPlace({ from, s, query: text, kind: "air", action: "aer_origen" }))
          return res.sendStatus(200);
      }
      if (s.step==="aer_peso"){
        const peso = toNum(text);
        if (isNaN(peso) || peso < 0) {
          await sendText(from,"⚠️ Ingresá un *número válido* para el peso (ej.: 1232).\nNo uses letras ni símbolos.");
          return res.sendStatus(200);
        }
        s.peso_kg = Math.max(0, Math.round(peso)); s.step="aer_vol";
        await sendText(from,"📦 *Peso volumétrico (kg)* (poné 0 si no sabés)."); return res.sendStatus(200);
      }
      if (s.step==="aer_vol"){
        const vol = toNum(text);
        if (isNaN(vol) || vol < 0) {
          await sendText(from,"⚠️ Ingresá un *número válido* para el volumen (ej.: 1232).\nNo uses letras ni símbolos.");
          return res.sendStatus(200);
        }
        s.vol_cbm = Math.max(0, vol); await askResumen(from, s); return res.sendStatus(200);
      }
      if (s.step==="courier_origen"){
        const input = norm(text);

        // Validar que el país exista en nuestro catálogo
        const region = COUNTRY_TO_REGION[input];

        if (!region) {
          // Intentar match parcial
          const keys = Object.keys(COUNTRY_TO_REGION);
          const match = keys.find(k => k.includes(input) || input.includes(k));

          if (match) {
            s.origen_aeropuerto = match;
            await sendText(from, `✅ Usaremos *${match}*.`);
          } else {
            await sendText(from,
              `❌ No reconozco "${text}" como país válido.\n\n` +
              `Ejemplos: España, China, USA, Alemania, Brasil.\n\n` +
              `Escribí el país nuevamente:`
            );
            return res.sendStatus(200);
          }
        } else {
          s.origen_aeropuerto = input;
        }

        s.step="courier_peso";
        await sendText(from,"⚖️ *Peso (kg)* (podés usar decimales).");
        return res.sendStatus(200);
      }
      if (s.step==="courier_peso"){
        const peso = toNum(text);
        if (isNaN(peso) || peso <= 0) {
          await sendText(from,"⚠️ Ingresá un *número válido* para el peso (ej.: 25.5).\nNo uses letras ni símbolos.");
          return res.sendStatus(200);
        }
        s.peso_kg = peso; await askResumen(from, s); return res.sendStatus(200);
      }
      if (s.step==="ter_origen"){ s.origen_direccion = text; await askResumen(from, s); return res.sendStatus(200); }

      // LCL preguntas
      if (s.step==="lcl_tn"){ const n = toNum(text); if(!isFinite(n) || n < 0){await sendText(from,"⚠️ Ingresá *toneladas válidas* (ej.: 2.5 o 2,5).\nNo uses letras ni símbolos."); return res.sendStatus(200);} s.lcl_tn=n; s.step="lcl_m3"; await sendText(from,"📦 *Volumen total (m³)* (ej.: 8,5)"); return res.sendStatus(200); }
      if (s.step==="lcl_m3"){
        const n = toNum(text);
        if(!isFinite(n) || n < 0){
          await sendText(from,"⚠️ Ingresá *m³ válidos* (ej.: 8.5 o 8,5).\nNo uses letras ni símbolos.");
          return res.sendStatus(200);
        }
        s.lcl_m3 = n;
        s.step = "lcl_apilable";
        await sendButtons(from, "📦 ¿La carga es *apilable*?", [
          { id:"lcl_api_si", title:"✅ Sí" },
          { id:"lcl_api_no", title:"❌ No" },
          { id:"lcl_api_ns", title:"🤷 No lo sé" }
        ]);
        return res.sendStatus(200);
      }

      if (s.step==="exw_dir"){ s.exw_dir = text; s.step="upsell"; await sendText(from,"¡Gracias! Tomamos la dirección EXW."); await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","exw_dir", s.exw_dir, "", "", "", "", "", "Dirección EXW"]); await upsellDespacho(from); return res.sendStatus(200); }

      // Calculadora — búsqueda libre
if (s.flow==="calc"){
  if (s.step==="c_mar_origen"){
    await sendTypingIndicator(from, 2000);
    if (await fuzzySearchPlace({ from, s, query: text, kind: "sea", action: "c_mar_origen" })) {
      return res.sendStatus(200);
    }
  }
}    // ← acá hoy solo hay *un* cierre
        if (s.step==="calc_desc_wait"){
          await sendTypingIndicator(from, 2000);

          const query = text;
          const M = await getMatrix();
          const V = indexMatrix(M);
          const n3Matches = distinct(
            V.filter(x => norm(x.niv3).includes(norm(query)) || norm(x.sub).includes(norm(query))),
            x => x.niv3
          ).filter(Boolean);

          if (!n3Matches.length){
            s.matriz = M[0] || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa_est:TASA_ESTATISTICA };
            s.producto_desc = query;
            s.step="calc_fob_unit";
            await sendText(from,"No encontré coincidencias claras. Uso categoría genérica.\n\n💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).");
          } else {
            const rows = listFrom(n3Matches,"n3s");
            s._find = { V, n3Matches };
            await sendList(from, "Elegí *Nivel 3: Categoría*:", rows, "Nivel 3: Categoría", "Elegir");
            s.step = "calc_find_n3_pick";
          }
          return res.sendStatus(200);
        }
        if (s.step==="calc_fob_unit"){
          const n = toNum(text);
          if (!isFinite(n) || n <= 0){ await sendText(from,"⚠️ Ingresá un *precio válido* (ej.: 125.50 o 125,50).\nNo uses letras ni símbolos."); return res.sendStatus(200); }
          s.fob_unit = n; s.step="calc_qty"; await sendText(from,"🔢 Ingresá la *cantidad* de unidades."); return res.sendStatus(200);
        }
        if (s.step==="calc_qty"){
          const q = toNum(text);
          if (!isFinite(q) || q <= 0) {
            await sendText(from,"⚠️ Ingresá una *cantidad válida* (ej.: 100).\nNo uses letras ni símbolos.");
            return res.sendStatus(200);
          }
          s.cantidad = Math.max(1, Math.round(q)); s.fob_total=(s.fob_unit||0)*s.cantidad;
          s.step="calc_vol"; await sendText(from,"📦 Ingresá el *VOLUMEN total* en m³ (ej.: 8,5). Si no sabés, 0."); return res.sendStatus(200);
        }
        if (s.step==="calc_vol"){
          const vol = toNum(text);
          if (!isFinite(vol) || vol < 0) {
            await sendText(from,"⚠️ Ingresá un *volumen válido* en m³ (ej.: 8.5 o 0).\nNo uses letras ni símbolos.");
            return res.sendStatus(200);
          }
          s.vol_cbm = vol; s.step="calc_peso";
          await sendText(from,"⚖️ Ingresá el *PESO total* en kg (ej.: 120). Si no tenés el dato, 0."); return res.sendStatus(200);
        }
        if (s.step==="calc_peso"){
          const peso = toNum(text);
          if (!isFinite(peso) || peso < 0) {
            await sendText(from,"⚠️ Ingresá un *peso válido* en kg (ej.: 120 o 0).\nNo uses letras ni símbolos.");
            return res.sendStatus(200);
          }
          s.peso_kg = peso;
          s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); return res.sendStatus(200);
        }
if (s.step==="c_mar_origen" && s.flow==="calc"){
  await sendTypingIndicator(from, 2000);
  if (await fuzzySearchPlace({ from, s, query: text, kind: "sea", action: "c_mar_origen" })) {
    return res.sendStatus(200);
  }
}
    }

    /* ===== COTIZAR (ejecución) ===== */
/* ===== COTIZAR (ejecución) ===== */
    if (s.step==="cotizar"){
      await sendTypingIndicator(from, 2500);
      try {
        if (s.modo==="aereo" && s.aereo_tipo==="carga_general"){
          const r = await cotizarAereo({ origen: s.origen_aeropuerto, kg: s.peso_kg||0, vol: s.vol_cbm||0 });
          if (!r){
            await sendButtons(from,
              `❌ No encontré esa ruta en *${TAB_AEREOS}*. ¿Qué querés hacer?`,
              [
                { id:"retry_aer_origen", title:"🔄 Otro aeropuerto" },
                { id:"menu_si", title:"🏠 Menú principal" }
              ]
            );
            s.step = "waiting_retry";
            return res.sendStatus(200);
          }
          const unit = `USD ${fmtUSD(r.pricePerKg)} por KG (FOB)`;
          const min  = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
          const resp = `✅ *Tarifa estimada (AÉREO – Carga general)*\n${unit} + *Gastos Locales*.${min}\n\n*Kilos facturables:* ${r.facturableKg}\n*Total estimado:* USD ${fmtUSD(r.totalUSD)}\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","aereo", s.origen_aeropuerto, r.destino, s.peso_kg||"", s.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.origen_aeropuerto}→${r.destino}`]);

          // Sugerencias de conveniencia
          const sugerencias = await analizarConveniencia(s);
          if (sugerencias.length > 0) {
            await sleep(500);
            for (const sug of sugerencias) {
              await sendText(from, sug);
              await sleep(300);
            }
          }
        } else if (s.modo==="aereo" && s.aereo_tipo==="courier"){
          const r = await cotizarCourier({ pais: s.origen_aeropuerto, kg: s.peso_kg||0 });
          if (!r){ await sendText(from,`❌ No pude calcular *${TAB_COURIER}*. Revisá la pestaña.`); return res.sendStatus(200); }
          const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg.` : "";
          const resp = `✅ *Tarifa estimada (COURIER)*\n*Importador:* ${s.courier_pf==="PF"?"Persona Física":"Empresa"}\n*Peso:* ${fmtUSD(s.peso_kg)} kg${nota}\n*Total:* USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","courier", s.origen_aeropuerto, r.destino, s.peso_kg||"", "", s.courier_pf||"", r.totalUSD, `Courier ${s.origen_aeropuerto}`]);

          // Sugerencias de conveniencia
          const sugerencias = await analizarConveniencia(s);
          if (sugerencias.length > 0) {
            await sleep(500);
            for (const sug of sugerencias) {
              await sendText(from, sug);
              await sleep(300);
            }
          }
          s.step = "ask_email";
          await sendText(from, "📧 ¿Deseás que te enviemos la cotización por correo?\nDejanos un *email corporativo* (ej.: nombre@empresa.com.ar).\n_(No se aceptan gmail, yahoo, hotmail, outlook)_");
          return res.sendStatus(200);
        } else if (s.modo==="maritimo"){
          if (s.maritimo_tipo==="LCL"){ 
            const wm = Math.max((s.lcl_tn||0), (s.lcl_m3||0));
            const r = await cotizarMaritimo({
              origen: s.origen_puerto,
              modalidad: "LCL",
              wm,
              m3: s.lcl_m3
            });
            if (!r){
              await sendButtons(from,
                `❌ No encontré esa ruta en *${TAB_MARITIMOS}*. ¿Qué querés hacer?`,
                  [
                    { id:"retry_mar_origen", title:"🔄 Otro puerto" },
                    { id:"menu_si", title:"🏠 Menú principal" }
                  ]
                );
              s.step = "waiting_retry";
              return res.sendStatus(200);
            }
            const tiempoTexto = r.diasTransito ? `⏱️ *Tiempo estimado:* ${r.diasTransito} días\n` : "";
            const voluminosoTexto = r.esVoluminoso ? `⚠️ Tarifa voluminosa aplicada (5-10 m³)\n` : "";

            const texto = `✅ *Tarifa estimada (Marítimo LCL)*\nW/M: ${fmtUSD(wm)} (t vs m³)\nTarifa base: USD ${fmtUSD(r.tarifaBase)} por W/M\n${voluminosoTexto}${tiempoTexto}\n*Total estimado:* USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
            await sendText(from, texto);
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", "LCL", r.totalUSD, `Marítimo LCL ${s.origen_puerto}→${r.destino} WM:${wm}`]);

            // Sugerencias de conveniencia
            const sugerencias = await analizarConveniencia(s);
            if (sugerencias.length > 0) {
              await sleep(500);
              for (const sug of sugerencias) {
                await sendText(from, sug);
                await sleep(300);
              }
            }
          } else {
            const modalidad = "FCL" + (s.contenedor||"");
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
            if (!r){
              await sendButtons(from,
                `❌ No encontré esa ruta en *${TAB_MARITIMOS}*. ¿Qué querés hacer?`,
                [
                  { id:"retry_mar_origen", title:"🔄 Otro puerto" },
                  { id:"menu_si", title:"🏠 Menú principal" }
                ]
              );
              s.step = "waiting_retry";
              return res.sendStatus(200);
            }
            const partes = [
              `✅ *Tarifa estimada (Marítimo ${modalidad})*`,
              `USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.`,
              `*Origen:* ${s.origen_puerto}`
            ];
            if (r.transit) {
              partes.push(`⏱️ Tiempo estimado: ${r.transit}`);
            }
            partes.push(
              "",
              `*Validez:* ${VALIDEZ_DIAS} días`,
              "*Nota:* No incluye impuestos ni gastos locales."
            );
            const texto = partes.join("\n");
            await sendText(from, texto);
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.origen_puerto}→${r.destino}`]);
            const sugerencias = await analizarConveniencia(s);
            if (sugerencias.length > 0) {
              await sleep(500);
              for (const sug of sugerencias) {
                await sendText(from, sug);
                await sleep(300);
              }
            }
          }
        } else if (s.modo==="terrestre"){
          const r = await cotizarTerrestre({ origen: s.origen_direccion || "" });
          if (!r){ await sendText(from,`❌ No encontré esa ruta en *${TAB_TERRESTRES}*.`); return res.sendStatus(200); }
          const resp = `✅ *Tarifa estimada (TERRESTRE FTL)*\nUSD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","terrestre", s.origen_direccion||"", r.destino, "", "", "FTL", r.totalUSD, `Terrestre ${s.origen_direccion}→${r.destino}`]);
        }

        await sendText(from, "✅ *Tu consulta fue registrada.* Nuestro equipo te contactará a la brevedad.\n📧 hola@conektarsa.com");

        if (!(s.modo==="aereo" && s.aereo_tipo==="courier")){
          await sendButtons(from, "¿Tu carga es EXW?", [
            { id:"exw_si", title:"Sí" },
            { id:"exw_no", title:"No" }
          ]);
          s.step="exw_q";
        }
      } catch(e) {
        console.error("cotizar error", e);
        await sendText(from,"⚠️ Hubo un problema al leer la planilla. Revisá nombres de pestañas y permisos.");
      }
      return res.sendStatus(200);
    }
  } catch (err) {
    console.error("webhook error", err);
    if (!res.headersSent) return res.sendStatus(500);
  }
});

/* ========= HEALTH ========= */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo + Local ✅ v4.0"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

/* ========= Start ========= */
app.listen(PORT, ()=> {
  console.log(`🚀 Bot v4.0 en http://localhost:${PORT}`);
  loadTransportCatalogs().catch(e => console.error("loadTransportCatalogs", e?.message || e));
});

/* ========= Helpers de resumen ========= */
function modoMayus(m) {
  const map = { aereo:"AÉREO", maritimo:"MARÍTIMO", terrestre:"TERRESTRE" };
  return map[m] || (m||"").toUpperCase();
}
function resumenTexto(d){
  const lines = [];
  lines.push("🧾 *Revisá los datos:*");
  if (d.empresa) lines.push(`• Empresa: *${d.empresa}*`);
  if (d.modo)    lines.push(`• Modo: *${modoMayus(d.modo)}*`);
  if (d.modo==="maritimo"){
    if (d.maritimo_tipo==="LCL"){
      lines.push("• Tipo: *LCL*");
      lines.push(`• Ton: ${fmtUSD(d.lcl_tn||0)} • m³: ${fmtUSD(d.lcl_m3||0)} • Apilable: ${d.lcl_apilable||"?"}`);
    } else {
      lines.push(`• Tipo: *FCL* ${d.contenedor?`(Equipo: ${d.contenedor})`:""}`);
    }
    lines.push(`• Ruta: *${d.origen_puerto || "?"}* ➡️ *${d.destino_puerto}*`);
  }
  if (d.modo==="aereo"){
    if(d.aereo_tipo==="carga_general"){
      lines.push("• Subtipo: *Carga general*");
      lines.push(`• Ruta: *${d.origen_aeropuerto || "?"}* ➡️ *${d.destino_aeropuerto}*`);
      if (d.peso_kg!=null) lines.push(`• Peso: *${d.peso_kg} kg*`);
      if (d.vol_cbm!=null) lines.push(`• Peso volumétrico: *${d.vol_cbm} kg*`);
    } else {
      lines.push(`• Subtipo: *Courier* (${d.courier_pf==="PF"?"PF":"Empresa"})`);
      lines.push(`• Origen: *${d.origen_aeropuerto || "?"}* ➡️ *${d.destino_aeropuerto}*`);
      if (d.peso_kg!=null) lines.push(`• Peso: *${fmtUSD(d.peso_kg)} kg*`);
    }
  }
  if (d.modo==="terrestre"){
    lines.push("• Tipo: *FTL*");
    lines.push(`• Origen: *${d.origen_direccion || "?"}* ➡️ *${d.destino_direccion}*`);
  }
  lines.push("\n¿Confirmás para cotizar?");
  return lines.join("\n");
}
const askResumen = (to, d) =>
  sendButtons(to, resumenTexto(d), [
    { id:"confirmar", title:"✅ Confirmar" },
    { id:"editar",    title:"✏️ Editar" },
    { id:"cancelar",  title:"Cancelar" }
  ]);

function confirmCalc(to, d){
  const lines = [
    "Revisá los datos 👇",
    `• Empresa: *${d.empresa || "-"}*`,
    `• Producto: *${d.producto_desc || d.categoria || d.sel_n3 || "-"}*`,
    `• FOB unit: *USD ${fmtUSD(d.fob_unit||0)}* × *${d.cantidad||0}* = *USD ${fmtUSD(d.fob_total||0)}*`,
    `• Volumen: *${fmt(d.vol_cbm||0)} m³*  • Peso: *${fmt(d.peso_kg||0)} kg*`,
    `• Modo: *${(d.calc_modo||"").toUpperCase()}*${d.calc_modo==="maritimo" && d.calc_maritimo_tipo ? ` • ${d.calc_maritimo_tipo}`:""}${d.calc_contenedor?` • Contenedor: *${d.calc_contenedor}*`:""}`,
    "",
    "Incoterm: FOB",
    "¿Confirmás para calcular?"
  ].join("\n");
  return sendButtons(to, lines, [
    { id:"calc_go",   title:"✅ Calcular" },
    { id:"calc_edit", title:"✏️ Editar" },
  ]);
}
/* ========= Courier cotizador ========= */
// ✅ ÚNICA DEFINICIÓN
async function cotizarCourierTarifas({ pais, kg }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_COURIER, "A1:Z10000", ["courier"]);
  if (!rows.length) throw new Error("Courier vacío");

  const header = rows[0], data = rows.slice(1);
  const iPeso = headerIndex(header, "peso", "peso (kg)");
  const iAS   = headerIndex(header, "america sur");
  const iUS   = headerIndex(header, "usa", "usa & canada", "usa & canadá");
  const iEU   = headerIndex(header, "europa");
  const iASIA = headerIndex(header, "asia");

  const region = COUNTRY_TO_REGION[norm(pais)] || "europa";
  const col = region === "america sur" ? iAS
            : region === "usa & canadá" ? iUS
            : region === "asia" ? iASIA
            : iEU;

  const wanted = Number(kg);
  let exact = data.find(r => toNum(r[iPeso]) === wanted);
  let usado = wanted, ajustado = false;

  if (!exact) {
    if (typeof COURIER_ROUND_UP !== "undefined" && COURIER_ROUND_UP) {
      const mayores = data
        .map(r => ({ r, p: toNum(r[iPeso]) }))
        .filter(x => isFinite(x.p) && x.p >= wanted)
        .sort((a, b) => a.p - b.p);
      if (mayores.length) { exact = mayores[0].r; usado = toNum(exact[iPeso]); ajustado = true; }
    }
    if (!exact) {
      let best = null, bestDiff = Infinity;
      for (const r of data) {
        const p = toNum(r[iPeso]); if (!isFinite(p)) continue;
        const d = Math.abs(p - wanted);
        if (d < bestDiff) { best = r; bestDiff = d; }
      }
      exact = best; usado = toNum(best?.[iPeso]); ajustado = true;
    }
  }

  return {
    region,
    escalonKg: usado,
    ajustado,
    totalUSD: toNum(exact?.[col]),
    destino: "Ezeiza (EZE)"
  };
}



















