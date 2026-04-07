// index.js — Conektar S.A. • Bot Cotizaciones + Costeo Importe + Flete Local
// v4.1 — UX Etapa 1: menú lista, calculadora visible, recordatorios, mensajes de error mejorados

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import Fuse from "fuse.js";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== ENV ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = "v23.0";
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();

/* Tarifa Sheets (cotizador + matriz) */
const TAR_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AEREOS = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aéreos").trim();
const TAB_MARITIMOS = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Marítimos").trim();
const TAB_TERRESTRES = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COURIER = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();
const TAB_CLASIFICACION = (process.env.GOOGLE_TARIFFS_TAB_CLASIFICACION || "Clasificación").trim();
const TAB_LOCAL = (process.env.GOOGLE_TARIFFS_TAB_FLETE_LOCAL || "Flete Local").trim();
const TAB_NACIONAL = (process.env.GOOGLE_TARIFFS_TAB_FLETE_NACIONAL || "Flete LTL Nacional").trim();

const LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB      = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();
const TAB_USUARIOS = (process.env.GOOGLE_LOG_TAB_USUARIOS || "Usuarios").trim();
const TAB_CALCULOS = (process.env.GOOGLE_CALC_TAB || "calculos").trim();
const TAB_PRODUCTOS_NO_CLASIFICADOS = "Productos a Clasificar";

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);

const LOGO_URL = (process.env.LOGO_URL ||
  "https://conektarsa.com/wp-content/uploads/2025/09/Conektarsa_logo_Whapp.jpg").trim();

/* Parámetros cálculo */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01);
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03);
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06);

/* Sistema de clasificación automática */
const UMBRAL_CONFIANZA = {
  AUTO_CLASIFICAR: 20,
  MOSTRAR_OPCIONES: 10,
  ESCALAR_ASESOR: 0
};

const PUNTOS_MATCH = {
  MATCH_EXACTO: 10,
  MATCH_PARCIAL: 5,
  MATCH_FUZZY_85: 3,
  MATCH_FUZZY_70: 1
};

// Whitelist de dominios permitidos para links
const DOMINIOS_PERMITIDOS = [
  'mercadolibre.com.ar', 'mercadolibre.com', 'mercadolibre.com.mx',
  'aliexpress.com', 'aliexpress.us',
  'amazon.com', 'amazon.com.br', 'amazon.es', 'amazon.com.mx',
  'alibaba.com',
  'ebay.com', 'ebay.com.ar',
  'sony.com', 'samsung.com', 'lg.com', 'apple.com',
  'nike.com', 'adidas.com', 'puma.com',
  'lenovo.com', 'dell.com', 'hp.com', 'asus.com'
];

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

/* ========= Anthropic Claude ========= */
let anthropic = null;
if (ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
} else {
  console.warn("⚠️ ANTHROPIC_API_KEY no configurada. Análisis de imágenes y extracción avanzada deshabilitados.");
}

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

const toNum = (s) => {
  if (typeof s === "number") return s;
  if (!s) return NaN;
  let str = String(s).trim();
  const original = str;
  str = str.replace(/[^\d.,-]/g, "");
  if (!str || str === "-" || str === "." || str === ",") return NaN;
  if (!/\d/.test(original)) return NaN;
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

/* ========= Recordatorio menú ========= */
// v4.1: texto estándar que se agrega al pie de preguntas de datos
const HINT_MENU = "\n\n_💡 Escribí *menu* para volver al inicio_";

/* ========= Mapeo de Regiones para Flete Nacional ========= */
const REGIONES_DESTINO = {
  "Patagonia Norte": [
    "neuquen", "bariloche", "san martin de los andes", "zapala", "cutral co",
    "villa regina", "chos malal", "el bolson", "junin de los andes",
    "villa la angostura", "rincon de los sauces", "anelo", "piedra del aguila",
    "rio negro", "choele choel", "viedma", "catriel", "general roca",
    "san antonio oeste", "ingeniero jacobacci", "rio colorado", "sierra grande"
  ],
  "Patagonia Atlántica": [
    "trelew", "puerto madryn", "comodoro rivadavia", "caleta olivia",
    "pico truncado", "rawson", "sarmiento"
  ],
  "Patagonia Sur": [
    "rio gallegos", "rio grande", "rio turbio", "san julian", "puerto deseado",
    "perito moreno", "calafate", "ushuaia", "cte piedra buena", "pto santa cruz",
    "comandante piedra buena", "puerto santa cruz"
  ],
  "Cuyo": ["mendoza", "san juan", "san rafael"],
  "Centro": ["cordoba", "rio cuarto", "rosario"],
  "NOA": ["salta", "jujuy", "tucuman", "catamarca", "cafayate"],
  "Pampeana": ["bahia blanca", "mar del plata", "olavarria", "la pampa"],
  "Litoral": ["resistencia"]
};

function detectarRegion(ciudad) {
  const c = norm(ciudad);
  for (const [region, ciudades] of Object.entries(REGIONES_DESTINO)) {
    for (const keyword of ciudades) {
      if (c.includes(keyword) || keyword.includes(c)) return region;
    }
  }
  return "Centro";
}

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
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
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

// v4.1: WELCOME_TEXT acortado
const WELCOME_TEXT =
  "🚚 *Conektar - Logística Integral*\n\n" +
  "¡Hola! Podés cotizar tus envíos desde acá.\n\n" +
  "💡 En cualquier momento escribí *menu* para volver al inicio.\n" +
  "📧 hola@conektarsa.com";

// v4.1: sendMainActions ahora usa lista para mostrar los 4 servicios
const sendMainActions = async (to) => {
  return sendList(to, "¿Qué servicio necesitás?", [
    { id:"action_amba",          title:"🚛 Flete AMBA",             description:"CABA y Gran Buenos Aires" },
    { id:"action_nacional",      title:"🚚 Flete Nacional",          description:"Interior del país" },
    { id:"action_internacional", title:"🌍 Flete Internacional",     description:"Aéreo • Marítimo • Terrestre" },
    { id:"action_calculadora",   title:"🧮 Calculadora Importación", description:"FOB → Costo final con impuestos" },
  ], "Servicios", "Ver servicios");
};

const sendMasServicios = async (to) => {
  return sendButtons(to, "Otros servicios disponibles:", [
    { id:"action_internacional", title:"🌍 Flete Intl." },
    { id:"action_calculadora",   title:"🧮 Calculadora" },
    { id:"menu_si",              title:"🔙 Volver" },
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

// v4.1: endFlow agrega recordatorio antes del rating
const endFlow = async (to) => {
  await sendText(to, "💡 _Escribí *menu* en cualquier momento para hacer otra consulta._");
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
    console.log(`⭐ Rating guardado: ${waId} → ${empresa} → ${valor} estrellas`);
  }catch(e){
    console.error("❌ ERROR logRating:", e?.message||e);
  }
}

async function logProductoNoClasificado(waId, empresa, productoDesc, palabrasClave, metodo = "descripcion"){
  try{
    await sheetsClient().spreadsheets.values.append({
      spreadsheetId: LOG_SHEET_ID,
      range: `${TAB_PRODUCTOS_NO_CLASIFICADOS}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        new Date().toISOString(),
        waId,
        empresa || "No especificada",
        productoDesc,
        palabrasClave.join(", "),
        metodo,
        "Pendiente"
      ]] }
    });
    console.log(`📝 Producto no clasificado registrado: ${productoDesc}`);
  }catch(e){
    console.error("❌ ERROR logProductoNoClasificado:", e?.message||e);
  }
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
    await sendText(from, `⚖️ *Peso (kg)* (entero).${HINT_MENU}`);
  } else if (action === "c_mar_origen") {
    s.origen_puerto = chosen;
    s.step = "c_confirm";
    await confirmCalc(from, s);
  } else if (action === "c_aer_origen") {
    s.origen_aeropuerto = chosen;
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

  if (!catalog.length || !fuse) {
    // v4.1: error con botón volver al menú
    await sendButtons(from,
      `⚠️ No tengo catálogo actualizado de ${label}s.\nContactá al equipo o volvé al menú.`,
      [{ id: "menu_si", title: "🏠 Menú principal" }]
    );
    s.step = "main";
    return true;
  }

  const results = fuse.search(input, { limit: FUSE_MAX_RESULTS });

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

  if (best && best.item) {
    const bestNorm = best.item.norm || norm(best.item.label);
    if (best.score <= FUSE_AUTO_CONFIRM || bestNorm === inputNorm) {
      await sendText(from, `✅ Usaremos *${best.item.label}*.`);
      await resolveFuzzySelection(from, s, action, best.item.label);
      return true;
    }
  }

  const closeMatches = results.filter(r => r.score <= FUSE_REJECT_LIMIT);

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
    return true;
  }
}

async function cotizarMaritimo({ origen, modalidad, wm=null, m3=null }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_MARITIMOS, "A1:Z10000", ["maritimos","marítimos","martimos","mar"]);
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

  const esVoluminoso = (m3 && m3 >= 5 && m3 <= 10);
  const iPrecio = (esVoluminoso && iPrecioVoluminoso !== -1) ? iPrecioVoluminoso : iPrecioNormal;

  const base = toNum(row[iPrecio]);
  const total = (wm && /lcl/i.test(modalidad)) ? (base * wm) : base;

  const diasTransito = (iTiempoTransito !== -1 && row[iTiempoTransito])
    ? toNum(row[iTiempoTransito])
    : null;

  return { modalidad, totalUSD: total, destino: "Puerto de Buenos Aires", tarifaBase: base, wm, diasTransito, esVoluminoso };
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
    const toneladas = Number(s.lcl_tn) || 0;
    const m3 = Number(s.lcl_m3) || 0;
    const wm = Math.max(toneladas, m3);
    if (toneladas > 15) sugerencias.push(`⚠️ ${toneladas.toFixed(1)} t supera el límite usual de LCL (15t). Te conviene FCL para evitar restricciones de manipulación.`);
    if (m3 >= 28 || wm >= 22) sugerencias.push(`💡 Con ${m3.toFixed(1)} m³ / ${wm.toFixed(1)} W/M, conviene FCL 40' (cap. ~67 m³). Mejor costo por unidad y menor manipulación.`);
    else if (m3 >= 12 && m3 < 28) sugerencias.push(`💡 Con ${m3.toFixed(1)} m³, pasamos directo a FCL 20' (cap. ~33 m³). Suele ser más competitivo que LCL en este rango.`);
    else if (wm > 20) sugerencias.push(`💡 Con ${wm.toFixed(1)} W/M, te conviene un 40' completo (hasta ~67 m³). Más económico y espacio exclusivo.`);
    else if (wm > 10 && wm <= 20) sugerencias.push(`💡 Tu carga ocupa ${wm.toFixed(1)} W/M. Un 20' completo puede costar similar y te da hasta ~33 m³ exclusivos.`);
    if (toneladas >= 30) {
      const numContenedores = Math.ceil((toneladas * 1000) / 26000);
      sugerencias.push(`💡 ${toneladas.toFixed(1)} t requiere ≈${numContenedores} contenedores 40' por límites de peso. Cotizamos FCL múltiple para optimizar tarifa.`);
    }
  }

  if (s.modo === "aereo" && s.aereo_tipo === "carga_general") {
    const kg = Number(s.peso_kg) || 0;
    const volCbm = Number(s.vol_cbm) || 0;
    if (kg > 2000) sugerencias.push(`💡 ${kg} kg por aéreo es muy costoso. Marítimo puede ahorrarte 60-70% (con +30-35 días de tránsito).`);
    else if (kg > 1000) sugerencias.push(`💡 Con ${kg} kg, marítimo puede ser significativamente más económico. Si no es urgente, puede valerte la pena.`);
    else if (kg > 500) sugerencias.push(`💡 ${kg} kg está en el límite. Si tu envío no es urgente, marítimo puede ahorrarte 40-50% del costo.`);
    if (volCbm >= 3 || kg >= 800) sugerencias.push(`💡 ${volCbm.toFixed(1)} m³ / ${kg} kg por aéreo suele ser muy caro salvo urgencia. Evaluá marítimo (o dividir envíos).`);
    const pesoVol = volCbm * 167;
    if (kg > 0 && pesoVol / kg > 2.5) sugerencias.push(`⚠️ Aéreo cobra ${pesoVol.toFixed(0)} kg vol. vs ${kg} kg reales. Marítimo puede ser mucho más económico.`);
  }

  return sugerencias.slice(0, 2);
}

/* ========= Cálculo de distancia con IA ========= */
async function calcularDistanciaAproximada(origen, destino) {
  if (!anthropic) return null;
  const prompt = `Calculá la distancia aproximada en kilómetros entre estas dos ubicaciones en Argentina:\n- Origen: ${origen}\n- Destino: ${destino}\n\nRespondé SOLO con el número de kilómetros (sin texto adicional, sin "km").\nEjemplo: 650`;
  try {
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 50,
      messages: [{ role: "user", content: prompt }]
    });
    const texto = response.content[0].text.trim();
    const km = parseInt(texto.replace(/[^\d]/g, ''));
    if (isNaN(km) || km <= 0) return null;
    return km;
  } catch(e) {
    console.error("❌ Error calculando distancia:", e?.message || e);
    return null;
  }
}

/* ========= Procesamiento Cotización Nacional ========= */
async function procesarCotizacionNacional(from, s) {
  try {
    await sendTypingIndicator(from, 2500);
    const distanciaKm = await calcularDistanciaAproximada(s.origen_direccion, s.nacional_destino);
    if (distanciaKm) s.distancia_km = distanciaKm;

    const rows = await readTabRange(TAR_SHEET_ID, TAB_NACIONAL, "A1:Z10000", ["nacional","ltl"]);
    if (!rows || rows.length < 2) {
      // v4.1: error con botón volver
      await sendButtons(from,
        "❌ No pude cargar las tarifas. Probá de nuevo más tarde.",
        [{ id:"menu_si", title:"🏠 Volver al menú" }]
      );
      return;
    }

    const header = rows[0];
    const data = rows.slice(1);
    const iDest = headerIndex(header, "destino", "ciudad");
    const iValorTN = headerIndex(header, "valor tn", "valor ton");
    const iValorM3 = headerIndex(header, "valor m3", "valor m³");
    const iMinimo = headerIndex(header, "minimo", "mínimo", "minimo a despachar");

    const row = data.find(r => norm(r[iDest]) === norm(s.nacional_destino));
    if (!row) {
      await sendButtons(from,
        `❌ No encontré tarifa para *${s.nacional_destino}*.\nContactá a hola@conektarsa.com`,
        [{ id:"menu_si", title:"🏠 Volver al menú" }]
      );
      return;
    }

    const valorTN = toNum(row[iValorTN]);
    const valorM3 = toNum(row[iValorM3]);
    const minimo = toNum(row[iMinimo]);

    if (isNaN(valorTN) || isNaN(valorM3) || isNaN(minimo)) {
      await sendButtons(from,
        "❌ Error en los valores de tarifa. Contactá a hola@conektarsa.com",
        [{ id:"menu_si", title:"🏠 Volver al menú" }]
      );
      return;
    }

    const costoTN = s.nacional_tn * valorTN;
    const costoM3 = s.nacional_m3 * valorM3;
    const total = Math.max(costoTN, costoM3, minimo);

    const lineas = [
      "🚚 *Cotización Flete Nacional*",
      "",
      `📦 *Carga:* ${fmt(s.nacional_m3)} m³ / ${fmt(s.nacional_tn)} TN`,
      `📍 *Origen:* ${s.origen_direccion}`,
      `📍 *Destino:* ${s.nacional_destino}`,
    ];
    if (s.distancia_km) lineas.push(`📏 *Distancia:* ${fmt(s.distancia_km)} km`);
    if (s.fecha_transporte) lineas.push(`📅 *Fecha de envío:* ${s.fecha_transporte}`);
    lineas.push("", `💰 *Total:* $ ${fmtARS(total)}`, "", "_Valor no incluye IVA_", "⚠️ *Cotización orientativa*", "❌ *No incluye* carga/descarga", "", `*Validez:* ${VALIDEZ_DIAS} días`);

    await sendText(from, lineas.join("\n"));

    await logSolicitud([
      new Date().toISOString(), from, "", s.empresa, "whatsapp", "flete_nacional",
      `${s.nacional_m3}m³/${s.nacional_tn}tn`, s.nacional_destino, s.origen_direccion,
      "", "", total, `Nacional: ${s.origen_direccion} → ${s.nacional_destino}`
    ]);

    await endFlow(from);
  } catch(e) {
    console.error("Error en procesarCotizacionNacional:", e);
    await sendButtons(from,
      "❌ Hubo un error procesando tu cotización. Probá de nuevo más tarde.",
      [{ id:"menu_si", title:"🏠 Volver al menú" }]
    );
  }
}

/* ========= Clasificación automática de productos ========= */
function similarity(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }
  return matrix[b.length][a.length];
}

function extraerPalabrasClave(texto) {
  const stopwords = ['el', 'la', 'de', 'en', 'un', 'una', 'para', 'con', 'por', 'del', 'los', 'las', 'y', 'o', 'que'];
  const palabras = norm(texto).split(/[\s,;.]+/).filter(p => p.length > 2 && !stopwords.includes(p));
  return [...new Set(palabras)];
}

async function buscarProductoEnTags(palabrasClave) {
  try {
    const M = await getMatrix();
    if (!M || M.length === 0) return [];
    const resultados = [];
    for (const fila of M) {
      const tagsRaw = fila.TAGS || "";
      const tags = tagsRaw.split(/[,;]+/).map(t => norm(t.trim())).filter(Boolean);
      if (tags.length === 0) continue;
      let score = 0;
      let matches = [];
      for (const palabra of palabrasClave) {
        const pNorm = norm(palabra);
        if (tags.includes(pNorm)) { score += PUNTOS_MATCH.MATCH_EXACTO; matches.push(palabra); continue; }
        if (tags.some(t => t.includes(pNorm) || pNorm.includes(t))) { score += PUNTOS_MATCH.MATCH_PARCIAL; matches.push(palabra); continue; }
        if (pNorm.length >= 5) {
          const raizPalabra = pNorm.substring(0, 5);
          const matchRaiz = tags.some(t => t.length >= 5 && t.substring(0, 5) === raizPalabra);
          if (matchRaiz) { score += PUNTOS_MATCH.MATCH_PARCIAL; matches.push(palabra); continue; }
        }
        for (const tag of tags) {
          const sim = similarity(pNorm, tag);
          if (sim >= 0.85) { score += PUNTOS_MATCH.MATCH_FUZZY_85; matches.push(palabra); break; }
          else if (sim >= 0.70) { score += PUNTOS_MATCH.MATCH_FUZZY_70; break; }
        }
      }
      if (score > 0) {
        resultados.push({
          fila, score,
          matches: [...new Set(matches)],
          categoria: fila.SUB || fila.NIV3 || fila.NIV2 || "",
          clasificacion: [fila.NIV1, fila.NIV2, fila.NIV3].filter(Boolean).join(" → ")
        });
      }
    }
    resultados.sort((a, b) => b.score - a.score);
    return resultados;
  } catch (err) {
    console.error("ERROR buscarProductoEnTags:", err);
    return [];
  }
}

async function extraerInfoDesdeURL(url) {
  try {
    let urlObj;
    try { urlObj = new URL(url); } catch { return { error: "URL_INVALIDA", mensaje: "El link no es válido. Asegurate de copiar el link completo." }; }
    const dominio = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    const permitido = DOMINIOS_PERMITIDOS.some(d => dominio === d || dominio.endsWith('.' + d));
    if (!permitido) return { error: "DOMINIO_NO_PERMITIDO", mensaje: `⚠️ No reconozco ese sitio web.\n\nPor seguridad, solo analizo links de:\n• MercadoLibre\n• AliExpress\n• Amazon\n• Alibaba\n• eBay\n• Páginas del fabricante verificadas` };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConektarBot/1.0)' } });
    clearTimeout(timeoutId);
    if (!response.ok) return { error: "NO_ACCESIBLE", mensaje: "❌ No pude acceder a ese link.\n\nPuede que:\n• El producto ya no exista\n• El link esté incompleto\n• El sitio no responda" };

    const html = await response.text();
    let titulo = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
    let descripcion = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || "";
    let palabrasClave = [];

    if (anthropic) {
      try {
        const htmlLimpio = html.substring(0, 5000).replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        const prompt = `Analiza este HTML de una página de producto de e-commerce y extrae:\n1. El nombre del producto\n2. Palabras clave (máximo 5-8)\n\nHTML:\n${htmlLimpio}\n\nResponde SOLO con JSON:\n{\n  "titulo": "nombre del producto",\n  "palabras_clave": ["palabra1", "palabra2"]\n}`;
        const message = await anthropic.messages.create({ model: "claude-3-5-haiku-20241022", max_tokens: 500, messages: [{ role: "user", content: prompt }] });
        const respuestaTexto = message.content[0].text;
        const jsonMatch = respuestaTexto.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const resultado = JSON.parse(jsonMatch[0]);
          if (resultado.titulo) titulo = resultado.titulo;
          if (resultado.palabras_clave && Array.isArray(resultado.palabras_clave)) palabrasClave = resultado.palabras_clave.map(p => norm(p)).filter(Boolean);
        }
      } catch (claudeErr) { console.error("ERROR Claude API:", claudeErr); }
    }

    if (palabrasClave.length === 0) palabrasClave = extraerPalabrasClave(titulo + " " + descripcion);
    if (palabrasClave.length === 0) return { error: "SIN_INFO_UTIL", mensaje: "🔍 Abrí el link pero no encontré info del producto." };
    return { ok: true, titulo: titulo.substring(0, 100), palabrasClave, url };
  } catch (err) {
    if (err.name === 'AbortError') return { error: "TIMEOUT", mensaje: "⏱️ El sitio tardó demasiado en responder. Intentá de nuevo o probá con otro método." };
    console.error("ERROR extraerInfoDesdeURL:", err);
    return { error: "ERROR_GENERICO", mensaje: "❌ Hubo un error al analizar el link. Probá con otro método." };
  }
}

async function analizarImagenProducto(imagenUrl) {
  if (!anthropic) return { ok: false, error: "NO_CONFIGURADO", mensaje: "📸 El análisis de imágenes requiere configurar ANTHROPIC_API_KEY." };
  try {
    const response = await fetch(imagenUrl, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
    if (!response.ok) return { ok: false, error: "NO_ACCESIBLE", mensaje: "❌ No pude acceder a la imagen. Intentá enviarla de nuevo." };
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const mediaType = contentType.includes('png') ? 'image/png' : contentType.includes('gif') ? 'image/gif' : contentType.includes('webp') ? 'image/webp' : 'image/jpeg';

    const message = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: `Analiza esta imagen de un producto y extrae:\n1. Nombre del producto\n2. Palabras clave (5-10)\n3. Si es apropiada para análisis comercial\n4. Si el producto es complejo\n\nResponde SOLO con JSON:\n{\n  "apropiada": true/false,\n  "producto": "nombre",\n  "palabras_clave": ["palabra1"],\n  "complejidad": "baja/media/alta",\n  "requiere_asesor": true/false\n}` }
        ]
      }]
    });

    const respuestaTexto = message.content[0].text;
    const jsonMatch = respuestaTexto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: "ERROR_ANALISIS", mensaje: "❌ No pude analizar la imagen correctamente. Intentá con otra foto más clara." };
    const resultado = JSON.parse(jsonMatch[0]);
    if (!resultado.apropiada) return { ok: false, error: "IMAGEN_INAPROPIADA", mensaje: "⚠️ La imagen no muestra un producto claro.\n\nPor favor:\n✓ Enviá una foto del producto\n✓ Con buena iluminación\n✓ Que se vea completo" };

    const palabrasClave = (resultado.palabras_clave || []).map(p => norm(p)).filter(Boolean);
    return { ok: true, producto: resultado.producto || "", palabrasClave, complejidad: resultado.complejidad || "media", requiere_asesor: resultado.requiere_asesor || false };
  } catch (err) {
    console.error("ERROR analizarImagenProducto:", err);
    return { ok: false, error: "ERROR_GENERICO", mensaje: "❌ Hubo un error al analizar la imagen. Probá con otro método o contactá a un asesor." };
  }
}

/* ========= Estado ========= */
const sessions = new Map();
const emptyState = () => ({
  empresa:null, welcomed:false, askedEmpresa:false, step:"start",
  modo:null, maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_pf:null,
  terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  lcl_tn:null, lcl_m3:null, lcl_apilable:null,
  flow:null, producto_desc:null, categoria:null, matriz:null,
  fob_unit:null, cantidad:null, fob_total:null,
  calc_modo:null, calc_maritimo_tipo:null, calc_contenedor:null,
  sel_n1:null, sel_n2:null, sel_n3:null,
  _tree:null, _find:null, _matches:null,
  _fuzzy:null, _fuzzyPrevStep:null,
  email:null,
  local_cap:null, local_tipo:null, local_dist:null,
  nacional_destino:null, nacional_m3:null, nacional_tn:null, distancia_km:null,
  fecha_transporte:null,
});
async function getS(id){
  if(!sessions.has(id)) {
    sessions.set(id, { data: { ...emptyState() } });
    const empresa = await getUserEmpresa(id);
    if (empresa) {
      const s = sessions.get(id);
      if (s) { s.data.empresa = empresa; s.data.askedEmpresa = true; }
    }
  }
  return sessions.get(id);
}

/* ========= Matriz ========= */
async function readMatrix() {
  if (!TAR_SHEET_ID) return [];
  const rows = await readTabRange(TAR_SHEET_ID, TAB_CLASIFICACION, "A1:Z10000", ["clasificacion","clasificación"]);
  if (!rows.length) return [];
  const header = rows[0].map(h => (h||"").toString().trim());
  const find = (...lbl) => header.findIndex(h => lbl.map(x=>x.toLowerCase()).some(t => h.toLowerCase()===t || h.toLowerCase().includes(t)));

  const idx = {
    NIV1: find("NIVEL_1","NIVEL 1"), NIV2: find("NIVEL_2","NIVEL 2"), NIV3: find("NIVEL_3","NIVEL 3"),
    SUB : find("SUBCATEGORIA","SUBCATEGORÍA","PRODUCTO","SUBCATEGORIA/PRODUCTO"),
    TAGS: find("TAGS","TAG","ETIQUETAS"),
    TASA: find("Tasa Estadisti","Tasa Estadistica","Tasa Estadística"),
    IVA : find("% IVA","IVA","IVA %"), IVA_A:find("% IVA ADIC","IVA ADICIONAL","IVA ADIC"),
    DI  : find("DERECHOS IM","% DERECHOS","DERECHOS"), IIBB: find("% IIBB","IIBB"),
    IIGG: find("% IIGG","IIGG"), INT : find("IMPUESTOS INTE","IMPUESTOS INT","INTERNOS"),
    NOTA: find("NOTAS","OBS","NOTAS / IMPUESTOS_IMPO","IMPUESTOS_IMPO")
  };

  const data = rows.slice(1).map(r => ({
    NIV1: r[idx.NIV1] || "", NIV2: r[idx.NIV2] || "", NIV3: r[idx.NIV3] || "", SUB : r[idx.SUB]  || "",
    TAGS: (r[idx.TAGS] || "").toString(),
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
    niv1: (r.NIV1||"").toString(), niv2: (r.NIV2||"").toString(),
    niv3: (r.NIV3||"").toString(), sub : (r.SUB ||"").toString(),
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
  "¿Cómo querés buscar tu producto?",
  [
    { id:"calc_link_desc", title:"🔗 Link o Descrip." },
    { id:"calc_foto",      title:"📸 Imagen/Foto" },
    { id:"calc_cat",       title:"🔎 Categorías" }
  ]
);
const listFrom = (arr, pref) => arr.slice(0,10).map((t,i)=>({ id:`${pref}_${i}`, title: clip24(t) }));

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
      await sendTypingIndicator(from, 1500);

      if (s.empresa) {
        const horaArgentina = new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires", hour: "numeric", hour12: false });
        const hora = parseInt(horaArgentina);
        const saludo = hora >= 6 && hora < 12 ? "Buenos días" : hora >= 12 && hora < 20 ? "Buenas tardes" : "Buenas noches";
        await sendText(from, `${saludo} *${s.empresa}*! 😀\n\n¡Qué bueno leerte de nuevo!\n\n_💡 Escribí *menu* en cualquier momento para volver al inicio._`);
        await sendTypingIndicator(from, 800);
        await sendMainActions(from);
        s.step = "main";
      } else {
        await sendText(from, WELCOME_TEXT);
        await sendTypingIndicator(from, 1000);
        await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
        s.step = "ask_empresa";
        s.askedEmpresa = true;
      }
    };

    if (!s.welcomed) { await showWelcomeOnce(); return res.sendStatus(200); }

    // Comandos globales
    if (type==="text" && ["menu","inicio","start","volver","reset"].includes(lower)) {
      if (lower==="inicio" || lower==="reset") { sessions.delete(from); await getS(from); }
      else { s.step = "main"; s.flow = null; }
      await sendMainActions(from);
      return res.sendStatus(200);
    }

    // v4.1: ayuda ahora muestra el menú después
    if (type==="text" && ["ayuda","help","?"].includes(lower)) {
      await sendText(from,
        `📌 *Comandos útiles:*\n\n` +
        `• Escribí *menu* para volver al menú principal\n` +
        `• Escribí *inicio* para reiniciar la conversación\n` +
        `• Escribí *ayuda* para ver estos comandos`
      );
      await sendMainActions(from);
      return res.sendStatus(200);
    }

    /* ===== INTERACTIVE ===== */
    if (type==="interactive") {

      if (btnId==="action_amba" || btnId==="action_local"){
        await sendTypingIndicator(from, 800);
        s.flow="local"; s.step="local_cap";
        const caps = ["1 Pallet - 2 m3 -500 Kg","3 Pallet - 9 m3 - 1500 Kg","6 Pallet - 14 m3 - 3200 Kg","12 Pallet - 20 m3 - 10 TN","20' ST","40' ST","40' HC"];
        s._localCaps = caps;
        await sendList(from, "Elegí *Capacidad*:" + HINT_MENU, listFrom(caps,"cap"), "Capacidad", "Elegir");
      }
      else if (btnId==="action_nacional"){
        await sendTypingIndicator(from, 800);
        s.flow="nacional"; s.step="nacional_m3";
        await sendText(from,`📦 *Flete Nacional*\n\nIngresá los *metros cúbicos (m³)* de tu carga.\n\nEjemplo: 3.5${HINT_MENU}`);
      }
      else if (btnId==="action_mas"){
        await sendTypingIndicator(from, 800);
        await sendMasServicios(from);
      }
      else if (btnId==="action_internacional" || btnId==="action_cotizar"){
        await sendTypingIndicator(from, 800);
        await sendText(from, "⚠️ *Importante:*\nLas tarifas mostradas son estimativas y no constituyen una cotización formal.\n\nRecibirás una cotización oficial por correo de parte de nuestro equipo.");
        s.flow=null; s.step="choose_modo"; await sendModos(from);
      }
      else if (btnId==="action_calculadora" || btnId==="action_calcular"){
        await sendTypingIndicator(from, 800);
        s.flow="calc"; s.step="calc_prod_m"; await askProdMetodo(from);
      }

      if (btnId==="menu_si"){
        s.step = "main"; s.flow = null;
        await sendMainActions(from);
      }
      else if (btnId==="menu_no"){
        await sendText(from,"¡Gracias! Si necesitás algo más, escribinos cuando quieras.");
        sessions.delete(from);
      }

      else if (btnId.startsWith("menu_") && btnId !== "menu_si" && btnId !== "menu_no"){
        await sendTypingIndicator(from, 800);
        s.modo = btnId.replace("menu_","");
        if (s.modo==="maritimo"){ s.step="mar_tipo"; await sendTiposMaritimo(from); }
        if (s.modo==="aereo"){
          s.step="aereo_subtipo";
          await sendButtons(from, "✈️ *Aéreo:* ¿Qué necesitás cotizar?", [
            { id:"aer_carga",   title:"Carga gral." },
            { id:"aer_courier", title:"Courier" }
          ]);
        }
        if (s.modo==="terrestre"){ s.terrestre_tipo="FTL"; s.step="ter_origen"; await sendText(from,`🚛 *Terrestre Full (Camión completo):* Indicá ciudad.${HINT_MENU}`); }
      }
      else if (btnId==="mar_LCL"){
        s.maritimo_tipo = "LCL"; s.lcl_tn = null; s.lcl_m3 = null; s.lcl_apilable = null;
        s.step="lcl_tn";
        await sendText(from,`⚖️ Ingresá las *TONELADAS* totales (ej.: 2.5)${HINT_MENU}`);
      }
      else if (btnId==="mar_FCL"){
        s.maritimo_tipo = "FCL"; s.step="mar_equipo"; await sendContenedores(from);
      }
      else if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        const cont = btnId==="mar_FCL20" ? "20" : btnId==="mar_FCL40" ? "40" : "40HC";
        if (s.flow === "calc") {
          s.calc_maritimo_tipo = "FCL"; s.calc_contenedor = cont; s.step = "c_mar_origen";
          await sendText(from, `📍 *Puerto de ORIGEN* (ej.: Houston / Shanghai / Hamburgo).${HINT_MENU}`);
        } else {
          s.maritimo_tipo = "FCL"; s.contenedor = cont; s.lcl_tn = null; s.lcl_m3 = null; s.lcl_apilable = null;
          s.step = "mar_origen";
          await sendText(from,`📍 *Puerto de ORIGEN* (ej.: Houston / Shanghai / Hamburgo).${HINT_MENU}`);
        }
      }
      else if (btnId==="lcl_api_si"){ s.lcl_apilable = "Sí"; s.step="mar_origen"; await sendText(from,`📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).${HINT_MENU}`); }
      else if (btnId==="lcl_api_no"){ s.lcl_apilable = "No"; s.step="mar_origen"; await sendText(from,`📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).${HINT_MENU}`); }
      else if (btnId==="lcl_api_ns"){ s.lcl_apilable = "No lo sé (cotizado como apilable)"; s.step="mar_origen"; await sendText(from,`📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).\n\n_Nota: La carga se cotizará como apilable.${HINT_MENU}`); }
      else if (btnId==="aer_carga" || btnId==="aer_courier"){
        s.aereo_tipo = btnId==="aer_carga" ? "carga_general" : "courier";
        if (s.aereo_tipo==="carga_general"){ s.step="aer_origen"; await sendText(from,`✈️ *AEROPUERTO ORIGEN* (IATA o ciudad. Ej.: PVG / Shanghai).${HINT_MENU}`); }
        else { s.step="courier_pf"; await sendButtons(from,"Para *Courier*, ¿quién importa?",[{id:"pf","title":"👤 Persona Física"},{id:"emp","title":"🏢 Empresa"}]); }
      }
      else if (btnId==="pf" || btnId==="emp"){
        s.courier_pf = btnId==="pf" ? "PF" : "EMP";
        s.step="courier_origen"; await sendText(from,`🌍 *País/Ciudad ORIGEN* (ej.: España / China / USA).${HINT_MENU}`);
      }

      else if (btnId.startsWith("fz_")) {
        const parts = btnId.split("_");
        const kind = parts[1] || "";
        const target = parts.slice(2).join("_") || "";
        const state = s._fuzzy;
        const label = kind === "air" ? "aeropuerto" : "puerto";
        if (!state || state.kind !== kind) {
          await sendButtons(from,
            `La selección expiró. Volvé a ingresar el ${label} o volvé al menú.`,
            [{ id:"menu_si", title:"🏠 Menú principal" }]
          );
          return res.sendStatus(200);
        }

        const prevStep = s._fuzzyPrevStep || s.step;
        s._fuzzy = null; s._fuzzyPrevStep = null; s.step = prevStep;

        let value = state.query;
        if (target !== "manual") {
          const idx = Number(target);
          if (!Number.isNaN(idx) && state.options?.[idx]) {
            value = state.options[idx].label;
            await sendText(from, `✅ Elegiste *${value}*.`);
          } else {
            await sendButtons(from,
              `⚠️ No pude identificar la opción. Intentá nuevamente o volvé al menú.`,
              [{ id:"menu_si", title:"🏠 Menú principal" }]
            );
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
        await sendText(from, `✈️ Escribí el *AEROPUERTO ORIGEN* nuevamente (IATA o ciudad. Ej.: FRA / Frankfurt).${HINT_MENU}`);
        return res.sendStatus(200);
      }
      else if (btnId === "retry_mar_origen") {
        s.step = "mar_origen";
        await sendText(from, `📍 Escribí el *PUERTO DE ORIGEN* nuevamente (ej.: Shanghai / Hamburg).${HINT_MENU}`);
        return res.sendStatus(200);
      }
      else if (btnId.startsWith("fz_") && btnId.endsWith("_retry")) {
        const kind = btnId.includes("air") ? "air" : "sea";
        const label = kind === "air" ? "aeropuerto" : "puerto";
        s.step = s._fuzzyPrevStep || (kind === "air" ? "aer_origen" : "mar_origen");
        s._fuzzy = null;
        await sendText(from, `Escribí el ${label} nuevamente:${HINT_MENU}`);
        return res.sendStatus(200);
      }
      else if (btnId==="confirmar"){ s.step="cotizar"; }
      else if (btnId==="editar"){ await sendMainActions(from); s.step="main"; }
      else if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); }

      else if (btnId==="exw_si"){ s.step="exw_dir"; await sendText(from,`📍 *Dirección EXW* (calle, ciudad, CP, país).${HINT_MENU}`);
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","exw_si","","","","","","Cliente indicó EXW = Sí"]);
      }
      else if (btnId==="exw_no"){ s.step="upsell";
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","exw_no","","","","","","Cliente indicó EXW = No"]);
        await upsellDespacho(from);
      }
      else if (btnId==="desp_si"){ await sendText(from,"¡Genial! Nuestro equipo te contactará para cotizar el despacho. 🙌");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","despachante_si","","","","","","Solicitó cotización de despacho"]);
        await endFlow(from);
      }
      else if (btnId==="desp_no"){ await sendText(from,"¡Gracias por tu consulta! 🙌");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","despachante_no","","","","","","No desea cotización de despacho"]);
        await endFlow(from);
      }

      // Calculadora
      else if (btnId==="calc_link_desc"){
        s.step="calc_link_desc_wait";
        await sendText(from,`🔗📝 Pegá el *link del producto* o escribí una *descripción*\n\nEjemplos:\n• https://www.aliexpress.com/item/...\n• termo stanley 1 litro\n• auriculares bluetooth sony${HINT_MENU}`);
      }
      else if (btnId==="calc_foto"){
        await sendText(from,`📸 *Enviá una foto de tu producto*\n\n💡 Consejos:\n✓ Que se vea clara\n✓ Con buena luz\n✓ De frente o con etiquetas visibles${HINT_MENU}`);
        s.step="calc_foto_wait";
      }
      else if (btnId==="calc_clasif_ok"){
        s.step="calc_fob_unit";
        await sendText(from,`💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).${HINT_MENU}`);
      }
      else if (btnId==="calc_clasif_cambiar"){
        await askProdMetodo(from); s.step="calc_prod_m";
      }
      else if (btnId==="calc_cat"){
        const M = await getMatrix();
        const V = indexMatrix(M);
        const n1 = [...new Set(V.filter(x => x.niv1).map(x => x.niv1))].filter(Boolean);
        if (!n1.length) { await sendButtons(from, "⚠️ No encontré industrias. Usá 'Descripción'.", [{id:"menu_si", title:"🏠 Menú"}]); return res.sendStatus(200); }
        await sendList(from, `Elegí *Nivel 1: Industria*:${HINT_MENU}`, listFrom(n1,"n1"), "Nivel 1: Industria", "Elegir");
        s._tree = { V, n1 }; s.step="calc_n1_pick";
      }
      else if (/^n1_\d+$/.test(btnId) && s.step==="calc_n1_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n1 = label;
        const V = s._tree.V;
        const n2 = [...new Set(V.filter(x => (norm(x.niv1).includes(norm(label)) || norm(label).includes(norm(x.niv1))) && x.niv2).map(x => x.niv2))].filter(Boolean);
        if (!n2.length) { await sendButtons(from, "⚠️ No encontré sectores para esta industria.", [{id:"menu_si", title:"🏠 Menú"}]); s.step = "start"; return res.sendStatus(200); }
        await sendList(from, `Elegí *Nivel 2: Sector*:${HINT_MENU}`, listFrom(n2,"n2"), "Nivel 2: Sector", "Elegir");
        s._tree.n2 = n2; s.step="calc_n2_pick";
      }
      else if (/^n2_\d+$/.test(btnId) && s.step==="calc_n2_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n2 = label;
        const V = s._tree.V;
        const n3 = [...new Set(V.filter(x => (norm(x.niv1).includes(norm(s.sel_n1)) || norm(s.sel_n1).includes(norm(x.niv1))) && norm(x.niv2) === norm(label) && x.niv3).map(x => x.niv3))].filter(Boolean);
        if (!n3.length) { await sendButtons(from, "⚠️ No encontré categorías para este sector.", [{id:"menu_si", title:"🏠 Menú"}]); s.step = "start"; return res.sendStatus(200); }
        await sendList(from, `Elegí *Nivel 3: Categoría*:${HINT_MENU}`, listFrom(n3,"n3"), "Nivel 3: Categoría", "Elegir");
        s._tree.n3 = n3; s.step="calc_n3_pick";
      }
      else if (/^n3_\d+$/.test(btnId) && s.step==="calc_n3_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n3 = label;
        const V = s._tree.V;
        const subs = [...new Set(V.filter(x => (norm(x.niv1).includes(norm(s.sel_n1)) || norm(s.sel_n1).includes(norm(x.niv1))) && norm(x.niv2) === norm(s.sel_n2) && norm(x.niv3) === norm(label) && x.sub).map(x => x.sub))].filter(Boolean);
        if (!subs.length) { await sendButtons(from, "⚠️ No encontré productos para esta categoría.", [{id:"menu_si", title:"🏠 Menú"}]); s.step = "start"; return res.sendStatus(200); }
        await sendList(from, `Elegí *Nivel 4: Producto / Subcategoría*:${HINT_MENU}`, listFrom(subs,"sub"), "Nivel 4: Producto", "Elegir");
        s._tree.subs = subs; s.step="calc_sub_pick";
      }
      else if (/^sub_\d+$/.test(btnId) && s.step === "calc_sub_pick") {
        const label = msg.interactive?.list_reply?.title || "";
        const clipSel = clip24(label), clipN1 = clip24(s.sel_n1 || ""), clipN2 = clip24(s.sel_n2 || ""), clipN3 = clip24(s.sel_n3 || "");
        const M = await getMatrix();
        const fila = M.find(row => clip24(row.SUB || "") === clipSel && clip24(row.NIV1 || "") === clipN1 && clip24(row.NIV2 || "") === clipN2 && clip24(row.NIV3 || "") === clipN3);
        if (!fila) { await sendButtons(from, "⚠️ No encontré datos para este producto.", [{id:"menu_si", title:"🏠 Menú"}]); s.step = "start"; return res.sendStatus(200); }
        const categoria = fila.SUB || fila.NIV3 || label;
        s.matriz = fila; s.categoria = categoria; s.producto_desc = [s.sel_n3 || fila.NIV3, label || categoria].filter(Boolean).join(" / ") || categoria;
        s.step = "calc_fob_unit";
        await sendText(from, `💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).${HINT_MENU}`);
        return res.sendStatus(200);
      }
      else if (/^n3s_\d+$/.test(btnId) && s.step==="calc_find_n3_pick"){
        const title = msg.interactive?.list_reply?.title;
        s.sel_n3 = title;
        const { V } = s._find;
        const subs = distinct(V.filter(x=>x.niv3===title), x=>x.sub).filter(Boolean);
        await sendList(from, `Elegí *Nivel 4: Producto / Subcategoría*:${HINT_MENU}`, listFrom(subs,"subf"), "Nivel 4: Producto", "Elegir");
        s._find.subs = subs; s.step="calc_find_sub_pick";
      }
      else if (/^subf_\d+$/.test(btnId) && s.step==="calc_find_sub_pick"){
        const label = msg.interactive?.list_reply?.title;
        const M = await getMatrix();
        const fila = M.find(x => clip24(x.SUB)===clip24(label)) || M[0];
        s.matriz = fila; s.categoria = label; s.producto_desc = `${s.sel_n3} / ${label}`;
        s.step="calc_fob_unit";
        await sendText(from,`💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).${HINT_MENU}`);
      }

      else if (btnId==="c_maritimo"){ s.calc_modo="maritimo"; s.step="c_mar_tipo"; await sendButtons(from,"Marítimo: ¿LCL o FCL?",[{id:"c_lcl",title:"LCL"},{id:"c_fcl",title:"FCL"}]); }
      else if (btnId==="c_aereo"){ s.calc_modo="aereo"; s.step="c_aer_origen"; await sendText(from, `✈️ *Aeropuerto de ORIGEN*\n\nEjemplos:\n• Shanghai / PVG\n• Miami / MIA\n• Frankfurt / FRA${HINT_MENU}`); }
      else if (btnId==="c_lcl"){ s.calc_maritimo_tipo="LCL"; s.step="c_mar_origen"; await sendText(from, `📍 *Puerto de ORIGEN* (ej.: Houston / Shanghai / Hamburgo).${HINT_MENU}`); }
      else if (btnId==="c_fcl"){ s.calc_maritimo_tipo="FCL"; s.step="c_cont"; await sendContenedores(from); }
      else if (btnId==="calc_edit"){ s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); }
      else if (btnId==="calc_go"){
        await sendTypingIndicator(from, 3000);
        const M = s.matriz || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa_est:TASA_ESTATISTICA, nota:"" };
        let fleteUSD = 0, fleteDetalle = "";
        try{
          if (s.calc_modo==="aereo"){
            const r = await cotizarAereo({ origen: s.origen_aeropuerto || "Shanghai", kg: s.peso_kg||0, vol: (s.vol_cbm||0)*167 });
            if (r){ fleteUSD = r.totalUSD; fleteDetalle = `Flete ✈️ (Aéreo): USD ${fmtUSD(fleteUSD)}`; }
          } else if (s.calc_modo==="maritimo"){
            const modalidad = s.calc_maritimo_tipo==="FCL" ? (s.calc_contenedor?`FCL${s.calc_contenedor}`:"FCL") : "LCL";
            const wmCalc = s.calc_maritimo_tipo==="LCL" ? Math.max((s.lcl_tn||0), (s.vol_cbm||0)) : null;
            const r = await cotizarMaritimo({ origen: s.origen_puerto || "Shanghai", modalidad, wm: wmCalc, m3: s.calc_maritimo_tipo==="LCL" ? s.vol_cbm : null });
            if (r){ fleteUSD = r.totalUSD; const tiempoCalc = r.diasTransito ? ` • ${r.diasTransito} días` : ""; fleteDetalle = `Flete 🚢 (Marítimo ${modalidad}): USD ${fmtUSD(fleteUSD)}${tiempoCalc}`; }
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
          "📦 *Resultado estimado (FOB → CIF)*","",
          `FOB total: USD ${fmtUSD(s.fob_total)} (${s.cantidad||0} u. × ${fmtUSD(s.fob_unit||0)})`,
          `${fleteDetalle || "Flete: *sin tarifa* (seguimos el cálculo y te contactamos)"}`,
          `Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmtUSD(insurance)}`,
          "━━━━━━━━━━━━━━━",
          `CIF: USD ${fmtUSD(cif)}`, "",
          "🏛️ *Impuestos*",
          `DI (${((M.di||0)*100).toFixed(1)}%): USD ${fmtUSD(di)}`,
          `Tasa Estadística (${((M.tasa_est ?? TASA_ESTATISTICA)*100).toFixed(1)}% CIF): USD ${fmtUSD(tasa)}`,
          `IVA (${((M.iva||0)*100).toFixed(1)}%): USD ${fmtUSD(iva)}`,
          `IVA Adic. (${((M.iva_ad||0)*100).toFixed(1)}%): USD ${fmtUSD(ivaAd)}`,
          `IIBB (${((M.iibb||0)*100).toFixed(1)}%): USD ${fmtUSD(iibb)}`,
          `IIGG (${((M.iigg??RATE_IIGG)*100).toFixed(1)}%): USD ${fmtUSD(iigg)}` + ((M.internos||0)>0?`\nInternos (${(M.internos*100).toFixed(1)}%): USD ${fmtUSD(internos)}`:""),
          "━━━━━━━━━━━━━━━",
          `📊 Total impuestos: USD ${fmtUSD(impTotal)}`, "",
          "💰 *Costo final (CIF + imp.)*",
          `Costo aduanero: USD ${fmtUSD(costoAdu)}`, "",
          `➡️ Costo unitario final: USD ${fmtUSD((costoAdu/(s.cantidad||1))||0)}`,
          `📈 Incremento sobre FOB: +${(((costoAdu/(s.fob_total||1))-1)*100).toFixed(2)}%`, "",
          "📝 *Notas:*",
          ...(M.nota? M.nota.split("\n").map(x=>"* "+x.trim()) : []),
          "* No contempla gastos locales (liberación, despachante, almacenaje, etc.)."
        ].join("\n");

        await sendText(from, body);
        await logCalculo([
          new Date().toISOString(), from, s.empresa, (s.producto_desc||s.categoria||s.sel_n3||""), (s.matriz?.SUB||s.matriz?.NIV3||""),
          s.fob_unit, s.cantidad, s.fob_total, s.peso_kg, s.vol_cbm,
          s.calc_modo, s.calc_maritimo_tipo||"", s.calc_contenedor||"",
          insurance, fleteUSD, cif, di, tasa, iva, ivaAd, iibb, iigg, internos, impTotal, costoAdu
        ]);

        s.step = "ask_if_email";
        await sendButtons(from, "📧 ¿Deseás que te enviemos la cotización por correo?", [
          { id:"email_si", title:"✅ Sí" },
          { id:"email_no", title:"❌ No" }
        ]);
      }
      else if (btnId==="email_si"){
        s.step = "ask_email";
        await sendText(from, `Dejanos un *email corporativo* (ej.: nombre@empresa.com.ar).\n_(No se aceptan gmail, yahoo, hotmail, outlook)_${HINT_MENU}`);
      }
      else if (btnId==="email_no"){
        await sendText(from,"¡Gracias! Nuestro equipo te contactará a la brevedad.");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","email_rechazado", "", "", "", "", "", "", "Usuario no desea recibir email"]);
        await endFlow(from);
      }
      else if (/^rate_[1-5]$/.test(btnId)){
        const val = Number(btnId.split("_")[1]);
        await sendText(from,"¡Gracias por tu calificación! ⭐");
        await logRating(from, s.empresa, val);
        await sendButtons(from, "¿Querés hacer otra consulta?", [
          { id:"menu_si", title:"🏠 Volver al menú" },
          { id:"menu_no", title:"❌ Finalizar" }
        ]);
      }

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
        await sendList(from, `Elegí *Distancia*:${HINT_MENU}`, dists.map((d,i)=>({id:`ld_${i}`,title:d.title})), "Distancia", "Elegir");
        s._localDists = dists;
      }
      else if (/^ld_\d+$/.test(btnId) && s.flow==="local" && s.step==="local_dist"){
        const title = msg.interactive?.list_reply?.title || "";
        const distKey = s._localDists.find(x=>x.title===title)?.key || "CABA";
        s.local_dist = distKey;

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
        if (!row){
          await sendButtons(from,
            "❌ No encontré tarifa para esa combinación en *Flete Local*.",
            [{ id:"menu_si", title:"🏠 Volver al menú" }]
          );
          return res.sendStatus(200);
        }

        const col = distKey==="CABA"?iCABA:distKey==="BS30"?i30:distKey==="BS50"?i50:distKey==="BS70"?i70:i100;
        const monto = toNum(row[col]);

        s._local_monto = monto;
        s._local_distTitle = title;
        s._local_vehiculo = row[iVeh];

        const texto = [
          "🚛 *Cotización Flete AMBA*","",
          `📦 *Capacidad:* ${s.local_cap}`,
          `🏷️ *Tipo:* ${s.local_tipo==="refrig"?"Refrigerada":s.local_tipo==="pelig"?"IMO / Peligrosa":"Carga Seca"}`,
          `📍 *Distancia:* ${title}`,
          row[iVeh] ? `🚚 *Vehículo:* ${row[iVeh]}` : "",
          "", `💰 *Total:* $ ${fmtARS(monto)}`, "",
          "_Valor no incluye IVA_", "",
          `*Validez:* ${VALIDEZ_DIAS} días`
        ].filter(Boolean).join("\n");
        await sendText(from, texto);
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","flete_local", s.local_cap, title, "", "", s.local_tipo, monto, "Flete local"]);

        s.step = "local_fecha_ask";
        await sendButtons(from, "📅 ¿Querés programar una fecha de RETIRO?", [
          { id:"lfecha_si", title:"✅ Sí" },
          { id:"lfecha_no", title:"❌ No" }
        ]);
      }

      // === Flete Nacional ===
      else if (/^nreg_\d+$/.test(btnId) && s.flow==="nacional" && s.step==="nacional_region"){
        const regiones = ["Patagonia Norte", "Patagonia Atlántica", "Patagonia Sur", "Cuyo", "Centro", "NOA", "Pampeana", "Litoral"];
        const idx = Number(btnId.split("_")[1]);
        const regionSeleccionada = regiones[idx];
        s._regionSeleccionada = regionSeleccionada;
        const destinosRegion = s._destinosPorRegion[regionSeleccionada] || [];
        if (destinosRegion.length === 0) { await sendButtons(from, `❌ No hay destinos en ${regionSeleccionada}.`, [{id:"menu_si", title:"🏠 Menú"}]); return res.sendStatus(200); }
        s.step = "nacional_destino";
        const rows_list = destinosRegion.slice(0,10).map((d,i)=>({id:`ndest_${i}`, title:clip24(d)}));
        await sendList(from, `📍 Elegí la ciudad en *${regionSeleccionada}*:${HINT_MENU}`, rows_list, "Destinos", "Elegir");
      }
      else if (/^ndest_\d+$/.test(btnId) && s.flow==="nacional" && s.step==="nacional_destino"){
        const title = msg.interactive?.list_reply?.title || "";
        const destinosRegion = s._destinosPorRegion[s._regionSeleccionada] || [];
        const idx = Number(btnId.split("_")[1]);
        s.nacional_destino = destinosRegion[idx] || title;
        s.step = "nacional_origen";
        await sendText(from,`📍 Destino: *${s.nacional_destino}*\n\n¿Desde qué ciudad saldrá la carga?\n\nEjemplo: Buenos Aires${HINT_MENU}`);
      }
      else if (btnId==="nfecha_si" && s.flow==="nacional"){
        s.step = "nacional_fecha_input";
        await sendText(from,`📅 Ingresá la fecha deseada para el ENVÍO (ej.: 15/03/2025)${HINT_MENU}`);
      }
      else if (btnId==="nfecha_no" && s.flow==="nacional"){
        s.fecha_transporte = null;
        await procesarCotizacionNacional(from, s);
      }
      else if (btnId==="lfecha_si" && s.flow==="local"){
        s.step = "local_fecha_input";
        await sendText(from,`📅 Ingresá la fecha deseada para el RETIRO (ej.: 15/03/2025)${HINT_MENU}`);
      }
      else if (btnId==="lfecha_no" && s.flow==="local"){
        s.fecha_transporte = null;
        await endFlow(from);
      }

      if (s.step !== "cotizar") return res.sendStatus(200);
    }

    /* ===== IMÁGENES ===== */
    if (type === "image" && s.step === "calc_foto_wait") {
      await sendTypingIndicator(from, 3000);
      const imageId = msg.image?.id;
      if (!imageId) { await sendText(from, "⚠️ No pude recibir la imagen. Intentá enviarla de nuevo."); return res.sendStatus(200); }

      let imageUrl;
      try {
        const mediaResponse = await fetch(`https://graph.facebook.com/${API_VERSION}/${imageId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const mediaData = await mediaResponse.json();
        imageUrl = mediaData.url;
      } catch (err) {
        console.error("ERROR obteniendo URL de imagen:", err);
        await sendButtons(from, "❌ Hubo un error al procesar la imagen.", [
          { id:"calc_link_desc", title:"🔗 Link o Descrip." },
          { id:"calc_cat", title:"🔎 Categorías" },
          { id:"menu_si", title:"🏠 Menú" }
        ]);
        return res.sendStatus(200);
      }

      await sendText(from, "📸 Analizando la imagen...");
      const resultado = await analizarImagenProducto(imageUrl);

      if (!resultado.ok) {
        await sendButtons(from, resultado.mensaje, [
          { id:"calc_foto", title:"📸 Otra foto" },
          { id:"calc_link_desc", title:"🔗 Link o Descrip." },
          { id:"menu_si", title:"🏠 Menú" }
        ]);
        return res.sendStatus(200);
      }

      if (resultado.requiere_asesor || resultado.complejidad === "alta") {
        s.step = "waiting_asesor";
        await sendText(from,
          `📸 Identifiqué: *${resultado.producto}*\n\n` +
          `🚨 Este producto requiere asesoramiento especializado.\n\n` +
          `💼 Un especialista te contactará en 4 horas.\n\n` +
          `Datos registrados:\n━━━━━━━━━━━━━━━\n` +
          `📦 ${resultado.producto}\n🏢 ${s.empresa || "No especificada"}\n` +
          `━━━━━━━━━━━━━━━\n\n${HINT_MENU}`
        );
        await sendButtons(from, "También podés:", [
          { id:"calc_cat", title:"🔎 Categorías" },
          { id:"menu_si", title:"🏠 Volver al menú" }
        ]);
        await logProductoNoClasificado(from, s.empresa, resultado.producto, resultado.palabrasClave, "imagen_compleja");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp", "escalar_asesor_imagen", "", "", "", "", "", `Producto complejo con imagen: ${resultado.producto}`]);
        return res.sendStatus(200);
      }

      s.producto_desc = resultado.producto;
      const resultadosBusqueda = await buscarProductoEnTags(resultado.palabrasClave);

      if (resultadosBusqueda.length === 0 || resultadosBusqueda[0].score < UMBRAL_CONFIANZA.MOSTRAR_OPCIONES) {
        s.step = "waiting_asesor";
        await sendText(from,
          `📸 Identifiqué: *${resultado.producto}*\n\n` +
          `⚠️ No encontré una categoría clara para este producto.\n\n` +
          `💬 Te conecto con un asesor.\n\n` +
          `Datos registrados:\n━━━━━━━━━━━━━━━\n` +
          `📦 ${resultado.producto}\n🏢 ${s.empresa || "No especificada"}\n` +
          `━━━━━━━━━━━━━━━\n\n${HINT_MENU}`
        );
        await sendButtons(from, "También podés:", [
          { id:"calc_cat", title:"🔎 Categoria" },
          { id:"menu_si", title:"🏠 Volver al menú" }
        ]);
        await logProductoNoClasificado(from, s.empresa, resultado.producto, resultado.palabrasClave, "imagen");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp", "escalar_asesor_imagen", "", "", "", "", "", `Producto con imagen sin clasificar: ${resultado.producto}`]);
        return res.sendStatus(200);
      }

      const mejor = resultadosBusqueda[0];
      s.matriz = mejor.fila; s.categoria = mejor.categoria;
      s.sel_n1 = mejor.fila.NIV1; s.sel_n2 = mejor.fila.NIV2; s.sel_n3 = mejor.fila.NIV3;

      await sendText(from,
        `📸 Identifiqué: *${resultado.producto}*\n\n` +
        `✅ Categoría encontrada:\n   *${mejor.categoria}*\n\n` +
        `📍 Clasificación:\n   ${mejor.clasificacion}\n\n` +
        `💡 Coincide con: ${mejor.matches.join(", ")}\n\n¿Es correcto?`
      );
      await sendButtons(from, "Confirmá o cambiá:", [
        { id:"calc_clasif_ok", title:"✅ Sí, continuar" },
        { id:"calc_clasif_cambiar", title:"🔄 Cambiar categoría" }
      ]);
      s.step = "calc_clasif_confirm";
      return res.sendStatus(200);
    }

    /* ===== TEXTO ===== */
    if (type==="text") {
      if (s.step==="ask_empresa"){
        s.empresa = text;
        await saveUserEmpresa(from, text);
        await sendTypingIndicator(from, 800);
        await sendText(from, `Gracias. Empresa guardada: *${s.empresa}*`);
        await sendTypingIndicator(from, 800);
        await sendMainActions(from);
        s.step="main";
        return res.sendStatus(200);
      }

      if (s.step==="ask_email"){
        const mail = text.trim();
        if (!isCorporateEmail(mail)){
          await sendText(from, `⚠️ Por favor ingresá un *correo corporativo válido* (ej.: nombre@empresa.com.ar). Evitá gmail/yahoo/hotmail/outlook.${HINT_MENU}`);
          return res.sendStatus(200);
        }
        s.email = mail;
        await sendText(from, "¡Perfecto! Guardamos tu correo para el envío de la cotización. ✅");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","email", "", "", "", "", "", "", `email=${mail}`]);
        await upsellDespacho(from); s.step="upsell";
        return res.sendStatus(200);
      }

      if (s.step==="mar_origen"){
        await sendTypingIndicator(from, 2000);
        if (await fuzzySearchPlace({ from, s, query: text, kind: "sea", action: "mar_origen" })) return res.sendStatus(200);
      }
      if (s.step==="aer_origen"){
        await sendTypingIndicator(from, 2000);
        if (await fuzzySearchPlace({ from, s, query: text, kind: "air", action: "aer_origen" })) return res.sendStatus(200);
      }
      if (s.step==="aer_peso"){
        const peso = toNum(text);
        if (isNaN(peso) || peso < 0) { await sendText(from,`⚠️ Ingresá un *número válido* para el peso (ej.: 1232).${HINT_MENU}`); return res.sendStatus(200); }
        s.peso_kg = Math.max(0, Math.round(peso)); s.vol_cbm = 0;
        await askResumen(from, s); return res.sendStatus(200);
      }
      if (s.step==="courier_origen"){
        const input = norm(text);
        const region = COUNTRY_TO_REGION[input];
        if (!region) {
          const keys = Object.keys(COUNTRY_TO_REGION);
          const match = keys.find(k => k.includes(input) || input.includes(k));
          if (match) { s.origen_aeropuerto = match; await sendText(from, `✅ Usaremos *${match}*.`); }
          else { await sendText(from, `❌ No reconozco "${text}" como país válido.\n\nEjemplos: España, China, USA, Alemania, Brasil.\n\nEscribí el país nuevamente:${HINT_MENU}`); return res.sendStatus(200); }
        } else { s.origen_aeropuerto = input; }
        s.step="courier_peso"; await sendText(from,`⚖️ *Peso (kg)* (podés usar decimales).${HINT_MENU}`); return res.sendStatus(200);
      }
      if (s.step==="courier_peso"){
        const peso = toNum(text);
        if (isNaN(peso) || peso <= 0) { await sendText(from,`⚠️ Ingresá un *número válido* para el peso (ej.: 25.5).${HINT_MENU}`); return res.sendStatus(200); }
        s.peso_kg = peso; await askResumen(from, s); return res.sendStatus(200);
      }
      if (s.step==="ter_origen"){ s.origen_direccion = text; await askResumen(from, s); return res.sendStatus(200); }

      if (s.step==="lcl_tn"){ const n = toNum(text); if(!isFinite(n) || n < 0){await sendText(from,`⚠️ Ingresá *toneladas válidas* (ej.: 2.5 o 2,5).${HINT_MENU}`); return res.sendStatus(200);} s.lcl_tn=n; s.step="lcl_m3"; await sendText(from,`📦 *Volumen total (m³)* (ej.: 8,5)${HINT_MENU}`); return res.sendStatus(200); }
      if (s.step==="lcl_m3"){
        const n = toNum(text);
        if(!isFinite(n) || n < 0){ await sendText(from,`⚠️ Ingresá *m³ válidos* (ej.: 8.5 o 8,5).${HINT_MENU}`); return res.sendStatus(200); }
        s.lcl_m3 = n; s.step = "lcl_apilable";
        await sendButtons(from, "📦 ¿La carga es *apilable*?", [
          { id:"lcl_api_si", title:"✅ Sí" },
          { id:"lcl_api_no", title:"❌ No" },
          { id:"lcl_api_ns", title:"🤷 No lo sé" }
        ]);
        return res.sendStatus(200);
      }

      // === Flete Nacional ===
      if (s.step==="nacional_m3"){
        const m3 = toNum(text);
        if (isNaN(m3) || m3 <= 0) { await sendText(from,`⚠️ Ingresá un *número válido* para m³ (ej.: 3.5).${HINT_MENU}`); return res.sendStatus(200); }
        if (m3 > 10) {
          await sendText(from, `⚠️ *${fmt(m3)} m³ supera el límite de 10 m³ para LTL.*\n\nPara cargas de este volumen te recomendamos *FTL (camión completo)*.\n\n📧 Contactanos para una cotización personalizada:\nhola@conektarsa.com`);
          await endFlow(from); return res.sendStatus(200);
        }
        s.nacional_m3 = m3; s.step = "nacional_tn";
        await sendText(from,`⚖️ Ahora ingresá las *TONELADAS (TN)* de tu carga.\n\nEjemplo: 2.5${HINT_MENU}`);
        return res.sendStatus(200);
      }
      if (s.step==="nacional_tn"){
        const tn = toNum(text);
        if (isNaN(tn) || tn <= 0) { await sendText(from,`⚠️ Ingresá un *número válido* para toneladas (ej.: 2.5).${HINT_MENU}`); return res.sendStatus(200); }
        if (tn > 10) {
          await sendText(from, `⚠️ *${fmt(tn)} TN supera el límite de 10 TN para LTL.*\n\nPara cargas de este peso te recomendamos *FTL (camión completo)*.\n\n📧 Contactanos:\nhola@conektarsa.com`);
          await endFlow(from); return res.sendStatus(200);
        }
        s.nacional_tn = tn;

        try {
          const rows = await readTabRange(TAR_SHEET_ID, TAB_NACIONAL, "A1:Z10000", ["nacional","ltl"]);
          if (!rows || rows.length < 2) { await sendButtons(from, "❌ No pude cargar los destinos disponibles.", [{id:"menu_si", title:"🏠 Menú"}]); return res.sendStatus(200); }
          const header = rows[0], data = rows.slice(1);
          const iDest = headerIndex(header, "destino", "ciudad");
          const iRegion = headerIndex(header, "region", "zona");
          s._nacionalData = data;
          const destinos = [...new Set(data.map(r => r[iDest]).filter(Boolean))];
          if (destinos.length === 0) { await sendButtons(from, "❌ No hay destinos configurados.", [{id:"menu_si", title:"🏠 Menú"}]); return res.sendStatus(200); }
          s._nacionalDestinos = destinos;
          s._destinosPorRegion = {};
          for (const row of data) {
            const dest = row[iDest]; if (!dest) continue;
            let region = iRegion >= 0 ? row[iRegion]?.trim() : null;
            if (!region) region = detectarRegion(dest);
            if (!s._destinosPorRegion[region]) s._destinosPorRegion[region] = [];
            if (!s._destinosPorRegion[region].includes(dest)) s._destinosPorRegion[region].push(dest);
          }

          s.step = "nacional_region";
          const iconosRegion = { "Patagonia Norte":"🏔️","Patagonia Atlántica":"🌊","Patagonia Sur":"❄️","Cuyo":"🍷","Centro":"🏛️","NOA":"🌄","Pampeana":"🌾","Litoral":"🌿" };
          const ordenRegiones = ["Patagonia Norte", "Patagonia Atlántica", "Patagonia Sur", "Cuyo", "Centro", "NOA", "Pampeana", "Litoral"];
          const regiones = ordenRegiones.filter(r => s._destinosPorRegion[r]?.length > 0);
          const regionRows = regiones.map((r,i) => ({ id: `nreg_${i}`, title: `${iconosRegion[r] || "📍"} ${r}`, description: `${s._destinosPorRegion[r].length} destinos disponibles` }));
          await sendList(from, `📍 Elegí la *región* de destino:${HINT_MENU}`, regionRows, "Regiones", "Elegir");
        } catch(e) {
          console.error("Error cargando destinos nacionales:", e);
          await sendButtons(from, "❌ Hubo un error cargando los destinos.", [{id:"menu_si", title:"🏠 Menú"}]);
        }
        return res.sendStatus(200);
      }
      if (s.step==="nacional_origen"){
        s.origen_direccion = text.trim(); s.step = "nacional_fecha_ask";
        await sendButtons(from, "📅 ¿Querés programar una fecha de ENVÍO?", [
          { id:"nfecha_si", title:"✅ Sí" },
          { id:"nfecha_no", title:"❌ No" }
        ]);
        return res.sendStatus(200);
      }
      if (s.step==="nacional_fecha_input"){ s.fecha_transporte = text.trim(); await procesarCotizacionNacional(from, s); return res.sendStatus(200); }
      if (s.step==="local_fecha_input"){
        s.fecha_transporte = text.trim();
        await sendText(from,`✅ Fecha de retiro programada: *${s.fecha_transporte}*\n\n¡Gracias por usar Conektar! Un representante te contactará para coordinar los detalles.`);
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","flete_local_fecha", s.local_cap, s._local_distTitle, "", "", s.local_tipo, s._local_monto, `Fecha retiro: ${s.fecha_transporte}`]);
        await endFlow(from); return res.sendStatus(200);
      }

      if (s.step==="exw_dir"){ s.exw_dir = text; s.step="upsell"; await sendText(from,"¡Gracias! Tomamos la dirección EXW."); await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","exw_dir", s.exw_dir, "", "", "", "", "", "Dirección EXW"]); await upsellDespacho(from); return res.sendStatus(200); }

      // Calculadora
      if (s.flow==="calc"){
        if (s.step==="c_mar_origen"){
          await sendTypingIndicator(from, 2000);
          if (await fuzzySearchPlace({ from, s, query: text, kind: "sea", action: "c_mar_origen" })) return res.sendStatus(200);
        }
      }

      if (s.step==="calc_link_desc_wait"){
        await sendTypingIndicator(from, 3000);
        let palabrasClave = [];
        let esLink = false;

        if (text.startsWith('http://') || text.startsWith('https://')) {
          esLink = true;
          await sendText(from, "🔍 Analizando el link...");
          const resultado = await extraerInfoDesdeURL(text);
          if (resultado.error) {
            await sendButtons(from, resultado.mensaje, [
              { id:"calc_link_desc", title:"🔄 Reintentar" },
              { id:"calc_cat", title:"📂 Por categoría" },
              { id:"menu_si", title:"🏠 Menú" }
            ]);
            s.step = "waiting_retry"; return res.sendStatus(200);
          }
          palabrasClave = resultado.palabrasClave;
          s.producto_desc = resultado.titulo || text;
        } else {
          palabrasClave = extraerPalabrasClave(text);
          s.producto_desc = text;
        }

        const resultados = await buscarProductoEnTags(palabrasClave);

        if (resultados.length === 0 || resultados[0].score < UMBRAL_CONFIANZA.MOSTRAR_OPCIONES) {
          s.step = "waiting_asesor";
          await sendText(from,
            `🔍 Busqué: *${palabrasClave.join(", ")}*\n\n` +
            `⚠️ No encontré una categoría clara para este producto.\n\n` +
            `💬 Te conecto con un asesor.\n\n` +
            `Datos registrados:\n━━━━━━━━━━━━━━━\n` +
            `📦 Producto: ${s.producto_desc}\n🏢 Empresa: ${s.empresa || "No especificada"}\n` +
            `━━━━━━━━━━━━━━━\n\n${HINT_MENU}`
          );
          await sendButtons(from, "También podés:", [
            { id:"calc_cat", title:"📂 Por categoría" },
            { id:"menu_si", title:"🏠 Volver al menú" }
          ]);
          await logProductoNoClasificado(from, s.empresa, s.producto_desc, palabrasClave, "descripcion");
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp", "escalar_asesor", "", "", "", "", "", `Producto no clasificado: ${s.producto_desc}`]);
          return res.sendStatus(200);
        }

        const mejor = resultados[0];
        s.matriz = mejor.fila; s.categoria = mejor.categoria;
        s.sel_n1 = mejor.fila.NIV1; s.sel_n2 = mejor.fila.NIV2; s.sel_n3 = mejor.fila.NIV3;

        const mensaje = mejor.score >= UMBRAL_CONFIANZA.AUTO_CLASIFICAR
          ? `✅ *Encontré la categoría:* ${mejor.categoria}\n\n📍 Clasificación:\n   ${mejor.clasificacion}\n\n💡 Coincide con: ${mejor.matches.join(", ")}\n\n¿Es correcto?`
          : `✅ *Encontré:* ${mejor.categoria}\n\n📍 Clasificación:\n   ${mejor.clasificacion}\n\n💡 Coincide con: ${mejor.matches.join(", ")}\n\n¿Es correcto?`;

        await sendText(from, mensaje);
        await sendButtons(from, "Confirmá o cambiá:", [
          { id:"calc_clasif_ok", title:"✅ Sí, continuar" },
          { id:"calc_clasif_cambiar", title:"🔄 Cambiar categoría" }
        ]);
        s.step = "calc_clasif_confirm";
        return res.sendStatus(200);
      }

      if (s.step==="calc_fob_unit"){
        const n = toNum(text);
        if (!isFinite(n) || n <= 0){ await sendText(from,`⚠️ Ingresá un *precio válido* (ej.: 125.50 o 125,50).${HINT_MENU}`); return res.sendStatus(200); }
        s.fob_unit = n; s.step="calc_qty"; await sendText(from,`🔢 Ingresá la *cantidad* de unidades.${HINT_MENU}`); return res.sendStatus(200);
      }
      if (s.step==="calc_qty"){
        const q = toNum(text);
        if (!isFinite(q) || q <= 0) { await sendText(from,`⚠️ Ingresá una *cantidad válida* (ej.: 100).${HINT_MENU}`); return res.sendStatus(200); }
        s.cantidad = Math.max(1, Math.round(q)); s.fob_total=(s.fob_unit||0)*s.cantidad;
        s.step="calc_vol"; await sendText(from,`📦 Ingresá el *VOLUMEN total* en m³ (ej.: 8,5). Si no sabés, 0.${HINT_MENU}`); return res.sendStatus(200);
      }
      if (s.step==="calc_vol"){
        const vol = toNum(text);
        if (!isFinite(vol) || vol < 0) { await sendText(from,`⚠️ Ingresá un *volumen válido* en m³ (ej.: 8.5 o 0).${HINT_MENU}`); return res.sendStatus(200); }
        s.vol_cbm = vol; s.step="calc_peso";
        await sendText(from,`⚖️ Ingresá el *PESO total* en kg (ej.: 120). Si no tenés el dato, 0.${HINT_MENU}`); return res.sendStatus(200);
      }
      if (s.step==="calc_peso"){
        const peso = toNum(text);
        if (!isFinite(peso) || peso < 0) { await sendText(from,`⚠️ Ingresá un *peso válido* en kg (ej.: 120 o 0).${HINT_MENU}`); return res.sendStatus(200); }
        s.peso_kg = peso;
        s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); return res.sendStatus(200);
      }
      if (s.step==="c_mar_origen" && s.flow==="calc"){
        await sendTypingIndicator(from, 2000);
        if (await fuzzySearchPlace({ from, s, query: text, kind: "sea", action: "c_mar_origen" })) return res.sendStatus(200);
      }
      if (s.step==="c_aer_origen" && s.flow==="calc"){
        await sendTypingIndicator(from, 2000);
        if (await fuzzySearchPlace({ from, s, query: text, kind: "air", action: "c_aer_origen" })) return res.sendStatus(200);
      }
    }

    /* ===== COTIZAR (ejecución) ===== */
    if (s.step==="cotizar"){
      await sendTypingIndicator(from, 2500);
      try {
        if (s.modo==="aereo" && s.aereo_tipo==="carga_general"){
          const r = await cotizarAereo({ origen: s.origen_aeropuerto, kg: s.peso_kg||0, vol: s.vol_cbm||0 });
          if (!r){
            await sendButtons(from,
              `❌ No encontré esa ruta. ¿Qué querés hacer?`,
              [
                { id:"retry_aer_origen", title:"🔄 Otro aeropuerto" },
                { id:"menu_si", title:"🏠 Menú principal" }
              ]
            );
            s.step = "waiting_retry"; return res.sendStatus(200);
          }
          const unit = `USD ${fmtUSD(r.pricePerKg)} por KG (FOB)`;
          const min  = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
          const resp = `✅ *Tarifa estimada (AÉREO – Carga general)*\n${unit} + *Gastos Locales*.${min}\n\n*Kilos facturables:* ${r.facturableKg}\n*Total estimado:* USD ${fmtUSD(r.totalUSD)}\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","aereo", s.origen_aeropuerto, r.destino, s.peso_kg||"", s.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.origen_aeropuerto}→${r.destino}`]);
          const sugerencias = await analizarConveniencia(s);
          if (sugerencias.length > 0) { await sleep(500); for (const sug of sugerencias) { await sendText(from, sug); await sleep(300); } }
        } else if (s.modo==="aereo" && s.aereo_tipo==="courier"){
          const r = await cotizarCourier({ pais: s.origen_aeropuerto, kg: s.peso_kg||0 });
          if (!r){ await sendButtons(from, `❌ No pude calcular el courier.`, [{id:"menu_si", title:"🏠 Menú"}]); return res.sendStatus(200); }
          const pesoUsado = r.ajustado ? r.escalonKg : s.peso_kg;
          const precioKg = r.totalUSD;
          const total = precioKg * pesoUsado;
          const resp = `✅ *Tarifa estimada (COURIER)*\n*Importador:* ${s.courier_pf==="PF"?"Persona Física":"Empresa"}\n*Peso:* ${fmtUSD(pesoUsado)} kg\n*Precio por kg:* USD ${fmtUSD(precioKg)}\n*Total:* USD ${fmtUSD(total)} + *Gastos Locales*\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","courier", s.origen_aeropuerto, r.destino, s.peso_kg||"", "", s.courier_pf||"", total, `Courier ${s.origen_aeropuerto}`]);
          const sugerencias = await analizarConveniencia(s);
          if (sugerencias.length > 0) { await sleep(500); for (const sug of sugerencias) { await sendText(from, sug); await sleep(300); } }
          s.step = "ask_if_email";
          await sendButtons(from, "📧 ¿Deseás que te enviemos la cotización por correo?", [
            { id:"email_si", title:"✅ Sí" },
            { id:"email_no", title:"❌ No" }
          ]);
          return res.sendStatus(200);
        } else if (s.modo==="maritimo"){
          if (s.maritimo_tipo==="LCL"){
            const wm = Math.max((s.lcl_tn||0), (s.lcl_m3||0));
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad: "LCL", wm, m3: s.lcl_m3 });
            if (!r){
              await sendButtons(from, `❌ No encontré esa ruta. ¿Qué querés hacer?`, [
                { id:"retry_mar_origen", title:"🔄 Otro puerto" },
                { id:"menu_si", title:"🏠 Menú principal" }
              ]);
              s.step = "waiting_retry"; return res.sendStatus(200);
            }
            const tiempoTexto = r.diasTransito ? `⏱️ *Tiempo estimado:* ${r.diasTransito} días\n` : "";
            const voluminosoTexto = r.esVoluminoso ? `⚠️ Tarifa voluminosa aplicada (5-10 m³)\n` : "";
            const texto = `✅ *Tarifa estimada (Marítimo LCL)*\nW/M: ${fmtUSD(wm)} (t vs m³)\nTarifa base: USD ${fmtUSD(r.tarifaBase)} por W/M\n${voluminosoTexto}${tiempoTexto}\n*Total estimado:* USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
            await sendText(from, texto);
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", "LCL", r.totalUSD, `Marítimo LCL ${s.origen_puerto}→${r.destino} WM:${wm}`]);
            const sugerencias = await analizarConveniencia(s);
            if (sugerencias.length > 0) { await sleep(500); for (const sug of sugerencias) { await sendText(from, sug); await sleep(300); } }
          } else {
            const modalidad = "FCL" + (s.contenedor||"");
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
            if (!r){
              await sendButtons(from, `❌ No encontré esa ruta. ¿Qué querés hacer?`, [
                { id:"retry_mar_origen", title:"🔄 Otro puerto" },
                { id:"menu_si", title:"🏠 Menú principal" }
              ]);
              s.step = "waiting_retry"; return res.sendStatus(200);
            }
            const partes = [`✅ *Tarifa estimada (Marítimo ${modalidad})*`, `USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.`, `*Origen:* ${s.origen_puerto}`];
            if (r.transit) partes.push(`⏱️ Tiempo estimado: ${r.transit}`);
            partes.push("", `*Validez:* ${VALIDEZ_DIAS} días`, "*Nota:* No incluye impuestos ni gastos locales.");
            await sendText(from, partes.join("\n"));
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.origen_puerto}→${r.destino}`]);
            const sugerencias = await analizarConveniencia(s);
            if (sugerencias.length > 0) { await sleep(500); for (const sug of sugerencias) { await sendText(from, sug); await sleep(300); } }
          }
        } else if (s.modo==="terrestre"){
          const r = await cotizarTerrestre({ origen: s.origen_direccion || "" });
          if (!r){ await sendButtons(from, `❌ No encontré esa ruta terrestre.`, [{id:"menu_si", title:"🏠 Menú"}]); return res.sendStatus(200); }
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
        await sendButtons(from,
          "⚠️ Hubo un problema al leer la planilla. Revisá nombres de pestañas y permisos.",
          [{ id:"menu_si", title:"🏠 Volver al menú" }]
        );
      }
      return res.sendStatus(200);
    }
  } catch (err) {
    console.error("webhook error", err);
    if (!res.headersSent) return res.sendStatus(500);
  }
});

/* ========= HEALTH ========= */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo + Local ✅ v4.1"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

/* ========= Start ========= */
app.listen(PORT, ()=> {
  console.log(`🚀 Bot v4.1 en http://localhost:${PORT}`);
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
    "", "Incoterm: FOB", "¿Confirmás para calcular?"
  ].join("\n");
  return sendButtons(to, lines, [
    { id:"calc_go",   title:"✅ Calcular" },
    { id:"calc_edit", title:"✏️ Editar" },
  ]);
}

/* ========= Courier cotizador ========= */
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
  const col = region === "america sur" ? iAS : region === "usa & canadá" ? iUS : region === "asia" ? iASIA : iEU;
  const wanted = Number(kg);
  let exact = data.find(r => toNum(r[iPeso]) === wanted);
  let usado = wanted, ajustado = false;
  if (!exact) {
    let best = null, bestDiff = Infinity;
    for (const r of data) {
      const p = toNum(r[iPeso]); if (!isFinite(p)) continue;
      const d = Math.abs(p - wanted);
      if (d < bestDiff) { best = r; bestDiff = d; }
    }
    exact = best; usado = toNum(best?.[iPeso]); ajustado = true;
  }
  return { region, escalonKg: usado, ajustado, totalUSD: toNum(exact?.[col]), destino: "Ezeiza (EZE)" };
}
