// index.js — Conektar S.A. • Bot Cotizaciones + Costeo Impo (ESM) • v3.3 (fix costeo)
// Cambios clave v3.3:
// - Costeo: lectura de matriz robusta + fallback seguro (nunca impuestos en 0 por null)
// - Normalización consistente de encabezados y campos (iva_ad vs iva_adic)
// - Flujo calculadora unificado y estable (confirmación → ejecutarCosteo)
// - Estimación de flete integrada (usa cotizadores si hay, sino fallback LCL W/M)
// - Logs de cálculo a Sheet (opcional) y mensajes claros de error
// - Compatibilidad con el cotizador existente (no modificado)

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

/* Tarifas (cotizador) */
const TAR_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AER_HINT = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MAR_HINT = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TER_HINT = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COU_HINT = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();

const LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();
const TAB_CALCULOS = (process.env.TAB_CALCULOS || "Calculos").trim();

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);

const LOGO_URL = (process.env.LOGO_URL ||
  "https://conektarsa.com/wp-content/uploads/2025/09/conektar_400_neg.jpg").trim();

/* Matriz (costeo) */
const MATRIX_SHEET_ID = (process.env.PRODUCT_MATRIX_SHEET_ID || TAR_SHEET_ID || "").trim();
const PRODUCT_MATRIX_TAB = (process.env.PRODUCT_MATRIX_TAB || "Clasificación").trim();

/* Parámetros de cálculo */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01); // 1% FOB
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03); // 3% sobre CIF
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06); // 6% base IVA (no proviene de la planilla)
const RATE_LCL_PER_TON      = Number(process.env.RATE_LCL_PER_TON      ?? 5);     // fallback W/M cuando no hay tarifa LCL
const AR_LOCAL_CHARGES_LCL  = Number(process.env.AR_LOCAL_CHARGES_LCL  ?? 400);   // fallback gastos locales LCL

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

/* ---- Menús ---- */
const sendMainActions = (to) =>
  sendButtons(to, "¿Qué te gustaría hacer hoy?", [
    { id:"action_cotizar",  title:"💼 Cotiz. Flete" },
    { id:"action_calcular", title:"🧮 Costeo Impo" },
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

const contenedorFromButton = (id) => ({
  mar_FCL20: "20",
  mar_FCL40: "40",
  mar_FCL40HC: "40HC",
}[id] || null);

const askReturnMenu = (to) =>
  sendButtons(to, "¿Volvemos al menú?", [
    { id:"menu_si", title:"🔁 Sí, volver" },
    { id:"menu_no", title:"❌ No" },
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
    if (!LOG_SHEET_ID) return;
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
    if (!LOG_SHEET_ID) return;
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

/* ========= Cotizadores (tarifas) ========= */
async function cotizarAereo({ origen, kg, vol }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_AER_HINT, "A1:Z10000", ["aereos","aéreos","aereo"]);
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

async function cotizarMaritimo({ origen, modalidad, wm=null }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_MAR_HINT, "A1:Z10000", ["maritimos","marítimos","martimos","mar"]);
  if (!rows.length) throw new Error("Maritimos vacío");
  const header = rows[0], data = rows.slice(1);
  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iMod    = headerIndex(header,"modalidad");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio","usd/wm","wm");

  const want = norm(origen);
  const row = data.find(r =>
    norm(r[iDest]).includes("buenos aires") &&
    norm(r[iMod]) === norm(modalidad) &&
    (norm(r[iOrigen])===want || norm(r[iOrigen]).includes(want))
  );
  if (!row) return null;
  const base = toNum(row[iPrecio]);
  const total = (norm(modalidad)==="lcl" && isFinite(wm) && wm>0) ? base * wm : base;
  return { modalidad, price: base, totalUSD: total, destino: "Puerto de Buenos Aires" };
}

async function cotizarTerrestre({ origen }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_TER_HINT, "A1:Z10000", ["terrestres","terrestre"]);
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
  empresa:null, welcomed:false, askedEmpresa:false, step:"start",
  // Cotizador
  modo:null, maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null, terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  // Calculadora (costeo)
  calc: { producto:null, fob:0, vol:0, kg:0 },
  calc_modo:null, calc_maritimo_tipo:null, calc_contenedor:null,
});
function getS(id){ if(!sessions.has(id)) sessions.set(id, { data: emptyState() }); return sessions.get(id); }

/* ========= Matriz (lectura robusta + fallback) ========= */
async function readMatrix() {
  if (!MATRIX_SHEET_ID) return [];
  const rows = await readTabRange(MATRIX_SHEET_ID, PRODUCT_MATRIX_TAB, "A1:Z3000", ["clasificacion","clasificación","hoja 1"]).catch(()=>[]);
  if (!rows.length) return [];
  const header = rows[0].map(h => (h||"").toString());
  const idx = (/** @type {string[]} */ ...lbl) => header.findIndex(h => lbl.map(x=>x.toLowerCase()).some(t => h.toLowerCase()===t || h.toLowerCase().includes(t)));

  const I = {
    CATEG: idx("CATEGORIA","CATEGORÍA","SUBCATEGORIA","SUBCATEGORÍA","NIVEL_3","NIVEL 3","NIVEL_2","NIVEL 2","NIVEL_1","NIVEL 1"),
    TASA : idx("TASA ESTAD","Tasa Estad","Tasa estadística"),
    IVA  : idx("% IVA","IVA","IVA %"),
    IVA_A: idx("IVA ADIC","% IVA ADICIONAL","IVA ADICIONAL","IVA ADICION","IVA adicional"),
    DI   : idx("DERECHOS IM","% DERECHOS","DERECHOS"),
    IIBB : idx("% IIBB","IIBB"),
    IIGG : idx("% IIGG","IIGG"),
    INT  : idx("IMPUESTOS INT","IMPUESTOS INTERNOS","INTERNOS"),
    NOTA : idx("NOTAS","OBS"),
  };

  const data = rows.slice(1).map(r => ({
    categoria: (r[I.CATEG]||"").toString().trim() || "Genérica",
    tasa_est : isFinite(toNum(r[I.TASA])) ? toNum(r[I.TASA])/100 : TASA_ESTATISTICA,
    iva      : isFinite(toNum(r[I.IVA]))  ? toNum(r[I.IVA])/100  : 0.21,
    iva_ad   : isFinite(toNum(r[I.IVA_A]))? toNum(r[I.IVA_A])/100: 0.00,
    di       : isFinite(toNum(r[I.DI]))   ? toNum(r[I.DI])/100   : 0.14,
    iibb     : isFinite(toNum(r[I.IIBB])) ? toNum(r[I.IIBB])/100 : 0.035,
    iigg_opt : isFinite(toNum(r[I.IIGG])) ? toNum(r[I.IIGG])/100 : null, // si viene en planilla, opcional
    internos : isFinite(toNum(r[I.INT]))  ? toNum(r[I.INT])/100  : 0.00,
    nota     : (r[I.NOTA] || "").toString()
  })).filter(x => (x.categoria));

  return data;
}
let MATRIX_CACHE=null;
async function getMatrix(){
  if (MATRIX_CACHE) return MATRIX_CACHE;
  const m = await readMatrix();
  if (!m || !m.length) {
    console.error("[MATRIX] No pude leer la matriz. Uso fallback genérico.");
    MATRIX_CACHE = [{ categoria:"Genérica", tasa_est:TASA_ESTATISTICA, iva:0.21, iva_ad:0, di:0.14, iibb:0.035, iigg_opt:null, internos:0, nota:"Fallback genérico" }];
  } else {
    MATRIX_CACHE = m;
  }
  return MATRIX_CACHE;
}

function pickCategory(matrix, texto=""){
  if (!matrix?.length) return null;
  const base = norm(texto);
  let best = matrix[0], bestScore = -1;
  for (const m of matrix) {
    const words = norm(m.categoria || "").split(/\s+/).filter(Boolean);
    const s = words.reduce((a,w)=> a + (base.includes(w)?1:0), 0);
    if (s>bestScore){ best=m; bestScore=s; }
  }
  if (bestScore <= 0){
    const generic = matrix.find(x => /generica|gen[eé]rica/.test(norm(x.categoria)));
    return generic || best;
  }
  return best;
}

/* ========= Helpers de UI ========= */
function modoMayus(m) {
  const map = { aereo:"AÉREO", maritimo:"MARÍTIMO", terrestre:"TERRESTRE" };
  return map[m] || (m||"").toUpperCase();
}
function resumenCalc(d){
  const lines = [];
  lines.push("🧾 Revisá los datos del costeo:");
  lines.push(`• Producto: *${d.calc.producto || "-"}*`);
  lines.push(`• FOB total: *USD ${fmt(d.calc.fob||0)}*`);
  lines.push(`• Volumen: *${fmt(d.calc.vol||0)} m³*  • Peso: *${fmt(d.calc.kg||0)} kg*`);
  const modoStr = d.calc_modo ? modoMayus(d.calc_modo) : "-";
  const marStr  = d.calc_modo==="maritimo" ? ` • ${d.calc_maritimo_tipo||"-"}${d.calc_contenedor?` • Contenedor: ${d.calc_contenedor}`:""}` : "";
  lines.push(`• Modo: *${modoStr}*${marStr}`);
  lines.push("\n¿Confirmás para calcular?");
  return lines.join("\n");
}

const askResumenCalc = (to, d) =>
  sendButtons(to, resumenCalc(d), [
    { id:"calc_go",   title:"✅ Calcular" },
    { id:"calc_edit", title:"✏️ Editar" },
  ]);

/* ========= Motor de cálculo ========= */
async function estimarFleteParaCalc({ modo, maritimo_tipo, contenedor, origen, kg, vol }) {
  try{
    if (modo === "aereo"){
      const r = await cotizarAereo({ origen: origen||"Shanghai", kg: kg||0, vol: (vol||0)*167 });
      if (r) return { amount: r.totalUSD, label: `Flete (AÉREO)`, extra:"" };
    }
    if (modo === "maritimo"){
      if (maritimo_tipo === "LCL"){
        const wm = Math.max((kg||0)/1000, vol||0);
        const r = await cotizarMaritimo({ origen: origen||"Shanghai", modalidad:"LCL", wm });
        if (r) return { amount: r.totalUSD, label: `Flete (MARÍTIMO LCL)`, extra: `W/M=${fmt(wm)}` };
      } else {
        const modalidad = contenedor ? `FCL ${contenedor}` : "FCL";
        const r = await cotizarMaritimo({ origen: origen||"Shanghai", modalidad });
        if (r) return { amount: r.totalUSD, label: `Flete (MARÍTIMO ${modalidad})`, extra:"" };
      }
    }
  }catch(e){ console.warn("[Costeo] No pude tomar tarifa exacta:", e?.message||e); }

  // Fallback si no hay tarifa: LCL simple W/M + locales
  if (modo === "maritimo" && maritimo_tipo === "LCL"){
    const wm = Math.max((kg||0)/1000, vol||0);
    return { amount: wm*RATE_LCL_PER_TON + AR_LOCAL_CHARGES_LCL, label:"Flete (LCL Fallback)", extra:`W/M=${fmt(wm)}` };
  }
  return { amount: 0, label:"Flete (sin tarifa)", extra:"seguimos cálculo" };
}

function calcularCosteo({ fob_total=0, matriz, freight=0 }){
  const insurance = fob_total * INSURANCE_RATE;
  const cif = fob_total + freight + insurance;

  const tasa = cif * (matriz?.tasa_est ?? TASA_ESTATISTICA);
  const di   = cif * (matriz?.di ?? 0);
  const baseIVA = cif + di + tasa;

  const iva    = baseIVA * (matriz?.iva ?? 0.21);
  const iva_ad = baseIVA * (matriz?.iva_ad ?? 0);
  const iibb   = cif * (matriz?.iibb ?? 0.035);
  const iiggRate = (matriz?.iigg_opt ?? RATE_IIGG); // si la planilla trae IIGG se respeta; si no, ENV
  const iigg   = baseIVA * iiggRate;
  const internos = (matriz?.internos ?? 0) > 0 ? cif * (matriz?.internos||0) : 0;

  const impTotal = di + tasa + iva + iva_ad + iibb + iigg + internos;
  const costoAdu = cif + impTotal;

  // Despacho (mismo criterio que versiones previas)
  const base = cif * 0.003; // 0.30%
  const honor = Math.min(Math.max(base, 150), 5000);
  const admin = 20, oper = 100;
  const despTotal = honor + admin + oper;
  const costoFinal = costoAdu + despTotal;

  return { insurance, cif, di, tasa, iva, iva_ad, iibb, iiggRate, iigg, internos, impTotal, costoAdu, honor, admin, oper, despTotal, costoFinal };
}

async function ejecutarCosteo(to, s){
  // 1) Matriz (categoría) por descripción
  const M = await getMatrix();
  const categoria = pickCategory(M, s.calc.producto||"") || M[0];

  // 2) Flete estimado
  const origen = s.calc_modo === "aereo" ? (s.origen_aeropuerto||"Shanghai") : (s.origen_puerto||"Shanghai");
  const f = await estimarFleteParaCalc({
    modo: s.calc_modo || "maritimo",
    maritimo_tipo: s.calc_maritimo_tipo || (s.calc_modo==="maritimo"?"LCL":null),
    contenedor: s.calc_contenedor || null,
    origen,
    kg: s.calc.kg || 0,
    vol: s.calc.vol || 0
  });

  // 3) Cálculo
  const R = calcularCosteo({ fob_total: s.calc.fob||0, matriz: categoria, freight: f.amount||0 });

  // 4) Mensaje
  const body = [
    "📦 *Resultado estimado (FOB)*",
    "",
    `FOB total: USD ${fmt(s.calc.fob)}`,
    `${f.label}: USD ${fmt(f.amount)}${f.extra?`  (${f.extra})`:""}`,
    `Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmt(R.insurance)}`,
    `CIF: *USD ${fmt(R.cif)}*`,
    "",
    "🏛️ *Impuestos*",
    `DI (${((categoria.di||0)*100).toFixed(1)}%): USD ${fmt(R.di)}`,
    `Tasa Estadística (${(((categoria.tasa_est ?? TASA_ESTATISTICA))*100).toFixed(1)}% CIF): USD ${fmt(R.tasa)}`,
    `IVA (${((categoria.iva||0)*100).toFixed(1)}%): USD ${fmt(R.iva)}`,
    `IVA Adic (${((categoria.iva_ad||0)*100).toFixed(1)}%): USD ${fmt(R.iva_ad)}`,
    `IIBB (${((categoria.iibb||0)*100).toFixed(1)}%): USD ${fmt(R.iibb)}`,
    `IIGG (${((R.iiggRate)*100).toFixed(1)}%): USD ${fmt(R.iigg)}` + ((categoria.internos||0)>0?`\nInternos (${(categoria.internos*100).toFixed(1)}%): USD ${fmt(R.internos)}`:""),
    "",
    `*Impuestos totales:* USD ${fmt(R.impTotal)}`,
    `*Costo aduanero (CIF + imp.):* *USD ${fmt(R.costoAdu)}*`,
    categoria.nota ? `\nNota: ${categoria.nota}` : "",
    "",
    "👨‍💼 *Despacho aduanero*",
    `Honorarios (0.30% min USD 150 tope USD 5000): USD ${fmt(R.honor)}`,
    `Gastos admin: USD ${fmt(R.admin)}  •  Operativos: USD ${fmt(R.oper)}`,
    `Total Despacho: *USD ${fmt(R.despTotal)}*`,
    "",
    `🎯 *Costo final estimado: USD ${fmt(R.costoFinal)}*`
  ].join("\n");

  await sendText(to, body);

  // 5) Log opcional
  try{
    await logCalculo([
      new Date().toISOString(), to, s.empresa, s.calc.producto||"",
      s.calc_modo||"", s.calc_maritimo_tipo||"", s.calc_contenedor||"",
      s.calc.fob||0, s.calc.vol||0, s.calc.kg||0,
      f.amount||0, R.insurance, R.cif, R.di, R.tasa, R.iva, R.iva_ad, R.iibb, R.iigg, R.internos, R.impTotal, R.costoAdu
    ]);
  }catch(e){ console.warn("logCalculo fallo:", e?.message||e); }

  await askReturnMenu(to);
  sessions.delete(to);
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
    const btnId = (type==="interactive") ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "") : "";

    // Bienvenida ÚNICA
    const showWelcomeOnce = async () => {
      if (s.welcomed) return;
      s.welcomed = true;
      await sendImage(
        from,
        LOGO_URL,
        "¡Bienvenido/a al *Asistente Virtual de Conektar*! 🙌\n" +
        "Acá vas a poder *cotizar fletes internacionales* y *estimar el costo de tu importación*."
      );
      await sleep(500);
      if (!s.askedEmpresa) {
        await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
        s.step = "ask_empresa";
        s.askedEmpresa = true;
      }
    };

    // Primera interacción
    if (!s.welcomed) { await showWelcomeOnce(); return res.sendStatus(200); }

    // Comandos globales
    if (type==="text" && ["menu","inicio","start","volver"].includes(lower)) {
      if (lower==="inicio") { sessions.delete(from); getS(from); }
      await sendMainActions(from);
      return res.sendStatus(200);
    }

    /* ===== BOTONES / LISTAS ===== */
    if (type==="interactive") {
      // Menú principal
      if (btnId==="action_cotizar"){ s.step="choose_modo"; await sendModos(from); return res.sendStatus(200); }
      if (btnId==="action_calcular"){ s.step="calc_producto"; s.calc={ producto:null, fob:0, vol:0, kg:0 }; s.calc_modo=null; s.calc_maritimo_tipo=null; s.calc_contenedor=null; await sendText(from,"📝 Describí el *producto* (ej.: cables USB-C)"); return res.sendStatus(200); }

      // Cotizador clásico (se mantiene igual)
      if (btnId.startsWith("menu_")){
        s.modo = btnId.slice("menu_".length);
        if (s.modo==="maritimo"){ s.step="mar_tipo"; await sendTiposMaritimo(from); }
        if (s.modo==="aereo"){ s.step="aereo_subtipo"; await sendButtons(from, "✈️ *Aéreo:* ¿Qué necesitás cotizar?", [ { id:"aer_carga", title:"Carga gral." }, { id:"aer_courier", title:"Courier" } ] ); }
        if (s.modo==="terrestre"){ s.terrestre_tipo="FTL"; s.step="ter_origen"; await sendText(from,"🚛 *Terrestre FTL:* Indicá ciudad/país de ORIGEN."); }
        return res.sendStatus(200);
      }
      if (btnId==="mar_LCL"){ s.maritimo_tipo = "LCL"; s.step="mar_origen"; await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen)."); return res.sendStatus(200); }
      if (btnId==="mar_FCL"){ s.maritimo_tipo = "FCL"; s.step="mar_equipo"; await sendContenedores(from); return res.sendStatus(200); }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        s.contenedor = contenedorFromButton(btnId);
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
      if (btnId==="editar"){ await sendMainActions(from); s.step="main"; return res.sendStatus(200); }
      if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); return res.sendStatus(200); }

      // ===== Calculadora =====
      if (btnId==="calc_edit"){ s.step="calc_producto"; await sendText(from,"📝 Describí el *producto* (ej.: cables USB-C)"); return res.sendStatus(200); }
      if (btnId==="calc_go"){ await ejecutarCosteo(from, s); return res.sendStatus(200); }
      if (btnId==="calc_modo_aer"){ s.calc_modo="aereo"; s.step="calc_aer_origen"; await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad)"); return res.sendStatus(200); }
      if (btnId==="calc_modo_mar"){ s.calc_modo="maritimo"; s.step="calc_mar_tipo"; await sendButtons(from,"Marítimo: ¿LCL o FCL?",[{id:"calc_lcl",title:"LCL"},{id:"calc_fcl",title:"FCL"}]); return res.sendStatus(200); }
      if (btnId==="calc_lcl"){ s.calc_maritimo_tipo="LCL"; s.step="calc_mar_origen"; await sendText(from,"📍 *PUERTO ORIGEN* (ej.: Shanghai / Ningbo)"); return res.sendStatus(200); }
      if (btnId==="calc_fcl"){ s.calc_maritimo_tipo="FCL"; s.step="calc_fcl_eq"; await sendContenedores(from); return res.sendStatus(200); }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId) && s.step==="calc_fcl_eq"){
        s.calc_contenedor = contenedorFromButton(btnId);
        s.step="calc_mar_origen"; await sendText(from,"📍 *PUERTO ORIGEN* (ej.: Shanghai / Ningbo)"); return res.sendStatus(200);
      }

      // Rating + volver
      if (btnId==="exw_si"){
        s.step = "exw_dir";
        await sendText(from, "Perfecto, indicá la *dirección EXW* (empresa y domicilio).");
        return res.sendStatus(200);
      }
      if (btnId==="exw_no"){
        await sendText(from, "¡Gracias por la info!");
        await askReturnMenu(from);
        return res.sendStatus(200);
      }

      if (/^menu_(si|no)$/.test(btnId)){
        if (btnId==="menu_si") await sendMainActions(from); else await sendText(from,"¡Gracias! Si necesitás algo más, escribinos cuando quieras.");
        return res.sendStatus(200);
      }

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
      if (s.step==="mar_origen"){ s.origen_puerto = text; await sendButtons(from, "¿Confirmás para cotizar?", [{id:"confirmar",title:"✅ Confirmar"},{id:"editar",title:"✏️ Editar"},{id:"cancelar",title:"Cancelar"}]); return res.sendStatus(200); }
      if (s.step==="aer_origen"){ s.origen_aeropuerto = text; s.step="aer_peso"; await sendText(from,"⚖️ *Peso (kg)* (entero)."); return res.sendStatus(200); }
      if (s.step==="aer_peso"){ const peso = toNum(text); if (isNaN(peso)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); } s.peso_kg = Math.max(0, Math.round(peso)); s.step="aer_vol"; await sendText(from,"📦 *Peso volumétrico (kg)* (poné 0 si no sabés)."); return res.sendStatus(200); }
      if (s.step==="aer_vol"){ const vol = toNum(text); if (isNaN(vol)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); } s.vol_cbm = Math.max(0, vol); await sendButtons(from, "¿Confirmás para cotizar?", [{id:"confirmar",title:"✅ Confirmar"},{id:"editar",title:"✏️ Editar"},{id:"cancelar",title:"Cancelar"}]); return res.sendStatus(200); }
      if (s.step==="courier_origen"){ s.origen_aeropuerto = text; s.step="courier_peso"; await sendText(from,"⚖️ *Peso (kg)* (podés usar decimales)."); return res.sendStatus(200); }
      if (s.step==="courier_peso"){ const peso = toNum(text); if (isNaN(peso)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); } s.peso_kg = peso; await sendButtons(from, "¿Confirmás para cotizar?", [{id:"confirmar",title:"✅ Confirmar"},{id:"editar",title:"✏️ Editar"},{id:"cancelar",title:"Cancelar"}]); return res.sendStatus(200); }
      if (s.step==="ter_origen"){ s.origen_direccion = text; await sendButtons(from, "¿Confirmás para cotizar?", [{id:"confirmar",title:"✅ Confirmar"},{id:"editar",title:"✏️ Editar"},{id:"cancelar",title:"Cancelar"}]); return res.sendStatus(200); }

      // === Calculadora (costeo) ===
      if (s.step==="calc_producto"){ s.calc.producto = text; s.step="calc_fob"; await sendText(from,"💵 Ingresá el *FOB total (USD)* (ej.: 12000)"); return res.sendStatus(200); }
      if (s.step==="calc_fob"){ const f = toNum(text); if (!isFinite(f)||f<=0){ await sendText(from,"Ingresá un número válido para *FOB*"); return res.sendStatus(200); } s.calc.fob=f; s.step="calc_vol"; await sendText(from,"📦 Ingresá el *VOLUMEN total* en m³ (ej.: 8.5). Si no sabés, 0."); return res.sendStatus(200); }
      if (s.step==="calc_vol"){ s.calc.vol = Math.max(0, toNum(text)||0); s.step="calc_peso"; await sendText(from,"⚖️ Ingresá el *PESO total* en kg (ej.: 120). Si no tenés el dato, 0."); return res.sendStatus(200); }
      if (s.step==="calc_peso"){ s.calc.kg = Math.max(0, toNum(text)||0); s.step="calc_modo_select"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"calc_modo_aer",title:"✈️ Aéreo"},{id:"calc_modo_mar",title:"🚢 Marítimo"}]); return res.sendStatus(200); }
      if (s.step==="calc_aer_origen"){ s.origen_aeropuerto = text; s.calc_modo="aereo"; s.step="calc_confirm"; await askResumenCalc(from, s); return res.sendStatus(200); }
      if (s.step==="calc_mar_origen"){ s.origen_puerto = text; s.calc_modo="maritimo"; s.step="calc_confirm"; await askResumenCalc(from, s); return res.sendStatus(200); }
      if (s.step==="exw_dir"){ s.exw_dir = text; await sendText(from, `Dirección EXW recibida: *${s.exw_dir}*`); await askReturnMenu(from); s.step="main"; return res.sendStatus(200); }
    }

    /* ===== COTIZAR (ejecución) ===== */
    if (s.step==="cotizar"){
      try{
        if (s.modo==="aereo" && s.aereo_tipo==="carga_general"){
          const r = await cotizarAereo({ origen: s.origen_aeropuerto, kg: s.peso_kg||0, vol: s.vol_cbm||0 });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Aéreos*. Probá con ciudad o IATA (PVG, PEK, NRT)."); return res.sendStatus(200); }
          const unit = `USD ${fmt(r.pricePerKg)} por KG (FOB)`;
          const min  = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
          const resp = `✅ *Tarifa estimada (AÉREO – Carga general)*\n${unit} + *Gastos Locales*.${min}\n\n*Kilos facturables:* ${r.facturableKg}\n*Total estimado:* USD ${fmt(r.totalUSD)}\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","aereo", s.origen_aeropuerto, r.destino, s.peso_kg||"", s.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.origen_aeropuerto}→${r.destino}`]);
        } else if (s.modo==="aereo" && s.aereo_tipo==="courier"){
          const r = await cotizarCourier({ pais: s.origen_aeropuerto, kg: s.peso_kg||0 });
          if (!r){ await sendText(from,"❌ No pude calcular *Courier*. Revisá la pestaña."); return res.sendStatus(200); }
          const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg.` : "";
          const resp = `✅ *Tarifa estimada (COURIER)*\n*Peso:* ${fmt(s.peso_kg)} kg${nota}\n*Total:* USD ${fmt(r.totalUSD)} + *Gastos Locales*\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","courier", s.origen_aeropuerto, r.destino, s.peso_kg||"", "", "", r.totalUSD, `Courier ${s.origen_aeropuerto}`]);
        } else if (s.modo==="maritimo"){
          let texto = "";
          if (s.maritimo_tipo==="LCL"){
            const wm = Math.max( (s.peso_kg||0)/1000, (s.vol_cbm||0) );
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad: "LCL", wm });
            if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*. Revisá la pestaña."); return res.sendStatus(200); }
            texto = `✅ *Tarifa estimada (Marítimo LCL)*\nW/M: ${fmt(wm)} (t vs m³)\nTarifa base: USD ${fmt(r.price)} por W/M\n*Total estimado:* USD ${fmt(r.totalUSD)} + *Gastos Locales*.\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", "LCL", r.totalUSD, `Marítimo LCL ${s.origen_puerto}→${r.destino} WM:${wm}`]);
          } else {
            const modalidad = s.contenedor ? `FCL ${s.contenedor}` : "FCL";
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
            if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*."); return res.sendStatus(200); }
            texto = `✅ *Tarifa estimada (Marítimo ${modalidad})*\nUSD ${fmt(r.totalUSD)} + *Gastos Locales*.\n*Origen:* ${s.origen_puerto}\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.origen_puerto}→${r.destino}`]);
          }
          await sendText(from, texto);
        } else if (s.modo==="terrestre"){
          const r = await cotizarTerrestre({ origen: s.origen_direccion || "" });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Terrestres*."); return res.sendStatus(200); }
          const resp = `✅ *Tarifa estimada (TERRESTRE FTL)*\nUSD ${fmt(r.totalUSD)} + *Gastos Locales*.\n\n*Validez:* ${VALIDEZ_DIAS} días\n*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","terrestre", s.origen_direccion||"", r.destino, "", "", "FTL", r.totalUSD, `Terrestre ${s.origen_direccion}→${r.destino}`]);
        }

        await sendText(from, "✅ *Tu consulta fue registrada.* Nuestro equipo te contactará a la brevedad.\n📧 comercial@conektarsa.com");

        if (!(s.modo==="terrestre" && s.terrestre_tipo==="FTL")){
          await sendButtons(from, "¿Tu carga es EXW?", [ { id:"exw_si", title:"Sí" }, { id:"exw_no", title:"No" } ]);
          s.step="exw_q";
        } else {
          await askReturnMenu(from);
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
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo Impo ✅ v3.3"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

/* ========= Start ========= */
app.listen(PORT, ()=> console.log(`🚀 Bot v3.3 en http://localhost:${PORT}`));
