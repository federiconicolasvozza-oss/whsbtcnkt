// index.js — Conektar S.A. • Bot Cotizaciones + Costeo Impo + Flete Local
// v3.6 — Flete Local con pestaña propia (GOOGLE_TARIFFS_TAB_FLETE_LOCAL),
//        costeo formateado (FOB→CIF) con notas en cursiva, Courier PF/EMP sin EXW,
//        fix botón “apilable” (también entiende sí/no por texto), rating en logs,
//        árbol/populares estables.

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

dotenv.config();
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== ENV ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = "v23.0";

/* Sheets */
const TAR_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AER_HINT = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MAR_HINT = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TER_HINT = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COU_HINT = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();
const TAB_CLASIF_HINT = (process.env.GOOGLE_TARIFFS_TAB_CLASIFICACION || "Clasificación").trim();
/* NUEVO: pestaña específica para Flete Local */
const TAB_LOCAL_HINT = (process.env.GOOGLE_TARIFFS_TAB_FLETE_LOCAL || "").trim();

const LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();
const TAB_CALCULOS = (process.env.GOOGLE_CALC_TAB || "Calculos").trim();

/* Parámetros */
const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);
const LOGO_URL = (process.env.LOGO_URL ||
  "https://conektarsa.com/wp-content/uploads/2025/09/Conektarsa_logo_Whapp.jpg").trim();

/* Cálculo */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01);
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03);
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06);

/* Courier */
const COURIER_ROUND_UP = String(process.env.COURIER_ROUND_UP || "true").toLowerCase() === "true";

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

const toNum = s => {
  if (typeof s === "number") return s;
  const m = String(s||"").replace(/\./g,"").replace(/,/g,".").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};
const fmt = n => isFinite(n) ? Number(n).toFixed(2) : "0.00";
const fmtUSD = n => isFinite(n)
  ? Number(n).toLocaleString("en-US",{minimumFractionDigits:2, maximumFractionDigits:2})
  : "0.00";

const chargeable = (kg, vol) => Math.max(Math.ceil(kg||0), Math.ceil(vol||0));

function headerIndex(header, ...names) {
  const H = header.map(h => norm(h));
  const targets = names.map(x => norm(x));
  return H.findIndex(h => targets.some(t => h === t || h.includes(t)));
}
const clip20 = s => (s||"").toString().slice(0,20);
const clip24 = s => (s||"").toString().slice(0,24);

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
      action:{ buttons: buttons.map(b=>({ type:"reply", reply:{ id:b.id, title: clip20(b.title||"") } })) }
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

/* ---- Menús / rating / upsell ---- */
const sendMainActions = (to) =>
  sendButtons(to, "¿Qué te gustaría hacer hoy?", [
    { id:"action_cotizar",  title:"💼 Cotiz. Flete" },
    { id:"action_calcular", title:"🧮 Costeo Impo" },
    { id:"action_local",    title:"🚚 Flete Local" },
  ]);

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

/* ========= Tabs helper ========= */
const tabCache = new Map();
async function resolveTabTitle(sheetId, hint, extras = []) {
  const n = norm(hint);
  if (!tabCache.has(sheetId)) {
    const meta = await sheetsClient().spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets(properties(title))" });
    const map = {};
    for (const s of (meta.data.sheets || [])) {
      const t = s.properties?.title || "";
      map[norm(t)] = t;
    }
    tabCache.set(sheetId, map);
  }
  const map = tabCache.get(sheetId);
  const entries = Object.entries(map);
  if (hint && map[n]) return map[n];
  const tryList = [n, ...extras.map(norm)].filter(Boolean);
  for (const q of tryList) {
    const exact = entries.find(([k])=>k===q); if (exact) return exact[1];
    const starts= entries.find(([k])=>k.startsWith(q)); if (starts) return starts[1];
    const incl  = entries.find(([k])=>k.includes(q));   if (incl) return incl[1];
  }
  // si no hay hint, devolvemos cualquiera (pero acá preferimos fallar)
  if (!hint) throw new Error("No se indicó pestaña.");
  throw new Error(`No pude encontrar la pestaña "${hint}". Verificá nombre y permisos.`);
}
async function readTabRange(sheetId, tabHint, a1Core, extras=[]) {
  const title = await resolveTabTitle(sheetId, tabHint, extras);
  const range = `'${title}'!${a1Core}`;
  const r = await sheetsClient().spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return r.data.values || [];
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

/* ========= Cotizadores (flete internacional) ========= */
async function cotizarAereo({ origen, kg, vol }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_AER_HINT, "A1:H10000", ["aereos","aéreos","aereo"]);
  if (!rows.length) throw new Error("Aereos vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");
  const iMinKg  = headerIndex(header,"minimo en kg","mínimo en kg","minimo","mínimo");

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

async function cotizarMaritimo({ origen, modalidad, wm=null }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_MAR_HINT, "A1:H10000", ["maritimos","marítimos","martimos","mar"]);
  if (!rows.length) throw new Error("Maritimos vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iMod    = headerIndex(header,"modalidad");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio","precio w/m","w/m");

  const want = norm(origen);
  const row = data.find(r => {
    const dest = norm(r[iDest]||"");
    const mod  = norm(r[iMod]||"").replace(/\s+/g,"");
    const wantMod = norm(modalidad).replace(/\s+/g,"");
    const org = norm(r[iOrigen]||"");
    return dest.includes("buenos aires") && mod===wantMod && (org===want || org.includes(want));
  });
  if (!row) return null;

  const base = toNum(row[iPrecio]);
  const total = (wm && /lcl/i.test(modalidad)) ? (base * wm) : base;
  return { modalidad, totalUSD: total, destino: "Puerto de Buenos Aires", tarifaBase: base, wm };
}

async function cotizarTerrestre({ origen }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_TER_HINT, "A1:H10000", ["terrestres","terrestre"]);
  if (!rows.length) throw new Error("Terrestres vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");

  const want = norm(origen);
  const row = data.find(r => norm(r[iDest]).includes("buenos aires") && (norm(r[iOrigen])===want || norm(r[iOrigen]).includes(want)));
  if (!row) return null;
  return { totalUSD: toNum(row[iPrecio]), destino: "Buenos Aires" };
}

/* ========= Flete Local ========= */
let LOCAL_CACHE = null; // {header, data, idx, distCols, capacidades[], tipos[]}
async function ensureLocal() {
  if (LOCAL_CACHE) return LOCAL_CACHE;

  const localTab = TAB_LOCAL_HINT || TAB_TER_HINT;
  const rows = await readTabRange(
    TAR_SHEET_ID,
    localTab,
    "A1:Z2000",
    ["terrestres","local","flete","flete local","fletes locales"]
  );
  if (!rows.length) throw new Error(`Pestaña de Flete Local vacía (${localTab}).`);

  const header = rows[0];
  const data = rows.slice(1);

  const hIdx = (H, ...names) => {
    const HH = H.map(h => norm(h));
    const wants = names.map(n => norm(n));
    return HH.findIndex(h => wants.some(w => h===w || h.includes(w)));
  };

  const idx = {
    VEHIC: hIdx(header,"vehiculo","vehículo","veh"),
    TIPO:  hIdx(header,"tipo"),
    CAP:   hIdx(header,"capacidad","cap"),
  };

  const distNames = [
    "caba","bs as hasta 30 km","bs as hasta 50 km","bs as hasta 70 km","bs as hasta 100 km"
  ];
  const distCols = {};
  distNames.forEach(name => { const i = hIdx(header,name); if (i>=0) distCols[name]=i; });

  const capacidades = Array.from(new Set(data.map(r => (r[idx.CAP]||"").toString()).filter(Boolean)));
  const tipos = Array.from(new Set(data.map(r => (r[idx.TIPO]||"").toString()).filter(Boolean)));

  LOCAL_CACHE = { header, data, idx, distCols, capacidades, tipos };
  return LOCAL_CACHE;
}

const localTipoOptions = [
  { id:"lt_seca",  title:"Carga Seca",       key:"seca" },
  { id:"lt_refrig",title:"Refrigerada",      key:"refrig" },
  { id:"lt_imo",   title:"IMO / Peligrosa",  key:"pelig" },
];
const localDistLabels = [
  { id:"ld_caba",  title:"CABA", key:"caba" },
  { id:"ld_30",    title:"BS AS ≤ 30 km", key:"bs as hasta 30 km" },
  { id:"ld_50",    title:"BS AS ≤ 50 km", key:"bs as hasta 50 km" },
  { id:"ld_70",    title:"BS AS ≤ 70 km", key:"bs as hasta 70 km" },
  { id:"ld_100",   title:"BS AS ≤ 100 km",key:"bs as hasta 100 km" },
];

async function cotizarLocal({ capacidad, tipoKey, distKey }) {
  const L = await ensureLocal();
  const wantTipo = tipoKey==="refrig" ? "refriger" : (tipoKey==="pelig" ? "pelig" : "seca");
  const row = L.data.find(r => {
    const cap = (r[L.idx.CAP]||"").toString();
    const t   = norm(r[L.idx.TIPO]||"");
    return cap===capacidad && (t.includes(wantTipo) || (wantTipo==="seca" && t.includes("carga seca")));
  });
  if (!row) return null;
  const col = L.distCols[distKey];
  if (col==null) return null;
  return { monto: toNum(row[col]), tipoTexto: row[L.idx.TIPO]||"", vehiculo: row[L.idx.VEHIC]||"" };
}

/* ========= Estado ========= */
const sessions = new Map();
const emptyState = () => ({
  empresa:null, welcomed:false, askedEmpresa:false, step:"start",
  // cotizador
  modo:null, maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null, terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, exw_dir:null,
  // LCL extras
  lcl_tn:null, lcl_m3:null, lcl_stackable:null,
  // calculadora
  flow:null, producto_desc:null, categoria:null, matriz:null,
  fob_unit:null, cantidad:null, fob_total:null,
  calc_modo:null, calc_maritimo_tipo:null, calc_contenedor:null,
  // árbol
  sel_n1:null, sel_n2:null, sel_n3:null,
  _tree:null, _find:null,
  // Local
  flow_local:false, local_cap:null, local_tipo:null, local_dist:null
});
function getS(id){ if(!sessions.has(id)) sessions.set(id, { data: emptyState() }); return sessions.get(id); }

/* ========= Clasificación (matriz impositiva) ========= */
async function readClasificacion() {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_CLASIF_HINT, "A1:Z2000", ["clasificacion","clasificación","hoja 1"]);
  if (!rows.length) return [];
  const header = rows[0].map(h => (h||"").toString().trim());
  const find = (...lbl) => {
    const normH = (s) => (s||"").toString().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"");
    return header.findIndex(h => {
      const H = normH(h);
      return lbl.map(x=>normH(String(x))).some(t => H===t || H.includes(t));
    });
  };
  const idx = {
    NIV1: find("NIVEL_1","NIVEL 1"),
    NIV2: find("NIVEL_2","NIVEL 2"),
    NIV3: find("NIVEL_3","NIVEL 3"),
    CAT : find("CATEGORIA","CATEGORÍA","CATEGORIA PRINCIPAL"),
    SUB : find("SUBCATEGORIA","SUBCATEGORÍA","SUBCATEGORIA"),
    TASA: find("Tasa Estad","% Tasa Estadistica","% Tasa Estadística"),
    IVA : find("% IVA","IVA","IVA %"),
    IVA_A:find("IVA ADIC","% IVA ADICIONAL","IVA ADICIONAL"),
    DI  : find("DERECHOS IM","% DERECHOS","DERECHOS"),
    IIBB: find("% IIBB","IIBB"),
    IIGG: find("% IIGG","IIGG"),
    INT : find("IMPUESTOS INTE","IMPUESTOS INT","INTERNOS"),
    REQ : find("MIENTOS_IMPO","REQUISITOS","REQUISITOS_IMPO","PERMISOS","ORGANISMO"),
    NOTA: find("NOTAS","OBS"),
  };

  const data = rows.slice(1).map(r => ({
    NIV1: r[idx.NIV1] || "",
    NIV2: r[idx.NIV2] || "",
    NIV3: r[idx.NIV3] || "",
    SUB : r[idx.SUB]  || r[idx.CAT] || "",
    tasa_est: isFinite(toNum(r[idx.TASA])) ? toNum(r[idx.TASA])/100 : TASA_ESTATISTICA,
    iva     : isFinite(toNum(r[idx.IVA])) ? toNum(r[idx.IVA])/100 : 0.21,
    iva_ad  : isFinite(toNum(r[idx.IVA_A])) ? toNum(r[idx.IVA_A])/100 : 0.00,
    di      : isFinite(toNum(r[idx.DI])) ? toNum(r[idx.DI])/100 : 0.00,
    iibb    : isFinite(toNum(r[idx.IIBB])) ? toNum(r[idx.IIBB])/100 : 0.035,
    iigg    : isFinite(toNum(r[idx.IIGG])) ? toNum(r[idx.IIGG])/100 : RATE_IIGG,
    internos: isFinite(toNum(r[idx.INT])) ? toNum(r[idx.INT])/100 : 0.00,
    req     : (idx.REQ!=null ? (r[idx.REQ]||"") : ""),
    nota    : (r[idx.NOTA] || "").toString()
  })).filter(x => (x.NIV1||x.NIV2||x.NIV3||x.SUB));

  return data;
}
let MATRIX_CACHE=null;
async function getMatrix(){ if (MATRIX_CACHE) return MATRIX_CACHE; MATRIX_CACHE = await readClasificacion(); return MATRIX_CACHE||[]; }
function indexMatrix(M){
  return M.map(r=>({ niv1:(r.NIV1||"").toString(), niv2:(r.NIV2||"").toString(), niv3:(r.NIV3||"").toString(), sub:(r.SUB||"").toString(),
    iva:r.iva, iva_ad:r.iva_ad, di:r.di, iibb:r.iibb, iigg:r.iigg, internos:r.internos, nota:r.nota, tasa_est:r.tasa_est }));
}
function distinct(arr, keyFn){ const s=new Set(); const out=[]; for(const x of arr){ const k=keyFn(x); if(k && !s.has(k)){ s.add(k); out.push(k);} } return out; }

/* ========= UI calculadora ========= */
const askProdMetodo = (to) => sendButtons(to,
  "Sobre tu producto, ¿preferís *Descripción*, *Categoría* o ver *Populares*?",
  [{ id:"calc_desc", title:"📝 Descrip." },{ id:"calc_cat",  title:"📂 Categoría" },{ id:"calc_pop",  title:"⭐ Populares" }]
);
const populares = ["Cables USB-C","Memorias RAM","Afeitadoras","Batidora de mano","Auriculares BT","Químicos"];
const listFrom = (arr, pref) => arr.slice(0,10).map((t,i)=>({ id:`${pref}_${i}`, title: clip24(t), description: t.length>24?t:undefined }));

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
    const s     = getS(from).data;
    const type  = msg.type;
    const text  = (type==="text") ? (msg.text?.body || "").trim() : "";
    const lower = norm(text);
    const btnId = (type==="interactive") ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "") : "";

    // Bienvenida ÚNICA
    const showWelcomeOnce = async () => {
      if (s.welcomed) return;
      s.welcomed = true;
      await sendImage(
        from,
        LOGO_URL,
        "¡Bienvenido/a al *Asistente Virtual de Conektar*! 🙌\n" +
        "Acá vas a poder *cotizar fletes internacionales*, *estimar el costo de tu importación* y *pedir flete local*."
      );
      await sleep(400);
      if (!s.askedEmpresa) {
        await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
        s.step = "ask_empresa";
        s.askedEmpresa = true;
      }
    };

    if (!s.welcomed) { await showWelcomeOnce(); return res.sendStatus(200); }

    // Comandos globales
    if (type==="text" && ["menu","inicio","start","volver"].includes(lower)) {
      if (lower==="inicio") { sessions.delete(from); getS(from); }
      await sendMainActions(from);
      return res.sendStatus(200);
    }

    /* ===== INTERACTIVE ===== */
    if (type==="interactive") {

      // ===== Menú principal
      if (btnId==="action_cotizar"){ s.flow=null; s.step="choose_modo"; await sendModos(from); }
      else if (btnId==="action_calcular"){ s.flow="calc"; s.step="calc_prod_m"; await askProdMetodo(from); }
      else if (btnId==="action_local"){ s.flow_local=true; s.local_cap=null; s.local_tipo=null; s.local_dist=null;
        const L = await ensureLocal();
        await sendList(from, "📦 ¿Qué *capacidad* necesitás cargar?", listFrom(L.capacidades,"locap"), "Capacidad", "Elegir");
        s.step="local_cap"; }

      /* ====== Flete Local ====== */
      else if (/^locap_\d+$/.test(btnId) && s.step==="local_cap"){
        const i = Number(btnId.split("_")[1]||0);
        const L = await ensureLocal();
        s.local_cap = L.capacidades[i] || L.capacidades[0];
        s.step="local_tipo";
        await sendButtons(from,"¿Tipo de carga?", localTipoOptions.map(o=>({id:o.id,title:o.title})));
      }
      else if (["lt_seca","lt_refrig","lt_imo"].includes(btnId) && s.step==="local_tipo"){
        s.local_tipo = btnId==="lt_seca"?"seca":btnId==="lt_refrig"?"refrig":"pelig";
        s.step="local_dist";
        await sendButtons(from,"Elegí la *distancia*:", localDistLabels.map(o=>({id:o.id,title:o.title})));
      }
      else if (localDistLabels.some(o=>o.id===btnId) && s.step==="local_dist"){
        const distKey = localDistLabels.find(o=>o.id===btnId).key;
        s.local_dist = distKey;
        const r = await cotizarLocal({ capacidad: s.local_cap, tipoKey: s.local_tipo, distKey });
        if (!r){ await sendText(from,"❌ No encontré tarifa para esa combinación en *Flete Local*."); return res.sendStatus(200); }
        const texto = [
          "✅ *Tarifa estimada (FLETE LOCAL)*",
          `Capacidad: *${s.local_cap}*`,
          `Tipo: *${s.local_tipo==="refrig"?"Refrigerada":s.local_tipo==="pelig"?"IMO / Peligrosa":"Carga Seca"}*`,
          `Distancia: *${localDistLabels.find(o=>o.key===distKey)?.title || "-"}*`,
          r.vehiculo ? `Vehículo: ${r.vehiculo}` : "",
          "",
          `*Total:* USD ${fmtUSD(r.monto)}`,
          "",
          "_Nota: el valor no incluye IVA._"
        ].filter(Boolean).join("\n");
        await sendText(from, texto);
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","flete_local", s.local_cap, localDistLabels.find(o=>o.key===distKey)?.title||"", "", "", s.local_tipo, r.monto, "Flete local"]);
        await endFlow(from); sessions.delete(from);
        return res.sendStatus(200);
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
        if (s.modo==="terrestre"){ s.terrestre_tipo="FTL"; s.step="ter_origen"; await sendText(from,"🚛 *Terrestre FTL:* Indicá ciudad/país de ORIGEN."); }
      }
      else if (btnId==="mar_LCL"){
        s.maritimo_tipo = "LCL";
        s.step="lcl_tn"; await sendText(from,"⚖️ *Toneladas (t)* (ej.: 2.5).");
      }
      else if (btnId==="mar_FCL"){
        s.maritimo_tipo = "FCL"; s.step="mar_equipo"; await sendContenedores(from);
      }
      else if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId) && s.flow!=="calc"){
        s.contenedor = btnId==="mar_FCL20" ? "20" : btnId==="mar_FCL40" ? "40" : "40HC";
        s.step="mar_origen";
        await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
      }
      else if (btnId==="aer_carga" || btnId==="aer_courier"){
        s.aereo_tipo = btnId==="aer_carga" ? "carga_general" : "courier";
        if (s.aereo_tipo==="carga_general"){
          s.step="aer_origen";
          await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad. Ej.: PVG / Shanghai).");
        } else {
          s.step="courier_tipo";
          await sendButtons(from, "¿Quién realiza el envío por *Courier*?", [
            { id:"courier_pf",  title:"👤 Persona física" },
            { id:"courier_emp", title:"🏢 Empresa" }
          ]);
        }
      }
      else if ((btnId==="courier_pf" || btnId==="courier_emp") && s.step==="courier_tipo"){
        s.courier_persona = (btnId==="courier_pf") ? "PF" : "EMP";
        await sendText(from, "✔️ Este régimen de *Courier* admite personas físicas y empresas (pueden aplicar límites y requisitos).");
        s.step="courier_origen";
        await sendText(from,"🌍 *País/Ciudad ORIGEN* (ej.: España / China / USA).");
      }

      else if (btnId==="confirmar"){ s.step="cotizar"; }
      else if (btnId==="editar"){ await sendMainActions(from); s.step="main"; }
      else if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); }

      // EXW + Upsell
      else if (btnId==="exw_si"){ s.step="exw_dir"; await sendText(from,"📍 *Dirección EXW* (calle, ciudad, CP, país)."); }
      else if (btnId==="exw_no"){ s.step="upsell"; await upsellDespacho(from); }
      else if (btnId==="desp_si"){ await sendText(from,"¡Genial! Nuestro equipo te contactará para cotizar el despacho. 🙌"); await endFlow(from); sessions.delete(from); }
      else if (btnId==="desp_no"){ await sendText(from,"¡Gracias por tu consulta! 🙌"); await endFlow(from); sessions.delete(from); }

      // Calculadora
      else if (btnId==="calc_desc"){ s.step="calc_desc_wait"; await sendText(from,"Escribí una *breve descripción* (p.ej., “químicos”, “memorias RAM”)."); }
      else if (btnId==="calc_cat"){
        const M = await getMatrix(); const V = indexMatrix(M);
        const n1 = distinct(V, x=>x.niv1).filter(Boolean);
        await sendList(from, "Elegí *NIVEL 1*:", listFrom(n1,"n1"), "Nivel 1", "Elegir");
        s._tree = { V, n1 }; s.step="calc_n1_pick";
      }
      else if (btnId==="calc_pop"){
        await sendList(from, "⭐ Productos más consultados:", listFrom(populares,"pop"), "Populares", "Ver");
        s.step="calc_pop_pick";
      }
      else if (/^n1_\d+$/.test(btnId) && s.step==="calc_n1_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n1 = label;
        const V = s._tree.V;
        const n2 = distinct(V.filter(x=>x.niv1===label), x=>x.niv2).filter(Boolean);
        await sendList(from, "Elegí *NIVEL 2*:", listFrom(n2,"n2"), "Nivel 2", "Elegir");
        s._tree.n2 = n2; s.step="calc_n2_pick";
      }
      else if (/^n2_\d+$/.test(btnId) && s.step==="calc_n2_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n2 = label;
        const V = s._tree.V;
        const n3 = distinct(V.filter(x=>x.niv1===s.sel_n1 && x.niv2===label), x=>x.niv3).filter(Boolean);
        await sendList(from, "Elegí *NIVEL 3*:", listFrom(n3,"n3"), "Nivel 3", "Elegir");
        s._tree.n3 = n3; s.step="calc_n3_pick";
      }
      else if (/^n3_\d+$/.test(btnId) && s.step==="calc_n3_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n3 = label;
        const V = s._tree.V;
        const subs = distinct(V.filter(x=>x.niv1===s.sel_n1 && x.niv2===s.sel_n2 && x.niv3===label), x=>x.sub).filter(Boolean);
        await sendList(from, "Elegí la *Subcategoría*:", listFrom(subs,"sub"), "Subcategorías", "Elegir");
        s._tree.subs = subs; s.step="calc_sub_pick";
      }
      else if (/^sub_\d+$/.test(btnId) && s.step==="calc_sub_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        const M = await getMatrix();
        const fila = M.find(x => clip24(x.SUB)===clip24(label)) || M[0];
        s.matriz = fila;
        s.categoria = label;
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
      }
      else if (/^pop_\d+$/.test(btnId) && s.step==="calc_pop_pick"){
        const i = Number(btnId.split("_")[1]||0);
        s.producto_desc = populares[i] || populares[0];
        const M = await getMatrix();
        s.matriz = M.find(x => norm(x.SUB).includes(norm(s.producto_desc)) || norm(x.NIV3).includes(norm(s.producto_desc))) || M[0];
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
      }
      else if (/^n3s_\d+$/.test(btnId) && s.step==="calc_find_n3_pick"){
        const title = msg.interactive?.list_reply?.title;
        s.sel_n3 = title;
        const { V } = s._find;
        const subs = distinct(V.filter(x=>x.niv3===title), x=>x.sub).filter(Boolean);
        await sendList(from, "Elegí la *subcategoría*:", listFrom(subs,"subf"), "Subcategorías", "Elegir");
        s._find.subs = subs; s.step="calc_find_sub_pick";
      }
      else if (/^subf_\d+$/.test(btnId) && s.step==="calc_find_sub_pick"){
        const label = msg.interactive?.list_reply?.title;
        const M = await getMatrix();
        const fila = M.find(x => clip24(x.SUB)===clip24(label)) || M[0];
        s.matriz = fila; s.categoria = label; s.producto_desc = `${s.sel_n3} / ${label}`;
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
      }

      // Modo transporte (calculadora)
      else if (btnId==="c_maritimo"){ s.calc_modo="maritimo"; s.step="c_mar_tipo"; await sendButtons(from,"Marítimo: ¿LCL o FCL?",[{id:"c_lcl",title:"LCL"},{id:"c_fcl",title:"FCL"}]); }
      else if (btnId==="c_aereo"){ s.calc_modo="aereo"; s.step="c_confirm"; await confirmCalc(from, s); }
      else if (btnId==="c_lcl"){ s.calc_maritimo_tipo="LCL"; s.step="c_confirm"; await confirmCalc(from,s); }
      else if (btnId==="c_fcl"){ s.calc_maritimo_tipo="FCL"; s.step="c_cont"; await sendContenedores(from); }
      else if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId) && s.flow==="calc"){
        s.calc_contenedor = btnId==="mar_FCL20"?"20":btnId==="mar_FCL40"?"40":"40HC";
        s.step="c_confirm"; await confirmCalc(from,s);
      }

      else if (btnId==="calc_edit"){ s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); }
      else if (btnId==="calc_go"){
        // === Calcular costos (FOB → CIF → Impuestos)
        const M = s.matriz || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa_est:TASA_ESTATISTICA, nota:"" };
        let fleteUSD = 0, fleteDetalle = "", modoEtiqueta = "";

        try{
          if (s.calc_modo==="aereo"){
            const r = await cotizarAereo({ origen: s.origen_aeropuerto || "Shanghai", kg: s.peso_kg||0, vol: (s.vol_cbm||0)*167 });
            if (r){ fleteUSD = r.totalUSD; fleteDetalle = `Flete ✈️ (Aéreo): USD ${fmtUSD(fleteUSD)}`; modoEtiqueta="Aéreo"; }
          } else if (s.calc_modo==="maritimo"){
            const modalidad = s.calc_maritimo_tipo==="FCL" ? (s.calc_contenedor?`FCL${s.calc_contenedor}`:"FCL") : "LCL";
            const r = await cotizarMaritimo({ origen: s.origen_puerto || "Shanghai", modalidad, wm: undefined });
            if (r){
              fleteUSD = r.totalUSD;
              fleteDetalle = `Flete 🚢 (Marítimo ${modalidad}): USD ${fmtUSD(fleteUSD)}`;
              modoEtiqueta = `Marítimo ${modalidad}`;
            }
          }
        }catch{/* sin tarifa: seguimos */}

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

        const unitario = (s.cantidad||0)>0 ? (costoAdu / s.cantidad) : 0;
        const incSobreFOB = (s.fob_total||0)>0 ? ((costoAdu - (s.fob_total||0)) / (s.fob_total||0) * 100) : 0;

        const body = [
          "📦 *Resultado estimado (FOB → CIF)*",
          "",
          `FOB total: USD ${fmtUSD(s.fob_total)} (${s.cantidad||0} u. × ${fmtUSD(s.fob_unit||0)})`,
          fleteDetalle || "Flete: *sin tarifa* (seguimos el cálculo y te contactamos)",
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
          `➡️ Costo unitario final: USD ${fmtUSD(unitario)}`,
          `📈 Incremento sobre FOB: +${fmt(incSobreFOB)}%`,
          "",
          "📝 *Notas:*",
          ...(M.req ? [`* ${M.req}`] : []),
          ...(M.nota ? [`* ${M.nota}`] : []),
          "* No contempla gastos locales (liberación, despachante, almacenaje, etc.)."
        ].join("\n");

        await sendText(from, body);

        await logCalculo([
          new Date().toISOString(), from, s.empresa, (s.producto_desc||s.categoria||s.sel_n3||""), (s.matriz?.SUB||s.matriz?.NIV3||""),
          s.fob_unit, s.cantidad, s.fob_total, s.peso_kg, s.vol_cbm,
          s.calc_modo, s.calc_maritimo_tipo||"", s.calc_contenedor||"",
          insurance, fleteUSD, cif, di, tasa, iva, ivaAd, iibb, iigg, internos, impTotal, costoAdu, modoEtiqueta
        ]);

        await upsellDespacho(from); s.step="upsell";
      }

      // rating + volver
      else if (/^rate_[1-5]$/.test(btnId)){
        const val = Number(btnId.split("_")[1]);
        await sendText(from,"¡Gracias por tu calificación! ⭐");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","rating", "", "", "", "", "", val, ""]);
      }

      else if (btnId==="menu_si"){ await sendMainActions(from); }
      else if (btnId==="menu_no"){ await sendText(from,"¡Gracias! Si necesitás algo más, escribinos cuando quieras."); }

      if (s.step !== "cotizar") return res.sendStatus(200);
    }

    /* ===== TEXTO ===== */
    if (type==="text") {
      if (s.step==="ask_empresa"){
        s.empresa = text;
        await sendText(from, `Gracias. Empresa guardada: *${s.empresa}*`);
        await sendMainActions(from);
        s.step="main";
        return res.sendStatus(200);
      }

      // Cotizador clásico
      if (s.step==="mar_origen"){ s.origen_puerto = text; await askResumen(from, s); return res.sendStatus(200); }
      if (s.step==="aer_origen"){ s.origen_aeropuerto = text; s.step="aer_peso"; await sendText(from,"⚖️ *Peso (kg)* (entero)."); return res.sendStatus(200); }
      if (s.step==="aer_peso"){
        const peso = toNum(text); if (isNaN(peso)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); }
        s.peso_kg = Math.max(0, Math.round(peso)); s.step="aer_vol";
        await sendText(from,"📦 *Peso volumétrico (kg)* (poné 0 si no sabés)."); return res.sendStatus(200);
      }
      if (s.step==="aer_vol"){
        const vol = toNum(text); if (isNaN(vol)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); }
        s.vol_cbm = Math.max(0, vol); await askResumen(from, s); return res.sendStatus(200);
      }
      if (s.step==="courier_origen"){ s.origen_aeropuerto = text; s.step="courier_peso"; await sendText(from,"⚖️ *Peso (kg)* (podés usar decimales)."); return res.sendStatus(200); }
      if (s.step==="courier_peso"){
        const peso = toNum(text); if (isNaN(peso)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); }
        s.peso_kg = peso; await askResumen(from, s); return res.sendStatus(200);
      }
      if (s.step==="ter_origen"){ s.origen_direccion = text; await askResumen(from, s); return res.sendStatus(200); }

      // LCL preguntas
      if (s.step==="lcl_tn"){
        const n = toNum(text);
        if(!isFinite(n)||n<0){await sendText(from,"Ingresá toneladas válidas (ej.: 2.5)"); return res.sendStatus(200);}
        s.lcl_tn=n; s.step="lcl_m3"; await sendText(from,"📦 *Volumen total (m³)* (ej.: 8.5)"); return res.sendStatus(200);
      }
      if (s.step==="lcl_m3"){
        const n = toNum(text);
        if(!isFinite(n)||n<0){await sendText(from,"Ingresá m³ válidos (ej.: 8.5)"); return res.sendStatus(200);}
        s.lcl_m3=n; s.step="lcl_stack"; await sendButtons(from,"¿La mercadería es *apilable*?",[{id:"stk_si",title:"Sí"},{id:"stk_no",title:"No"}]); return res.sendStatus(200);
      }
      // Fallback: user escribió "si/no" en vez de tocar el botón
      if (s.step==="lcl_stack"){
        const yes = ["si","sí","si.","sí.","s","y","yes"].includes(lower);
        const no  = ["no","no.","n"].includes(lower);
        if (yes || no){
          s.lcl_stackable = yes;
          s.step="mar_origen";
          await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
          return res.sendStatus(200);
        }
      }

      if (s.step==="exw_dir"){ s.exw_dir = text; s.step="upsell"; await sendText(from,"¡Gracias! Tomamos la dirección EXW."); await upsellDespacho(from); return res.sendStatus(200); }

      // Calculadora — búsqueda libre
      if (s.flow==="calc"){
        if (s.step==="calc_desc_wait"){
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
            await sendText(from,"No encontré coincidencias claras. Uso categoría genérica.\n\n💵 Ingresá *FOB unitario (USD)*.");
          } else {
            const rows = listFrom(n3Matches,"n3s");
            s._find = { V, n3Matches };
            await sendList(from, "Elegí el *tipo* (NIVEL 3):", rows, "Tipos", "Elegir");
            s.step = "calc_find_n3_pick";
          }
          return res.sendStatus(200);
        }
        if (s.step==="calc_fob_unit"){
          const n = toNum(text); if (!isFinite(n)||n<=0){ await sendText(from,"Ingresá un número válido (ej.: 125.50)."); return res.sendStatus(200); }
          s.fob_unit = n; s.step="calc_qty"; await sendText(from,"🔢 Ingresá la *cantidad* de unidades."); return res.sendStatus(200);
        }
        if (s.step==="calc_qty"){
          const q = Math.max(1, Math.round(toNum(text))); s.cantidad=q; s.fob_total=(s.fob_unit||0)*q;
          s.step="calc_vol"; await sendText(from,"📦 Ingresá el *VOLUMEN total* en m³ (ej.: 8.5). Si no sabés, 0."); return res.sendStatus(200);
        }
        if (s.step==="calc_vol"){
          s.vol_cbm = Math.max(0, toNum(text)||0); s.step="calc_peso";
          await sendText(from,"⚖️ Ingresá el *PESO total* en kg (ej.: 120). Si no tenés el dato, 0."); return res.sendStatus(200);
        }
        if (s.step==="calc_peso"){
          s.peso_kg = Math.max(0, toNum(text)||0);
          s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); return res.sendStatus(200);
        }
      }
    }

    /* ===== COTIZAR (ejecución) ===== */
    if (s.step==="cotizar"){
      try{
        if (s.modo==="aereo" && s.aereo_tipo==="carga_general"){
          const r = await cotizarAereo({ origen: s.origen_aeropuerto, kg: s.peso_kg||0, vol: s.vol_cbm||0 });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Aéreos*. Probá con ciudad o IATA (PVG, PEK, NRT)."); return res.sendStatus(200); }
          const unit = `USD ${fmtUSD(r.pricePerKg)} por KG (FOB)`;
          const min  = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
          const resp = `✅ *Tarifa estimada (AÉREO – Carga general)*
${unit} + *Gastos Locales*.${min}

*Kilos facturables:* ${r.facturableKg}
*Total estimado:* USD ${fmtUSD(r.totalUSD)}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","aereo", s.origen_aeropuerto, r.destino, s.peso_kg||"", s.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.origen_aeropuerto}→${r.destino}`]);
        } else if (s.modo==="aereo" && s.aereo_tipo==="courier"){
          const r = await cotizarCourier({ pais: s.origen_aeropuerto, kg: s.peso_kg||0 });
          if (!r){ await sendText(from,"❌ No pude calcular *Courier*. Revisá la pestaña."); return res.sendStatus(200); }
          const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg.` : "";
          const resp = `✅ *Tarifa estimada (COURIER)*
*Peso:* ${fmtUSD(s.peso_kg)} kg${nota}
*Total:* USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","courier", s.origen_aeropuerto, r.destino, s.peso_kg||"", "", "", r.totalUSD, `Courier ${s.origen_aeropuerto}`]);

          // Courier: NO preguntar EXW → cerrar
          await sendText(from, "✅ *Tu consulta fue registrada.* Nuestro equipo te contactará a la brevedad.\n📧 comercial@conektarsa.com");
          await endFlow(from); sessions.delete(from);
          return res.sendStatus(200);
        } else if (s.modo==="maritimo"){
          let texto = "";
          if (s.maritimo_tipo==="LCL"){
            const wm = Math.max((s.lcl_tn||0), (s.lcl_m3||0)); // W/M
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad: "LCL", wm });
            if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*. Revisá la pestaña."); return res.sendStatus(200); }
            texto = `✅ *Tarifa estimada (Marítimo LCL)*
W/M: ${fmtUSD(wm)} (t vs m³)
Tarifa base: USD ${fmtUSD(r.tarifaBase)} por W/M
*Total estimado:* USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Apilable:* ${s.lcl_stackable===true?"Sí":s.lcl_stackable===false?"No":"(sin indicar)"}\n*Nota:* No incluye impuestos ni gastos locales.`;
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", "LCL", r.totalUSD, `Marítimo LCL ${s.origen_puerto}→${r.destino} WM:${wm}`]);
          } else { // FCL
            const modalidad = "FCL" + (s.contenedor||"");
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
            if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*."); return res.sendStatus(200); }
            texto = `✅ *Tarifa estimada (Marítimo ${modalidad})*
USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.
*Origen:* ${s.origen_puerto}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.origen_puerto}→${r.destino}`]);
          }
          await sendText(from, texto);
        } else if (s.modo==="terrestre"){
          const r = await cotizarTerrestre({ origen: s.origen_direccion || "" });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Terrestres*."); return res.sendStatus(200); }
          const resp = `✅ *Tarifa estimada (TERRESTRE FTL)*
USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","terrestre", s.origen_direccion||"", r.destino, "", "", "FTL", r.totalUSD, `Terrestre ${s.origen_direccion}→${r.destino}`]);
        }

        await sendText(from, "✅ *Tu consulta fue registrada.* Nuestro equipo te contactará a la brevedad.\n📧 comercial@conektarsa.com");

        // EXW solo para no-terrestre y no-courier
        if (!(s.modo==="terrestre" || (s.modo==="aereo" && s.aereo_tipo==="courier"))){
          await sendButtons(from, "¿Tu carga es EXW?", [
            { id:"exw_si", title:"Sí" },
            { id:"exw_no", title:"No" }
          ]);
          s.step="exw_q";
        } else {
          s.step="upsell"; await upsellDespacho(from);
        }
      }catch(e){
        console.error("cotizar error", e);
        await sendText(from,"⚠️ Hubo un problema al leer la planilla. Revisá nombres de pestañas y permisos.");
      }
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  }catch(e){
    console.error("webhook error", e);
    return res.sendStatus(200);
  }
});

/* ========= HEALTH ========= */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo Impo + Flete Local ✅ v3.6"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

/* ========= Start ========= */
app.listen(PORT, ()=> console.log(`🚀 Bot v3.6 en http://localhost:${PORT}`));

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
      lines.push(`• W/M input: t=${fmt(d.lcl_tn||0)} • m³=${fmt(d.lcl_m3||0)} • Apilable=${d.lcl_stackable===true?"Sí":d.lcl_stackable===false?"No":"-"}`);
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
      lines.push("• Subtipo: *Courier*");
      lines.push(`• Origen: *${d.origen_aeropuerto || "?"}* ➡️ *${d.destino_aeropuerto}*`);
      if (d.peso_kg!=null) lines.push(`• Peso: *${fmt(d.peso_kg)} kg*`);
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
async function cotizarCourier({ pais, kg }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_COU_HINT, "A1:Z10000", ["courier"]);
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
    // si hay que redondear hacia arriba
    if (COURIER_ROUND_UP){
      const mayores = data
        .map(r => ({ r, p: toNum(r[iPeso]) }))
        .filter(x => x.p >= wanted)
        .sort((a,b)=>a.p-b.p);
      if (mayores.length){ exact = mayores[0].r; usado = toNum(exact[iPeso]); ajustado = true; }
    }
    if (!exact){
      let best=null, bestDiff=Infinity;
      for (const r of data) { const p=toNum(r[iPeso]); const d=Math.abs(p-wanted); if (d<bestDiff){best=r;bestDiff=d;} }
      exact = best; usado = toNum(best[iPeso]); ajustado = true;
    }
  }
  return { region, escalonKg: usado, ajustado, totalUSD: toNum(exact[col]), destino: "Ezeiza (EZE)" };
}
