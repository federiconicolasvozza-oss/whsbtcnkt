// index.js — Conektar S.A. • Bot Cotizaciones + Costeo Impo (ESM) • v3.3 (merge v3.2 + v3.1 hotfix + bits v3.0)
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

/* Matriz (calculadora) */
const MATRIX_SHEET_ID = (process.env.PRODUCT_MATRIX_SHEET_ID || TAR_SHEET_ID || "").trim();
const PRODUCT_MATRIX_TAB = (process.env.PRODUCT_MATRIX_TAB || "Clasificación").trim();

/* Parámetros de cálculo */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01);
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03);
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06);
/* Fallbacks costeo LCL (tomados de v3.0) */
const RATE_LCL_PER_TON      = Number(process.env.RATE_LCL_PER_TON      ?? 5);
const AR_LOCAL_CHARGES_LCL  = Number(process.env.AR_LOCAL_CHARGES_LCL  ?? 400);

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

/* ---- Menús / rating / upsell ---- */
const sendMainActions = (to) =>
  sendButtons(to, "¿Qué te gustaría hacer hoy?", [
    { id:"action_cotizar",  title:"💼 Cotiz. Flete" },
    { id:"action_calcular", title:"🧮 Costeo Impo" },
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
    { id:"rate_5", title:"⭐⭐⭐⭐⭐",   description:"Excelente" },
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
  sendButtons(to, "🧑‍⚖️ También somos *despachantes de aduana*. ¿Querés que te coticemos el servicio?", [
    { id:"desp_si", title:"🙋 Sí" },
    { id:"desp_no", title:"No, gracias" }
  ]);

const endFlow = async (to) => {
  await askReturnMenu(to);
  await sendReview(to);
};

/* ========= Tabs ========= */
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
    norm(r[iMod]).replace(/\s+/g,"") === norm(modalidad).replace(/\s+/g,"") &&
    (norm(r[iOrigen])===want || norm(r[iOrigen]).includes(want))
  );
  if (!row) return null;
  const base = toNum(row[iPrecio]);
  const total = (norm(modalidad)==="lcl" && isFinite(wm) && wm>0) ? base * wm : base;
  return { modalidad, tarifaBase: base, totalUSD: total, destino: "Puerto de Buenos Aires", wm };
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
  // cotizador
  modo:null, maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null, terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  // LCL extras
  lcl_tn:null, lcl_m3:null, lcl_stackable:null,
  // calculadora
  flow:null, producto_desc:null, categoria:null, matriz:null,
  fob_unit:null, cantidad:null, fob_total:null,
  vol_total:null, kg_total:null,
  calc_modo:null, calc_maritimo_tipo:null, calc_contenedor:null,
  // árbol
  sel_n1:null, sel_n2:null, sel_n3:null,
  _tree:null, _find:null
});
function getS(id){ if(!sessions.has(id)) sessions.set(id, { data: emptyState() }); return sessions.get(id); }

/* ========= Matriz (lectura + helpers) ========= */
async function readMatrix() {
  if (!MATRIX_SHEET_ID) return [];
  const rows = await readTabRange(MATRIX_SHEET_ID, PRODUCT_MATRIX_TAB, "A1:Z3000", ["clasificacion","clasificación","hoja 1"]);
  if (!rows.length) return [];
  const header = rows[0].map(h => (h||"").toString().trim());
  const find = (...lbl) => header.findIndex(h => lbl.map(x=>x.toLowerCase()).some(t => h.toLowerCase()===t || h.toLowerCase().includes(t)));

  const idx = {
    NIV1: find("NIVEL_1","NIVEL 1"),
    NIV2: find("NIVEL_2","NIVEL 2"),
    NIV3: find("NIVEL_3","NIVEL 3"),
    CAT : find("CATEGORIA","CATEGORÍA","CATEGORIA PRINCIPAL"),
    SUB : find("SUBCATEGORIA","SUBCATEGORÍA","UBCATEGORI","SUB CATEG"),
    TASA: find("Tasa Estad","Tasa estad","Tasa Estadisti","Tasa Estadística"),
    IVA : find("% IVA","IVA","IVA %"),
    IVA_A:find("IVA ADIC","% IVA ADICIONAL","IVA ADICIONAL"),
    DI  : find("DERECHOS IM","% DERECHOS","DERECHOS"),
    IIBB: find("% IIBB","IIBB"),
    IIGG: find("% IIGG","IIGG"),
    INT : find("IMPUESTOS INTE","IMPUESTOS INT","INTERNOS"),
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
const listFrom = (arr, pref) => arr.slice(0,10).map((t,i)=>({ id:`${pref}_${i}`, title: clip24(t), description: t.length>24?t:undefined }));

/* ========= UI calculadora ========= */
const askProdMetodo = (to) => sendButtons(to,
  "Sobre tu producto, ¿preferís *Descripción*, *Categoría* o ver *Populares*?",
  [{ id:"calc_desc", title:"📝 Descrip." },{ id:"calc_cat",  title:"📂 Categoría" },{ id:"calc_pop",  title:"⭐ Populares" }]
);
const populares = ["Cables USB-C","Memorias RAM","Afeitadoras","Batidora de mano","Auriculares BT","Químicos"];

/* ========= VERIFY ========= */
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ===== Ejecutar cotización al confirmar (hotfix) ===== */
async function ejecutarCotizacion(from, s){
  try{
    if (s.modo==="aereo" && s.aereo_tipo==="carga_general"){
      const r = await cotizarAereo({ origen: s.origen_aeropuerto, kg: s.peso_kg||0, vol: s.vol_cbm||0 });
      if (!r){ await sendText(from,"❌ No encontré esa ruta en *Aéreos*. Probá con ciudad o IATA (PVG, PEK, NRT)."); return; }
      const unit = `USD ${fmt(r.pricePerKg)} por KG (FOB)`;
      const min  = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
      const resp = `✅ *Tarifa estimada (AÉREO – Carga general)*
${unit} + *Gastos Locales*.${min}

*Kilos facturables:* ${r.facturableKg}
*Total estimado:* USD ${fmt(r.totalUSD)}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
      await sendText(from, resp);
      await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","aereo", s.origen_aeropuerto, r.destino, s.peso_kg||"", s.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.origen_aeropuerto}→${r.destino}`]);
    } else if (s.modo==="aereo" && s.aereo_tipo==="courier"){
      const r = await cotizarCourier({ pais: s.origen_aeropuerto, kg: s.peso_kg||0 });
      if (!r){ await sendText(from,"❌ No pude calcular *Courier*. Revisá la pestaña."); return; }
      const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg.` : "";
      const resp = `✅ *Tarifa estimada (COURIER)*
*Peso:* ${fmt(s.peso_kg)} kg${nota}
*Total:* USD ${fmt(r.totalUSD)} + *Gastos Locales*

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
      await sendText(from, resp);
      await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","courier", s.origen_aeropuerto, r.destino, s.peso_kg||"", "", "", r.totalUSD, `Courier ${s.origen_aeropuerto}`]);
    } else if (s.modo==="maritimo"){
      let texto = "";
      if (s.maritimo_tipo==="LCL"){
        const wm = Math.max((s.lcl_tn||0), (s.lcl_m3||0));
        const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad: "LCL", wm });
        if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*. Revisá la pestaña."); return; }
        texto = `✅ *Tarifa estimada (Marítimo LCL)*
W/M: ${fmt(wm)} (t vs m³)
Tarifa base: USD ${fmt(r.tarifaBase)} por W/M
*Total estimado:* USD ${fmt(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Apilable:* ${s.lcl_stackable===true?"Sí":s.lcl_stackable===false?"No":"(sin indicar)"}\n*Nota:* No incluye impuestos ni gastos locales.`;
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", "LCL", r.totalUSD, `Marítimo LCL ${s.origen_puerto}→${r.destino} WM:${wm}`]);
      } else { // FCL
        const modalidad = "FCL" + (s.contenedor||"");
        const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
        if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*."); return; }
        texto = `✅ *Tarifa estimada (Marítimo ${modalidad})*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.
*Origen:* ${s.origen_puerto}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.origen_puerto}→${r.destino}`]);
      }
      await sendText(from, texto);
    } else if (s.modo==="terrestre"){
      const r = await cotizarTerrestre({ origen: s.origen_direccion || "" });
      if (!r){ await sendText(from,"❌ No encontré esa ruta en *Terrestres*."); return; }
      const resp = `✅ *Tarifa estimada (TERRESTRE FTL)*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
      await sendText(from, resp);
      await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","terrestre", s.origen_direccion||"", r.destino, "", "", "FTL", r.totalUSD, `Terrestre ${s.origen_direccion}→${r.destino}`]);
    }

    await sendText(from, "✅ *Tu consulta fue registrada.* Nuestro equipo te contactará a la brevedad.\n📧 comercial@conektarsa.com");

    // siempre EXW → Upsell → cierre
    if (!(s.modo==="terrestre" && s.terrestre_tipo==="FTL")){
      await sendButtons(from, "¿Tu carga es EXW?", [
        { id:"exw_si", title:"Sí" },
        { id:"exw_no", title:"No" }
      ]);
      s.step="exw_q";
    } else {
      await endFlow(from);
      sessions.delete(from);
    }
  }catch(e){
    console.error("cotizar error", e);
    await sendText(from,"⚠️ Hubo un problema al leer la planilla. Revisá nombres de pestañas y permisos.");
  }
}

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
      await sleep(600);
      if (!s.askedEmpresa) {
        await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
        s.step = "ask_empresa";
        s.askedEmpresa = true;
      }
    };

    // Mensaje inicial / menú
    if (type==="text" && ["hola","buenas","menu","inicio","start","volver"].includes(lower)) {
      if (!s.welcomed) { await showWelcomeOnce(); }
      else { await sendMainActions(from); s.step="main"; }
      return res.sendStatus(200);
    }
    if (!s.welcomed) { await showWelcomeOnce(); return res.sendStatus(200); }

    /* ===== INTERACTIVE ===== */
    if (type==="interactive") {

      // ===== Menú principal
      if (btnId==="action_cotizar"){ s.flow=null; s.step="choose_modo"; await sendModos(from); return res.sendStatus(200); }
      if (btnId==="action_calcular"){ s.flow="calc"; s.step="calc_prod_m"; await askProdMetodo(from); return res.sendStatus(200); }

      // ===== Cotizador clásico
      if (btnId.startsWith("menu_")){
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
        return res.sendStatus(200);
      }

      if (btnId==="mar_LCL"){ s.maritimo_tipo = "LCL"; s.step="lcl_tn"; await sendText(from,"⚖️ *Toneladas (t)* (ej.: 2.5)."); return res.sendStatus(200); }
      if (btnId==="mar_FCL"){ s.maritimo_tipo = "FCL"; s.step="mar_equipo"; await sendContenedores(from); return res.sendStatus(200); }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        s.contenedor = btnId==="mar_FCL20" ? "20" : btnId==="mar_FCL40" ? "40" : "40HC";
        s.step="mar_origen"; await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen)."); return res.sendStatus(200);
      }

      if (btnId==="aer_carga" || btnId==="aer_courier"){
        s.aereo_tipo = btnId==="aer_carga" ? "carga_general" : "courier";
        if (s.aereo_tipo==="carga_general"){ s.step="aer_origen"; await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad. Ej.: PVG / Shanghai)."); }
        else { s.step="courier_origen"; await sendText(from,"🌍 *País/Ciudad ORIGEN* (ej.: España / China / USA)."); }
        return res.sendStatus(200);
      }

      // Confirmación de cotización (ejecuta)
      if (btnId==="confirmar"){ await ejecutarCotizacion(from, s); return res.sendStatus(200); }
      if (btnId==="editar"){ await sendMainActions(from); s.step="main"; return res.sendStatus(200); }
      if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); return res.sendStatus(200); }

      // EXW + Upsell
      if (btnId==="exw_si"){ s.step="exw_dir"; await sendText(from,"📍 *Dirección EXW* (calle, ciudad, CP, país)."); return res.sendStatus(200); }
      if (btnId==="exw_no"){ s.step="upsell"; await upsellDespacho(from); return res.sendStatus(200); }
      if (btnId==="desp_si"){ await sendText(from,"¡Genial! Nuestro equipo te contactará para cotizar el despacho. 🙌"); await endFlow(from); sessions.delete(from); return res.sendStatus(200); }
      if (btnId==="desp_no"){ await sendText(from,"¡Gracias por tu consulta! 🙌"); await endFlow(from); sessions.delete(from); return res.sendStatus(200); }

      // ===== Calculadora (árbol + búsqueda + populares)
      if (btnId==="calc_desc"){ s.step="calc_desc_wait"; await sendText(from,"Escribí una *breve descripción* (p.ej., “químicos”, “memorias RAM”)."); return res.sendStatus(200); }

      if (btnId==="calc_cat"){
        const M = await getMatrix(); const V = indexMatrix(M);
        const n1 = distinct(V, x=>x.niv1).filter(Boolean);
        await sendList(from, "Elegí *NIVEL 1*:", listFrom(n1,"n1"), "Nivel 1", "Elegir");
        s._tree = { V, n1 }; s.step="calc_n1_pick";
        return res.sendStatus(200);
      }
      if (btnId==="calc_pop"){
        await sendList(from, "⭐ Productos más consultados:", listFrom(populares,"pop"), "Populares", "Ver");
        s.step="calc_pop_pick";
        return res.sendStatus(200);
      }

      // árbol picks
      if (/^n1_\d+$/.test(btnId) && s.step==="calc_n1_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n1 = label;
        const V = s._tree.V;
        const n2 = distinct(V.filter(x=>x.niv1===label), x=>x.niv2).filter(Boolean);
        await sendList(from, "Elegí *NIVEL 2*:", listFrom(n2,"n2"), "Nivel 2", "Elegir");
        s._tree.n2 = n2; s.step="calc_n2_pick";
        return res.sendStatus(200);
      }
      if (/^n2_\d+$/.test(btnId) && s.step==="calc_n2_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n2 = label;
        const V = s._tree.V;
        const n3 = distinct(V.filter(x=>x.niv1===s.sel_n1 && x.niv2===label), x=>x.niv3).filter(Boolean);
        await sendList(from, "Elegí *NIVEL 3*:", listFrom(n3,"n3"), "Nivel 3", "Elegir");
        s._tree.n3 = n3; s.step="calc_n3_pick";
        return res.sendStatus(200);
      }
      if (/^n3_\d+$/.test(btnId) && s.step==="calc_n3_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n3 = label;
        const V = s._tree.V;
        const subs = distinct(V.filter(x=>x.niv1===s.sel_n1 && x.niv2===s.sel_n2 && x.niv3===label), x=>x.sub).filter(Boolean);
        await sendList(from, "Elegí la *Subcategoría*:", listFrom(subs,"sub"), "Subcategorías", "Elegir");
        s._tree.subs = subs; s.step="calc_sub_pick";
        return res.sendStatus(200);
      }
      if (/^sub_\d+$/.test(btnId) && s.step==="calc_sub_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        const M = await getMatrix();
        const fila = M.find(x => clip24(x.SUB)===clip24(label)) || M[0];
        s.matriz = fila;
        s.categoria = label;
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
        return res.sendStatus(200);
      }

      // búsqueda libre picks
      if (/^n3s_\d+$/.test(btnId) && s.step==="calc_find_n3_pick"){
        const title = msg.interactive?.list_reply?.title;
        s.sel_n3 = title;
        const { V } = s._find;
        const subs = distinct(V.filter(x=>x.niv3===title), x=>x.sub).filter(Boolean);
        await sendList(from, "Elegí la *subcategoría*:", listFrom(subs,"subf"), "Subcategorías", "Elegir");
        s._find.subs = subs; s.step="calc_find_sub_pick";
        return res.sendStatus(200);
      }
      if (/^subf_\d+$/.test(btnId) && s.step==="calc_find_sub_pick"){
        const label = msg.interactive?.list_reply?.title;
        const M = await getMatrix();
        const fila = M.find(x => clip24(x.SUB)===clip24(label)) || M[0];
        s.matriz = fila; s.categoria = label; s.producto_desc = `${s.sel_n3} / ${label}`;
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
        return res.sendStatus(200);
      }

      // Modo transporte (calculadora)
      if (btnId==="c_maritimo"){ s.calc_modo="maritimo"; s.step="c_mar_tipo"; await sendButtons(from,"Marítimo: ¿LCL o FCL?",[{id:"c_lcl",title:"LCL"},{id:"c_fcl",title:"FCL"}]); return res.sendStatus(200); }
      if (btnId==="c_aereo"){ s.calc_modo="aereo"; s.step="c_confirm"; await confirmCalc(from, s); return res.sendStatus(200); }
      if (btnId==="c_lcl"){ s.calc_maritimo_tipo="LCL"; s.step="c_confirm"; await confirmCalc(from,s); return res.sendStatus(200); }
      if (btnId==="c_fcl"){ s.calc_maritimo_tipo="FCL"; s.step="c_cont"; await sendContenedores(from); return res.sendStatus(200); }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId) && s.flow==="calc"){
        s.calc_contenedor = btnId==="mar_FCL20"?"20":btnId==="mar_FCL40"?"40":"40HC";
        s.step="c_confirm"; await confirmCalc(from,s); return res.sendStatus(200);
      }

      // Ejecutar costeo
      if (btnId==="calc_go"){
        await ejecutarCosteo(from, s);
        return res.sendStatus(200);
      }

      // rating + volver
      if (/^rate_[1-5]$/.test(btnId)){ await sendText(from,"¡Gracias por tu calificación! ⭐"); return res.sendStatus(200); }
      if (btnId==="menu_si"){ await sendMainActions(from); return res.sendStatus(200); }
      if (btnId==="menu_no"){ await sendText(from,"¡Gracias! Si necesitás algo más, escribinos cuando quieras."); return res.sendStatus(200); }
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
      if (s.step==="lcl_tn"){ const n = toNum(text); if(!isFinite(n)||n<0){await sendText(from,"Ingresá toneladas válidas (ej.: 2.5)"); return res.sendStatus(200);} s.lcl_tn=n; s.step="lcl_m3"; await sendText(from,"📦 *Volumen total (m³)* (ej.: 8.5)"); return res.sendStatus(200); }
      if (s.step==="lcl_m3"){ const n = toNum(text); if(!isFinite(n)||n<0){await sendText(from,"Ingresá m³ válidos (ej.: 8.5)"); return res.sendStatus(200);} s.lcl_m3=n; s.step="lcl_stack"; await sendButtons(from,"¿La mercadería es *apilable*?",[{id:"stk_si",title:"Sí"},{id:"stk_no",title:"No"}]); return res.sendStatus(200); }
      if (btnId==="stk_si" || btnId==="stk_no"){ s.lcl_stackable = (btnId==="stk_si"); s.step="mar_origen"; await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen)."); return res.sendStatus(200); }

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
          s.vol_cbm = Math.max(0, toNum(text)||0); s.vol_total = s.vol_cbm; s.step="calc_peso";
          await sendText(from,"⚖️ Ingresá el *PESO total* en kg (ej.: 120). Si no tenés el dato, 0."); return res.sendStatus(200);
        }
        if (s.step==="calc_peso"){
          s.peso_kg = Math.max(0, toNum(text)||0); s.kg_total = s.peso_kg;
          s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); return res.sendStatus(200);
        }
      }
    }

    return res.sendStatus(200);
  }catch(e){
    console.error("webhook error", e);
    return res.sendStatus(200);
  }
});

/* ========= HEALTH ========= */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo Impo ✅ v3.3 (merge)"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

/* ========= Start ========= */
app.listen(PORT, ()=> console.log(`🚀 Bot v3.3 en http://localhost:${PORT}`));

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
    `• FOB unit: *USD ${fmt(d.fob_unit||0)}* × *${d.cantidad||0}* = *USD ${fmt(d.fob_total||0)}*`,
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

/* ========= Costeo ========= */
function calcDespacho(cif){
  const base = cif * 0.003; // 0.30%
  const honor = Math.min(Math.max(base, 150), 5000);
  const total = honor + 20 + 100;
  return { honor, admin:20, oper:100, total };
}

async function estimarFleteParaCalc({ modo, maritimo_tipo, contenedor, origen, kg, vol }) {
  try{
    if (modo==="aereo") {
      const r = await cotizarAereo({ origen: origen||"", kg: kg||0, vol: (vol||0)*167 });
      if (r) return { amount: r.totalUSD, detalle:`Flete (AÉREO): USD ${fmt(r.totalUSD)}` };
    }
    if (modo==="maritimo") {
      if (maritimo_tipo==="LCL"){
        const wm = Math.max((kg||0)/1000, vol||0);
        const r = await cotizarMaritimo({ origen: origen||"", modalidad:"LCL", wm });
        if (r) return { amount: r.totalUSD, detalle:`Flete (MARÍTIMO LCL): USD ${fmt(r.totalUSD)}` };
      } else {
        const modalidad = contenedor?`FCL ${contenedor}`:"FCL";
        const r = await cotizarMaritimo({ origen: origen||"", modalidad });
        if (r) return { amount: r.totalUSD, detalle:`Flete (MARÍTIMO ${modalidad}): USD ${fmt(r.totalUSD)}` };
      }
    }
  }catch{}
  return { amount: 0, detalle: "Flete: sin tarifa (seguimos el cálculo y te contactamos)" };
}

async function ejecutarCosteo(to, s){
  const M = s.matriz || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa_est:TASA_ESTATISTICA, nota:"" };

  // flete estimado (opcional, solo si hay tarifa)
  let fleteUSD = 0, fDetalle = "Flete: sin tarifa (seguimos cálculo)";
  try{
    const est = await estimarFleteParaCalc({
      modo: s.calc_modo || "maritimo",
      maritimo_tipo: s.calc_maritimo_tipo || "LCL",
      contenedor: s.calc_contenedor || null,
      origen: (s.calc_modo==="aereo") ? (s.origen_aeropuerto || "Shanghai") : (s.origen_puerto || "Shanghai"),
      kg: s.peso_kg||s.kg_total||0,
      vol: s.vol_cbm||s.vol_total||0,
    });
    fleteUSD = est.amount || 0;
    fDetalle = est.detalle || fDetalle;
  }catch{}

  // Fallback si LCL y sin tarifa
  if (!isFinite(fleteUSD) || fleteUSD<=0){
    if ((s.calc_modo||"maritimo")==="maritimo" && (s.calc_maritimo_tipo||"LCL")==="LCL"){
      const kg = s.peso_kg||s.kg_total||0; const m3 = s.vol_cbm||s.vol_total||0;
      const wm = Math.max(kg/1000, m3);
      fleteUSD = wm*RATE_LCL_PER_TON + AR_LOCAL_CHARGES_LCL;
      fDetalle = `Flete (LCL fallback): USD ${fmt(fleteUSD)}`;
    }
  }

  const insurance = INSURANCE_RATE * (s.fob_total||0);
  const cif = (s.fob_total||0) + fleteUSD + insurance;

  const di     = cif * (M.di ?? 0);
  const tasa   = cif * (M.tasa_est ?? TASA_ESTATISTICA);
  const baseIVA= cif + di + tasa;
  const iva    = baseIVA * (M.iva ?? 0.21);
  const ivaAd  = baseIVA * (M.iva_ad ?? 0);
  const iibb   = cif * (M.iibb ?? 0.035);
  const iigg   = baseIVA * (M.iigg ?? RATE_IIGG);
  const internos = (M.internos ?? 0) > 0 ? cif * (M.internos||0) : 0;

  const impTotal = di + tasa + iva + ivaAd + iibb + iigg + internos;
  const costoAdu = cif + impTotal;

  const desp = calcDespacho(cif);
  const costoFinal = costoAdu + desp.total;

  const body = [
    "📦 *Resultado estimado (FOB)*",
    "",
    `FOB total: USD ${fmt(s.fob_total)}`,
    fDetalle,
    `Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmt(insurance)}`,
    `CIF: *USD ${fmt(cif)}*`,
    "",
    "🏛️ *Impuestos*",
    `DI (${((M.di||0)*100).toFixed(1)}%): USD ${fmt(di)}`,
    `Tasa Estadística (${((M.tasa_est ?? TASA_ESTATISTICA)*100).toFixed(1)}% CIF): USD ${fmt(tasa)}`,
    `IVA (${((M.iva||0)*100).toFixed(1)}%): USD ${fmt(iva)}`,
    `IVA Adic (${((M.iva_ad||0)*100).toFixed(1)}%): USD ${fmt(ivaAd)}`,
    `IIBB (${((M.iibb||0)*100).toFixed(1)}%): USD ${fmt(iibb)}`,
    `IIGG (${((M.iigg??RATE_IIGG)*100).toFixed(1)}%): USD ${fmt(iigg)}` + ((M.internos||0)>0?`\nInternos (${(M.internos*100).toFixed(1)}%): USD ${fmt(internos)}`:""),
    "",
    `*Impuestos totales:* USD ${fmt(impTotal)}`,
    `*Costo aduanero (CIF + imp.):* *USD ${fmt(costoAdu)}*`,
    "",
    "👨‍💼 *Despacho aduanero*",
    `Honorarios (0.30% min USD 150 tope USD 5000): USD ${fmt(desp.honor)}`,
    `Gastos admin: USD ${fmt(desp.admin)}  •  Operativos: USD ${fmt(desp.oper)}`,
    `Total Despacho: *USD ${fmt(desp.total)}*`,
    "",
    `🎯 *Costo final estimado: USD ${fmt(costoFinal)}*`,
    M.nota ? `\nNota: ${M.nota}` : ""
  ].join("\n");
  await sendText(to, body);

  await logCalculo([
    new Date().toISOString(), to, s.empresa, (s.producto_desc||s.categoria||s.sel_n3||""), (s.matriz?.SUB||s.matriz?.NIV3||""),
    s.fob_unit, s.cantidad, s.fob_total, s.peso_kg||s.kg_total, s.vol_cbm||s.vol_total,
    s.calc_modo||"", s.calc_maritimo_tipo||"", s.calc_contenedor||"",
    insurance, fleteUSD, cif, di, tasa, iva, ivaAd, iibb, iigg, internos, impTotal, costoAdu
  ]);

  await askReturnMenu(to);
  await sendReview(to);
  sessions.delete(to);
}
