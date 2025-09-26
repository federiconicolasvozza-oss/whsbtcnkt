// index.js — Conektar S.A. • Bot de Cotizaciones + Costeo de Impo (ESM) • v3.0
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

const TAR_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AER_HINT = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MAR_HINT = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TER_HINT = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COU_HINT = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();

const LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);

const LOGO_URL = (process.env.LOGO_URL ||
  "https://conektarsa.com/wp-content/uploads/2025/05/LogoCH80px.png").trim();

/* === NUEVO: Costeo de importación (matriz + logs) === */
const MATRIX_SHEET_ID = (process.env.PRODUCT_MATRIX_SHEET_ID || "").trim();        // ID del sheet con la pestaña "Clasificación"
const MATRIX_TAB       = (process.env.PRODUCT_MATRIX_TAB || "Clasificación").trim();
const CALC_TAB         = (process.env.GOOGLE_CALC_TAB || "calculos").trim();
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01); // 1% FOB
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03); // 3% CIF
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06); // 6% fijo
const RATE_LCL_PER_TON      = Number(process.env.RATE_LCL_PER_TON      ?? 5);     // fallback W/M
const AR_LOCAL_CHARGES_LCL  = Number(process.env.AR_LOCAL_CHARGES_LCL  ?? 400);   // fallback locales

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
const chargeable = (kg, vol) => Math.max(Math.ceil(kg||0), Math.ceil(vol||0));

function headerIndex(header, ...names) {
  const H = header.map(h => norm(h));
  const targets = names.map(x => norm(x));
  return H.findIndex(h => targets.some(t => h === t || h.includes(t)));
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
      action:{ buttons: buttons.map(b=>({ type:"reply", reply:{ id:b.id, title:b.title } })) }
    }
  });

const sendImage = (to, link, caption="") =>
  sendMessage({ messaging_product:"whatsapp", to, type:"image", image:{ link, caption } });

/* ---- Menús (cotizador) ---- */
const sendMainActions = (to) =>
  sendButtons(to, "¿Qué te gustaría hacer hoy?", [
    { id:"action_cotizar",  title:"💼 Cotizar Flete Int" },
    { id:"action_calcular", title:"🧮 Costeo de Impo" },
  ]);

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

/* ---- Menús (calculadora) ---- */
const sendModosCalc = (to) =>
  sendButtons(to, "Elegí el modo de transporte:", [
    { id:"calc_maritimo",  title:"🚢 Marítimo" },
    { id:"calc_aereo",     title:"✈️ Aéreo" },
  ]);

const sendTiposMaritimoCalc = (to) =>
  sendButtons(to, "¿Vas por LCL o FCL?", [
    { id:"calc_mar_LCL", title:"LCL" },
    { id:"calc_mar_FCL", title:"FCL" },
  ]);

const sendContenedoresCalc = (to) =>
  sendButtons(to, "Elegí contenedor:", [
    { id:"calc_FCL20",  title:"20' ST" },
    { id:"calc_FCL40",  title:"40' ST" },
    { id:"calc_FCL40HC",title:"40' HC" },
  ]);

/* ========= Tabs ========= */
const tabCache = new Map();
async function resolveTabTitle(sheetId, hint, extras = []) {
  const n = norm(hint);
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
  const tryList = [n, ...extras.map(norm)];
  for (const q of tryList) {
    const exact = entries.find(([k])=>k===q); if (exact) return exact[1];
    const starts= entries.find(([k])=>k.startsWith(q)); if (starts) return starts[1];
    const incl  = entries.find(([k])=>k.includes(q));   if (incl) return incl[1];
  }
  if (n.startsWith("marit")) {
    const alt = entries.find(([k])=>k.startsWith("martim") || k.startsWith("marit"));
    if (alt) return alt[1];
  }
  throw new Error(`No pude encontrar la pestaña "${hint}".`);
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

/* ========= Cotizadores ========= */
async function cotizarAereo({ origen, kg, vol }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_AER_HINT, "A1:H10000", ["aereos","aéreos","aereo"]);
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

async function cotizarMaritimo({ origen, modalidad }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_MAR_HINT, "A1:H10000", ["maritimos","marítimos","martimos","mar"]);
  if (!rows.length) throw new Error("Maritimos vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iMod    = headerIndex(header,"modalidad");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");

  const want = norm(origen);
  const row = data.find(r =>
    norm(r[iDest]).includes("buenos aires") &&
    norm(r[iMod]) === norm(modalidad) &&
    (norm(r[iOrigen])===want || norm(r[iOrigen]).includes(want))
  );
  if (!row) return null;
  return { modalidad, totalUSD: toNum(row[iPrecio]), destino: "Puerto de Buenos Aires" };
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
    let best=null, bestDiff=Infinity;
    for (const r of data) { const p=toNum(r[iPeso]); const d=Math.abs(p-wanted); if (d<bestDiff){best=r;bestDiff=d;} }
    exact = best; usado = toNum(best[iPeso]); ajustado = true;
  }
  return { region, escalonKg: usado, ajustado, totalUSD: toNum(exact[col]), destino: "Ezeiza (EZE)" };
}

/* ========= Estado ========= */
const sessions = new Map();
const emptyState = () => ({
  empresa:null, modo:null,
  maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null,
  terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, tarifa:null, moneda:"USD", validez_dias:VALIDEZ_DIAS,
  exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  welcomed:false, askedEmpresa:false,
  step:"start",
  calc:{} // namespace del calculador
});
function getS(id){ if(!sessions.has(id)) sessions.set(id, { data: emptyState() }); return sessions.get(id); }

/* ========= UI ========= */
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
    lines.push(`• Tipo: *${d.maritimo_tipo || "-"}* ${d.contenedor?`(Equipo: ${d.contenedor})`:""}`);
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

const upsellDespacho = (to) =>
  sendButtons(to, "¿Sabías que también somos *despachantes de aduana*? ¿Te interesaría cotizarlo?", [
    { id:"desp_si", title:"Sí" },
    { id:"desp_no", title:"No" }
  ]);

/* ========= MATRIZ CLASIFICACIÓN (para calculadora) ========= */
async function readMatrixClasificacion() {
  if (!MATRIX_SHEET_ID) return null;
  const title = /[^A-Za-z0-9_]/.test(MATRIX_TAB) ? `'${MATRIX_TAB}'` : MATRIX_TAB;
  const rows = await sheetsClient().spreadsheets.values.get({
    spreadsheetId: MATRIX_SHEET_ID,
    range: `${title}!A1:Z2000`
  }).then(r=> r.data.values || []).catch(()=>[]);
  if (!rows.length) return null;

  const head = rows[0].map(x => (x||"").toString().trim().toLowerCase());
  const idx = (needle) => head.findIndex(h => h.includes(needle));
  const out = [];
  for (let i=1;i<rows.length;i++){
    const r = rows[i]||[];
    out.push({
      categoria: (r[idx("categoria")] || r[idx("nivel_2")] || r[idx("nivel_1")] || "").toString(),
      tasa_est : isFinite(toNum(r[idx("tasa estad")])) ? toNum(r[idx("tasa estad")])/100 : TASA_ESTATISTICA,
      iva      : isFinite(toNum(r[idx("% iva")])) ? toNum(r[idx("% iva")])/100 : 0.21,
      iva_adic : isFinite(toNum(r[idx("iva adicion")])) ? toNum(r[idx("iva adicion")])/100 : 0.00,
      di       : isFinite(toNum(r[idx("derechos impo")])) ? toNum(r[idx("derechos impo")])/100 : 0.14,
      iibb     : isFinite(toNum(r[idx("% iibb")])) ? toNum(r[idx("% iibb")])/100 : 0.035,
      internos : isFinite(toNum(r[idx("internos")])) ? toNum(r[idx("internos")])/100 : 0.00,
      iigg     : RATE_IIGG,
      notas    : (r[idx("notas")] || "").toString()
    });
  }
  return out;
}
let MATRIX_CACHE = null;
async function getMatrix() {
  if (!MATRIX_CACHE) MATRIX_CACHE = await readMatrixClasificacion();
  return MATRIX_CACHE;
}
function pickCategory(matrix, texto="") {
  const base = (texto||"").toLowerCase();
  if (!matrix?.length) return null;
  let best=null, bestScore=-1;
  for (const m of matrix) {
    const words = (m.categoria||"").toLowerCase().split(/\s+/).filter(Boolean);
    const s = words.reduce((a,w)=> a + (base.includes(w)?1:0), 0);
    if (s>bestScore){best=m;bestScore=s;}
  }
  return best || matrix[0];
}

/* ========= Motor de cálculo ========= */
async function estimarFleteParaCalc({ modo, maritimo_tipo, contenedor, origen, kg, vol }) {
  try{
    if (modo==="aereo") {
      const r = await cotizarAereo({ origen: origen||"", kg: kg||0, vol: vol||0 });
      if (r) return { amount: r.totalUSD, nota: "" };
    }
    if (modo==="maritimo") {
      const modalidad = maritimo_tipo==="FCL" ? (contenedor?`FCL${contenedor}`:"FCL") : "LCL";
      const r = await cotizarMaritimo({ origen: origen||"", modalidad });
      if (r) return { amount: r.totalUSD, nota: "" };
    }
  }catch{}
  return { amount: 0, nota: "⚠️ No pude tomar el flete exacto; sigo con el costeo y nuestro equipo te contactará con el valor de flete." };
}

function calcDespacho(cif){
  const base = cif * 0.003; // 0.3%
  const honor = Math.min(Math.max(base, 150), 5000);
  const total = honor + 20 + 100;
  return { honor, admin:20, oper:100, total };
}

function calcularCosteo({ fob_total=0, modo, maritimo_tipo, contenedor, kg=0, vol=0, matriz, freight }) {
  if (!freight && modo==="maritimo" && maritimo_tipo==="LCL") {
    const wm = Math.max((kg||0)/1000, vol||0);
    freight = wm*RATE_LCL_PER_TON + AR_LOCAL_CHARGES_LCL;
  }

  const insurance = fob_total * INSURANCE_RATE;
  const cif = fob_total + freight + insurance;

  const tasa = cif * (matriz?.tasa_est ?? TASA_ESTATISTICA);
  const di   = cif * (matriz?.di ?? 0);
  const baseIVA = cif + di + tasa;

  const iva = baseIVA * (matriz?.iva ?? 0.21);
  const iva_adic = baseIVA * (matriz?.iva_adic ?? 0.00);
  const iibb = cif * (matriz?.iibb ?? 0.035);
  const iigg = baseIVA * RATE_IIGG;
  const internos = (matriz?.internos ?? 0) > 0 ? cif * (matriz?.internos ?? 0) : 0;

  const impTot = di + tasa + iva + iva_adic + iibb + iigg + internos;
  const costoAduanero = cif + impTot;

  const desp = calcDespacho(cif);
  const costoFinal = costoAduanero + desp.total;

  return { insurance, cif, di, tasa, iva, iva_adic, iibb, iigg, internos, impTot, costoAduanero, desp, costoFinal, freight };
}

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
    const btnId = (type==="interactive") ? (msg.interactive?.button_reply?.id || "") : "";

    // Bienvenida: IMG+CAPTION primero, luego pregunta empresa
    const showWelcomeOnce = async () => {
      if (s.welcomed) return;
      s.welcomed = true;
      await sendImage(
        from,
        LOGO_URL,
        "¡Bienvenido/a al *Asistente Virtual de Conektar*! 🙌\n" +
          "Acá vas a poder *cotizar fletes internacionales* y *estimar el costo de tu importación*."
      );
      await sleep(700);
      await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
      s.step = "ask_empresa";
      s.askedEmpresa = true;
    };

    // Palabras de arranque
    if (type==="text" && ["hola","menu","inicio","start","volver"].includes(lower)) {
      await showWelcomeOnce();
      return res.sendStatus(200);
    }
    if (!s.welcomed) {
      await showWelcomeOnce();
      return res.sendStatus(200);
    }

    /* ===== BOTONES ===== */
    if (type==="interactive") {

      // Menú principal
      if (btnId==="action_cotizar"){
        s.step = "choose_modo";
        await sendModos(from);
        return res.sendStatus(200);
      }
      if (btnId==="action_calcular"){
        // inicia flujo calculadora
        s.step = "calc_producto";
        s.modo = null; s.maritimo_tipo=null; s.contenedor=null; s.calc = {};
        await sendText(from, "📝 Describí el *producto* (ej.: cables USB-C).");
        return res.sendStatus(200);
      }

      // Cotizador (v2.8 intacto)
      if (btnId.startsWith("menu_")){
        s.modo = btnId.replace("menu_","");
        if (s.modo==="maritimo"){ s.step="mar_tipo"; await sendTiposMaritimo(from); }
        if (s.modo==="aereo"){
          s.step="aereo_subtipo";
          await sendButtons(from, "✈️ *Aéreo:* ¿Qué necesitás cotizar?", [
            { id:"aer_carga",   title:"Carga general" },
            { id:"aer_courier", title:"Courier" }
          ]);
        }
        if (s.modo==="terrestre"){ s.terrestre_tipo="FTL"; s.step="ter_origen"; await sendText(from,"🚛 *Terrestre FTL:* Indicá ciudad/país de ORIGEN."); }
        return res.sendStatus(200);
      }

      if (btnId==="mar_LCL" || btnId==="mar_FCL"){
        s.maritimo_tipo = (btnId==="mar_LCL") ? "LCL" : "FCL";
        if (s.maritimo_tipo==="FCL"){ s.step="mar_equipo"; await sendContenedores(from); }
        else { s.step="mar_origen"; await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen)."); }
        return res.sendStatus(200);
      }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        s.contenedor = btnId.replace("mar_FCL","");
        s.step="mar_origen";
        await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
        return res.sendStatus(200);
      }

      if (btnId==="aer_carga" || btnId==="aer_courier"){
        s.aereo_tipo = btnId==="aer_carga" ? "carga_general" : "courier";
        if (s.aereo_tipo==="carga_general"){ s.step="aer_origen"; await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad. Ej.: PVG / Shanghai)."); }
        else { s.step="courier_origen"; await sendText(from,"🌍 *País/Ciudad ORIGEN* (ej.: España / China / USA)."); }
        return res.sendStatus(200);
      }

      if (btnId==="confirmar"){ s.step="cotizar"; }
      if (btnId==="editar"){ await sendMainActions(from); s.step="ask_empresa"; return res.sendStatus(200); }
      if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); return res.sendStatus(200); }

      if (btnId==="exw_si"){ s.step="exw_dir"; await sendText(from,"📍 *Dirección EXW* (calle, ciudad, CP, país)."); return res.sendStatus(200); }
      if (btnId==="exw_no"){ s.step="ask_despacho"; await upsellDespacho(from); return res.sendStatus(200); }
      if (btnId==="desp_si"){ s.step="desp_valor"; await sendText(from,"💰 *Valor de la mercadería (USD)*"); return res.sendStatus(200); }
      if (btnId==="desp_no"){ sessions.delete(from); await sendText(from,"¡Gracias por tu consulta! 🙌\n📧 comercial@conektarsa.com"); return res.sendStatus(200); }

      // === CALCULADORA: botones ===
      if (s.step==="calc_modo" && btnId==="calc_maritimo"){ s.modo="maritimo"; s.step="calc_mar_tipo"; await sendTiposMaritimoCalc(from); return res.sendStatus(200); }
      if (s.step==="calc_modo" && btnId==="calc_aereo"){ s.modo="aereo"; s.step="calc_aer_origen"; await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad)"); return res.sendStatus(200); }

      if (s.step==="calc_mar_tipo" && btnId==="calc_mar_LCL"){ s.maritimo_tipo="LCL"; s.step="calc_mar_origen"; await sendText(from,"📍 *PUERTO ORIGEN* (ej.: Shanghai / Ningbo)"); return res.sendStatus(200); }
      if (s.step==="calc_mar_tipo" && btnId==="calc_mar_FCL"){ s.maritimo_tipo="FCL"; s.step="calc_fcl_equipo"; await sendContenedoresCalc(from); return res.sendStatus(200); }
      if (s.step==="calc_fcl_equipo" && ["calc_FCL20","calc_FCL40","calc_FCL40HC"].includes(btnId)){
        s.contenedor = btnId.replace("calc_FCL",""); s.step="calc_mar_origen";
        await sendText(from,"📍 *PUERTO ORIGEN* (ej.: Shanghai / Ningbo)"); return res.sendStatus(200);
      }
    }

    /* ===== TEXTO ===== */
    if (type==="text") {
      if (s.step==="ask_empresa"){
        s.empresa = text;
        s.askedEmpresa = true;
        await sendText(from, `Gracias. Empresa guardada: *${s.empresa}*`);
        await sendMainActions(from);
        return res.sendStatus(200);
      }

      // Cotizador (v2.8 intacto)
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

      if (s.step==="exw_dir"){ s.exw_dir = text; await sendText(from,"🧑‍💼 El equipo comercial está trabajando en la solicitud y te contactaremos en breve."); s.step="ask_despacho"; await upsellDespacho(from); return res.sendStatus(200); }

      if (s.step==="desp_valor"){ s.valor_mercaderia = text; s.step="desp_merc"; await sendText(from,"📦 *¿Qué mercadería es?*"); return res.sendStatus(200); }
      if (s.step==="desp_merc"){ s.tipo_mercaderia = text; await sendText(from,"Gracias, en breve nos comunicaremos contigo para brindarte la tarifa. 🙌"); sessions.delete(from); return res.sendStatus(200); }

      // === CALCULADORA: flujo texto ===
      if (s.step==="calc_producto"){
        s.calc.producto = text;
        s.step = "calc_fob";
        await sendText(from,"💵 Ingresá el *FOB total (USD)* (ej.: 12000)");
        return res.sendStatus(200);
      }
      if (s.step==="calc_fob"){
        const f = toNum(text); if (!isFinite(f) || f<=0){ await sendText(from,"Ingresá un número válido para *FOB*"); return res.sendStatus(200); }
        s.calc.fob = f; s.step="calc_vol";
        await sendText(from,"📦 Ingresá el *VOLUMEN total* en m³ (ej.: 8.5). Si no sabés, 0.");
        return res.sendStatus(200);
      }
      if (s.step==="calc_vol"){
        s.calc.vol = Math.max(0, toNum(text)||0); s.step="calc_peso";
        await sendText(from,"⚖️ Ingresá el *PESO total* en kg (ej.: 120). Si no tenés el dato, 0.");
        return res.sendStatus(200);
      }
      if (s.step==="calc_peso"){
        s.calc.kg = Math.max(0, toNum(text)||0); s.step="calc_modo";
        await sendModosCalc(from); return res.sendStatus(200);
      }
      if (s.step==="calc_aer_origen"){ s.origen_aeropuerto = text; s.step="calc_confirm"; }
      if (s.step==="calc_mar_origen"){ s.origen_puerto = text; s.step="calc_confirm"; }

      if (s.step==="calc_confirm"){
        const M = await getMatrix();
        const rec = pickCategory(M, s.calc.producto) || {};
        const { amount:freight, nota:fleteNota } = await estimarFleteParaCalc({
          modo: s.modo || "maritimo",
          maritimo_tipo: s.maritimo_tipo || "LCL",
          contenedor: s.contenedor || null,
          origen: s.modo==="aereo" ? s.origen_aeropuerto : s.origen_puerto,
          kg: s.calc.kg || 0, vol: s.calc.vol || 0
        });
        const R = calcularCosteo({
          fob_total: s.calc.fob,
          modo: s.modo || "maritimo",
          maritimo_tipo: s.maritimo_tipo || "LCL",
          contenedor: s.contenedor || null,
          kg: s.calc.kg || 0, vol: s.calc.vol || 0,
          matriz: rec, freight
        });

        const lineaFlete = `Flete (${(s.modo||"maritimo").toUpperCase()}${s.maritimo_tipo?` ${s.maritimo_tipo}`:""}${s.contenedor?` ${s.contenedor}`:""}): USD ${fmt(R.freight)}`;
        const resumen =
`📦 *Resultado estimado (FOB)*

FOB total: USD ${fmt(s.calc.fob)}
${lineaFlete}
Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmt(R.insurance)}
CIF: *USD ${fmt(R.cif)}*

🏛️ *Impuestos*
DI (${((rec.di??0)*100).toFixed(1)}%): USD ${fmt(R.di)}
Tasa Estadística (${((rec.tasa_est ?? TASA_ESTATISTICA)*100).toFixed(1)}% CIF): USD ${fmt(R.tasa)}
IVA (${((rec.iva??0)*100).toFixed(1)}%): USD ${fmt(R.iva)}
IVA Adic (${((rec.iva_adic??0)*100).toFixed(1)}%): USD ${fmt(R.iva_adic)}
IIBB (${((rec.iibb??0)*100).toFixed(1)}%): USD ${fmt(R.iibb)}
IIGG (${(RATE_IIGG*100).toFixed(1)}%): USD ${fmt(R.iigg)}${(rec.internos||0)>0 ? `\nInternos (${(rec.internos*100).toFixed(1)}%): USD ${fmt(R.internos)}` : ""}

*Impuestos totales:* USD ${fmt(R.impTot)}
*Costo aduanero (CIF + imp.):* *USD ${fmt(R.costoAduanero)}*

👨‍💼 *Despacho aduanero*
Honorarios (0.30% min USD 150 tope USD 5000): USD ${fmt(R.desp.honor)}
Gastos admin: USD ${fmt(R.desp.admin)}  •  Operativos: USD ${fmt(R.desp.oper)}
Total Despacho: *USD ${fmt(R.desp.total)}*

🎯 *Costo final estimado: USD ${fmt(R.costoFinal)}*

${fleteNota || ""}¿Querés volver al menú?`;

        await sendText(from, resumen);
        await sendButtons(from, "Elegí una opción:", [
          { id:"action_cotizar",  title:"💼 Cotizar Flete Int" },
          { id:"action_calcular", title:"🧮 Nuevo costeo" }
        ]);

        // Log del cálculo
        try{
          if (LOG_SHEET_ID && CALC_TAB){
            await sheetsClient().spreadsheets.values.append({
              spreadsheetId: LOG_SHEET_ID,
              range: `${CALC_TAB}!A1`,
              valueInputOption: "USER_ENTERED",
              requestBody:{ values:[[
                new Date().toISOString(), from, s.empresa||"",
                s.calc.producto||"", (s.modo||"").toUpperCase(), s.maritimo_tipo||"", s.contenedor||"",
                s.calc.fob||0, s.calc.vol||0, s.calc.kg||0,
                R.freight||0, R.insurance||0, R.cif||0,
                R.di||0, R.tasa||0, R.iva||0, R.iva_adic||0, R.iibb||0, R.iigg||0, R.internos||0,
                R.impTot||0, R.costoAduanero||0, R.desp.total||0, R.costoFinal||0,
                rec.categoria||"", rec.notas||""
              ]]}
            });
          }
        }catch(e){ console.warn("No pude loguear cálculo:", e.message); }

        s.step = "start";
        return res.sendStatus(200);
      }
    }

    /* ===== COTIZAR (v2.8 intacto) ===== */
    if (s.step==="cotizar"){
      try{
        if (s.modo==="aereo" && s.aereo_tipo==="carga_general"){
          const r = await cotizarAereo({ origen: s.origen_aeropuerto, kg: s.peso_kg||0, vol: s.vol_cbm||0 });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Aéreos*. Probá con ciudad o IATA (PVG, PEK, NRT)."); return res.sendStatus(200); }
          const unit = `USD ${fmt(r.pricePerKg)} por KG (FOB)`;
          const min  = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
          const resp =
`✅ *Tarifa estimada (AÉREO – Carga general)*
${unit} + *Gastos Locales*.${min}

*Kilos facturables:* ${r.facturableKg}
*Total estimado:* USD ${fmt(r.totalUSD)}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","aereo", s.origen_aeropuerto, r.destino, s.peso_kg||"", s.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.origen_aeropuerto}→${r.destino}`]);
        } else if (s.modo==="aereo" && s.aereo_tipo==="courier"){
          const r = await cotizarCourier({ pais: s.origen_aeropuerto, kg: s.peso_kg||0 });
          if (!r){ await sendText(from,"❌ No pude calcular *Courier*. Revisá la pestaña."); return res.sendStatus(200); }
          const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg.` : "";
          const resp =
`✅ *Tarifa estimada (COURIER)*
*Peso:* ${fmt(s.peso_kg)} kg${nota}
*Total:* USD ${fmt(r.totalUSD)} + *Gastos Locales*

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","courier", s.origen_aeropuerto, r.destino, s.peso_kg||"", "", "", r.totalUSD, `Courier ${s.origen_aeropuerto}`]);
        } else if (s.modo==="maritimo"){
          const modalidad = s.maritimo_tipo==="FCL" ? (s.contenedor?`FCL${s.contenedor}`:"FCL") : "LCL";
          const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
          if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*. Usá el nombre tal cual figura."); return res.sendStatus(200); }
          const resp =
`✅ *Tarifa estimada (Marítimo ${modalidad})*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.
*Origen:* ${s.origen_puerto}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.origen_puerto}→${r.destino}`]);
        } else if (s.modo==="terrestre"){
          const r = await cotizarTerrestre({ origen: s.origen_direccion || "" });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Terrestres*."); return res.sendStatus(200); }
          const resp =
`✅ *Tarifa estimada (TERRESTRE FTL)*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","terrestre", s.origen_direccion||"", r.destino, "", "", "FTL", r.totalUSD, `Terrestre ${s.origen_direccion}→${r.destino}`]);
        }

        await sendText(from, "✅ *Tu consulta ha sido registrada correctamente.*\nNuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n📧 comercial@conektarsa.com");
        s.step = "exw_q";
        // Si fue FTL, no preguntamos EXW:
        if (s.modo==="terrestre") {
          sessions.delete(from);
        } else {
          await sendButtons(from, "¿Tu carga es EXW?", [
            { id:"exw_si", title:"Sí" },
            { id:"exw_no", title:"No" }
          ]);
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
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo ✅ v3.0"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

app.listen(PORT, ()=> console.log(`🚀 Bot v3.0 en http://localhost:${PORT}`));
