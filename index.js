// index.js — Conektar S.A. • Bot de Cotizaciones + Costeo de Impo (ESM) • v3.0 (modificado con doble búsqueda)
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

/* Tarifas (cotizador clásico – SIN cambios funcionales) */
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

/* Matriz (calculadora) */
const MATRIX_SHEET_ID = (process.env.PRODUCT_MATRIX_SHEET_ID || TAR_SHEET_ID || "").trim();
const PRODUCT_MATRIX_TAB = (process.env.PRODUCT_MATRIX_TAB || "Clasificación").trim();
const TAB_CALCULOS = (process.env.TAB_CALCULOS || "Calculos").trim();

/* Parámetros de cálculo */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01); // 1% FOB
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03); // 3% sobre CIF
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06); // 6% base IVA (fijo)

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
const sheetsClient = (sheetId) => google.sheets({ version: "v4", auth: getOAuth() });

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
      action:{ buttons: buttons.map(b=>({ type:"reply", reply:{ id:b.id, title:b.title.slice(0,20) } })) }
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
      action: { button: btnTitle.slice(0,20), sections: [{ title: sectionTitle.slice(0,24), rows }] }
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

const rateList = (to) => {
  const rows = Array.from({length:10},(_,i)=>({
    id:`rate_${i+1}`, title:`${i+1}`, description: i<4?"Podría mejorar": i<8?"Bien":"Excelente"
  }));
  return sendList(to, "¿Cómo calificarías al bot del 1 al 10?", rows, "Calificación", "Elegir");
};
const endMenu = async (to) => {
  await sendMainActions(to);
  await rateList(to);
};

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
  // comunes
  empresa:null, welcomed:false, step:"start",
  // cotizador
  modo:null, maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null, terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  // calculadora
  flow:null, producto_desc:null, categoria:null, matriz:null,
  fob_unit:null, cantidad:null, fob_total:null, // totales
  calc_modo:null, calc_maritimo_tipo:null, calc_contenedor:null,
  // nuevo para jerarquía
  nivel1:null, nivel2:null, nivel3:null, subcat:null
});
function getS(id){ if(!sessions.has(id)) sessions.set(id, { data: emptyState() }); return sessions.get(id); }

/* ========= Matriz (lectura y búsqueda) ========= */
async function readMatrix() {
  if (!MATRIX_SHEET_ID) return { list: [], tree: {} };
  const rows = await readTabRange(MATRIX_SHEET_ID, PRODUCT_MATRIX_TAB, "A1:Z2000", ["clasificacion","clasificación","hoja 1"]);
  if (!rows.length) return { list: [], tree: {} };
  const header = rows[0].map(h => (h||"").toString().trim());
  const find = (...lbl) => header.findIndex(h => lbl.map(x=>x.toLowerCase()).some(t => h.toLowerCase()===t || h.toLowerCase().includes(t)));

  const idx = {
    NIV1: find("NIVEL_1","NIVEL 1"),
    NIV2: find("NIVEL_2","NIVEL 2"),
    NIV3: find("NIVEL_3","NIVEL 3"),
    SUB:  find("SUBCATEGORIA","SUBCATEGORÍA"),
    TASA: find("TASA ESTADISTICA","TASA EST"),
    IVA:  find("% IVA","IVA","IVA %"),
    IVA_A:find("IVA ADIC","% IVA ADICIONAL","IVA ADICIONAL"),
    DI:   find("DERECHOS IM","% DERECHOS","DERECHOS"),
    IIBB: find("% IIBB","IIBB"),
    IIGG: find("% IIGG","IIGG"),
    INT:  find("IMPUESTOS INT","INTERNOS"),
    NOTA: find("NOTAS","OBS"),
  };

  const list = [];
  const tree = {}; // NIV1 -> { NIV2 -> { NIV3 -> { SUB -> row } } }
  for (let i=1; i<rows.length; i++) {
    const r = rows[i] || [];
    const entry = {
      cat: r[idx.SUB] || r[idx.NIV3] || r[idx.NIV2] || r[idx.NIV1] || "",
      tasa_est: toNum(r[idx.TASA]??3),
      iva: toNum(r[idx.IVA]??0)/100,
      iva_ad: toNum(r[idx.IVA_A]??0)/100,
      di: toNum(r[idx.DI]??0)/100,
      iibb: toNum(r[idx.IIBB]??3.5)/100,
      iigg: isNaN(toNum(r[idx.IIGG])) ? RATE_IIGG : (toNum(r[idx.IIGG])/100),
      internos: toNum(r[idx.INT]??0)/100,
      nota: r[idx.NOTA] || ""
    };
    if (entry.cat) list.push(entry);

    // Construir árbol
    const n1 = norm(r[idx.NIV1] || "");
    const n2 = norm(r[idx.NIV2] || "");
    const n3 = norm(r[idx.NIV3] || "");
    const sub = norm(r[idx.SUB] || "");
    if (n1) {
      if (!tree[n1]) tree[n1] = {};
      if (n2 && !tree[n1][n2]) tree[n1][n2] = {};
      if (n3 && n2) {
        if (!tree[n1][n2][n3]) tree[n1][n2][n3] = {};
        if (sub) tree[n1][n2][n3][sub] = entry;
      } else if (sub) {
        // Fallback si no hay NIV3
        if (!tree[n1][n2]) tree[n1][n2] = {};
        tree[n1][n2][sub] = entry;
      }
    }
  }
  return { list, tree };
}
let MATRIX_CACHE=null;
async function getMatrix(){ if (MATRIX_CACHE) return MATRIX_CACHE; MATRIX_CACHE = await readMatrix(); return MATRIX_CACHE||{list:[],tree:{}}; }

function pickMatches(list, query){
  const q = norm(query);
  const scored = list.map(x=>{
    const c = norm(x.cat);
    const s = q.split(/\s+/).filter(Boolean).reduce((acc,w)=> acc + (c.includes(w)?1:0), 0);
    return { ...x, _s:s };
  }).filter(x=>x._s>0).sort((a,b)=>b._s-a._s);
  return scored.slice(0,10);
}

/* ========= UI de calculadora ========= */
const askProdMetodo = (to) => sendButtons(to,
  "Sobre tu producto, ¿preferís *Descripción*, *Categoría*, *Jerarquía* o ver *Populares*?",
  [
    { id:"calc_desc", title:"📝 Descrip." },
    { id:"calc_cat",  title:"📂 Categoría" },
    { id:"calc_hier", title:"🌳 Jerarquía" },
    { id:"calc_pop",  title:"⭐ Populares" },
  ]
);
const populares = ["Cables USB-C","Memorias RAM","Afeitadoras","Batidora de mano","Auriculares BT","Químicos"];
const listFromArray = (arr, prefix, descFn = (t) => undefined) =>
  arr.slice(0,10).map((t,i)=>({ id:`${prefix}_${i}`, title:t.slice(0,24), description: descFn(t) || (t.length>24 ? t : undefined) }));

const askCalcModos = (to) => sendButtons(to, "Elegí el modo de transporte:", [
  { id:"c_maritimo", title:"🚢 Marítimo" },
  { id:"c_aereo",    title:"✈️ Aéreo" },
]);

const askMarTipo = (to) => sendButtons(to, "Marítimo: ¿LCL o FCL?", [
  { id:"c_lcl", title:"LCL" },
  { id:"c_fcl", title:"FCL" },
]);
const askCont = (to) => sendContenedores(to);

function confirmCalc(to, d){
  const lines = [
    "Revisá los datos 👇",
    `• Empresa: *${d.empresa}*`,
    `• Producto: *${d.producto_desc || d.categoria}*`,
    `• FOB unit: *USD ${fmt(d.fob_unit)}* × *${d.cantidad}* = *USD ${fmt(d.fob_total)}*`,
    `• Volumen: *${fmt(d.vol_cbm)} m³*  • Peso: *${fmt(d.peso_kg)} kg*`,
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

function showRowInfo(to, row){
  const lines = [
    "📋 *Información de la categoría:*",
    `Categoría: *${row.cat}*`,
    `Tasa Estadística: ${row.tasa_est}%`,
    `IVA: ${(row.iva*100).toFixed(1)}%`,
    `IVA Adicional: ${(row.iva_ad*100).toFixed(1)}%`,
    `DI: ${(row.di*100).toFixed(1)}%`,
    `IIBB: ${(row.iibb*100).toFixed(1)}%`,
    `IIGG: ${(row.iigg*100).toFixed(1)}%`,
    `Internos: ${(row.internos*100).toFixed(1)}%`,
    row.nota ? `Notas: ${row.nota}` : ""
  ].join("\n");
  sendText(to, lines);
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

    // Bienvenida (logo + texto) → luego pedir empresa
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
    };

    // Comandos globales
    if (type==="text" && ["hola","menu","inicio","start","volver"].includes(lower)) {
      sessions.delete(from);
      getS(from); // reset
      await showWelcomeOnce();
      return res.sendStatus(200);
    }
    if (!s.welcomed) {
      await showWelcomeOnce();
      return res.sendStatus(200);
    }

    /* ===== BOTONES ===== */
    if (type==="interactive") {

      // ===== Menú principal
      if (btnId==="action_cotizar"){ s.flow=null; s.step="choose_modo"; await sendModos(from); return res.sendStatus(200); }
      if (btnId==="action_calcular"){ s.flow="calc"; s.step="calc_prod_m"; await askProdMetodo(from); return res.sendStatus(200); }

      // ===== Cotizador clásico (sin cambios de negocio)
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
      if (btnId==="mar_LCL" || btnId==="mar_FCL"){
        s.maritimo_tipo = (btnId==="mar_LCL") ? "LCL" : "FCL";
        if (s.maritimo_tipo==="FCL"){ s.step="mar_equipo"; await sendContenedores(from); }
        else { s.step="mar_origen"; await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen)."); }
        return res.sendStatus(200);
      }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        s.contenedor = btnId.replace("mar_FCL","");
        if (s.flow === "calc") {
          s.calc_contenedor = s.contenedor;
          s.step="c_confirm"; await confirmCalc(from,s); return res.sendStatus(200);
        } else {
          s.step="mar_origen";
          await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
          return res.sendStatus(200);
        }
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
      if (btnId==="exw_no"){ await sendText(from,"¡Gracias por tu consulta! 🙌\n📧 comercial@conektarsa.com"); await endMenu(from); sessions.delete(from); return res.sendStatus(200); }

      // ===== Calculadora (botón flow calc)
      if (btnId==="calc_desc"){ s.step="calc_desc_wait"; await sendText(from,"Escribí una *breve descripción* (p.ej., “cables USB-C”, “químicos”)."); return res.sendStatus(200); }
      if (btnId==="calc_cat"){
        const M = await getMatrix();
        const cats = [...new Set(M.list.map(x=>x.cat))].slice(0,10);
        if (!cats.length){ await sendText(from,"⚠️ No hay categorías en la matriz. Revisá la pestaña."); return res.sendStatus(200); }
        await sendList(from, "Elegí la *categoría* que más se acerque:", listFromArray(cats,"cat"), "Categorías", "Seleccionar");
        s.step="calc_cat_pick"; return res.sendStatus(200); 
      }
      if (btnId==="calc_hier"){
        const M = await getMatrix();
        const niv1 = Object.keys(M.tree);
        if (!niv1.length){ await sendText(from,"⚠️ No hay niveles en la matriz."); return res.sendStatus(200); }
        await sendList(from, "Elegí el NIVEL 1:", listFromArray(niv1,"niv1"), "Niveles 1", "Seleccionar");
        s.step="calc_hier_niv1"; return res.sendStatus(200);
      }
      if (btnId==="calc_pop"){
        await sendList(from, "⭐ Productos más consultados:", listFromArray(populares,"pop"), "Populares", "Ver");
        s.step="calc_pop_pick"; return res.sendStatus(200);
      }
      if (btnId.startsWith("cat_") && s.step==="calc_cat_pick"){
        const label = (msg.interactive?.list_reply?.title) || "Categoría";
        s.categoria = label;
        const M = await getMatrix();
        s.matriz = M.list.find(x => norm(x.cat)===norm(label)) || M.list[0];
        await showRowInfo(from, s.matriz);
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
        return res.sendStatus(200);
      }
      if (btnId.startsWith("pop_") && s.step==="calc_pop_pick"){
        const label = (msg.interactive?.list_reply?.title) || "Producto";
        s.producto_desc = label;
        const M = await getMatrix();
        const match = pickMatches(M.list, label)[0] || M.list[0];
        s.matriz = match;
        await showRowInfo(from, s.matriz);
        s.step="calc_fob_unit";
        await sendText(from,`⭐ Seleccionado: ${label}\n\n💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).`);
        return res.sendStatus(200);
      }

      // Nuevo: Jerarquía
      if (btnId.startsWith("niv1_") && s.step==="calc_hier_niv1"){
        const idx = Number(btnId.split("_")[1]);
        const M = await getMatrix();
        const niv1List = Object.keys(M.tree);
        s.nivel1 = niv1List[idx] || niv1List[0];
        const niv2 = Object.keys(M.tree[s.nivel1] || {});
        if (!niv2.length){ await sendText(from,"No hay NIVEL 2."); s.step="calc_fob_unit"; return res.sendStatus(200); }
        await sendList(from, `NIVEL 1: ${s.nivel1}\nElegí NIVEL 2:`, listFromArray(niv2,"niv2"), "Niveles 2", "Seleccionar");
        s.step="calc_hier_niv2"; return res.sendStatus(200);
      }
      if (btnId.startsWith("niv2_") && s.step==="calc_hier_niv2"){
        const idx = Number(btnId.split("_")[1]);
        const M = await getMatrix();
        const niv2List = Object.keys(M.tree[s.nivel1] || {});
        s.nivel2 = niv2List[idx] || niv2List[0];
        const niv3 = Object.keys(M.tree[s.nivel1][s.nivel2] || {});
        if (!niv3.length){ await sendText(from,"No hay NIVEL 3."); s.step="calc_fob_unit"; return res.sendStatus(200); }
        await sendList(from, `NIVEL 2: ${s.nivel2}\nElegí NIVEL 3:`, listFromArray(niv3,"niv3"), "Niveles 3", "Seleccionar");
        s.step="calc_hier_niv3"; return res.sendStatus(200);
      }
      if (btnId.startsWith("niv3_") && s.step==="calc_hier_niv3"){
        const idx = Number(btnId.split("_")[1]);
        const M = await getMatrix();
        const niv3List = Object.keys(M.tree[s.nivel1][s.nivel2] || {});
        s.nivel3 = niv3List[idx] || niv3List[0];
        const subs = Object.keys(M.tree[s.nivel1][s.nivel2][s.nivel3] || {});
        if (!subs.length){ await sendText(from,"No hay subcategorías."); s.step="calc_fob_unit"; return res.sendStatus(200); }
        await sendList(from, `NIVEL 3: ${s.nivel3}\nElegí subcategoría:`, listFromArray(subs,"sub"), "Subcategorías", "Seleccionar");
        s.step="calc_hier_sub"; return res.sendStatus(200);
      }
      if (btnId.startsWith("sub_") && s.step==="calc_hier_sub"){
        const idx = Number(btnId.split("_")[1]);
        const M = await getMatrix();
        const subList = Object.keys(M.tree[s.nivel1][s.nivel2][s.nivel3] || {});
        const sub = subList[idx] || subList[0];
        s.subcat = sub;
        s.matriz = M.tree[s.nivel1][s.nivel2][s.nivel3][sub];
        s.categoria = `${s.nivel1} > ${s.nivel2} > ${s.nivel3} > ${sub}`;
        await showRowInfo(from, s.matriz);
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
        return res.sendStatus(200);
      }

      // modo de transporte para calculadora
      if (btnId==="c_maritimo"){ s.calc_modo="maritimo"; s.step="c_mar_tipo"; await askMarTipo(from); return res.sendStatus(200); }
      if (btnId==="c_aereo"){ s.calc_modo="aereo"; s.step="c_confirm"; await confirmCalc(from, s); return res.sendStatus(200); }
      if (btnId==="c_lcl"){ s.calc_maritimo_tipo="LCL"; s.step="c_confirm"; await confirmCalc(from,s); return res.sendStatus(200); }
      if (btnId==="c_fcl"){ s.calc_maritimo_tipo="FCL"; s.step="c_cont"; await askCont(from); return res.sendStatus(200); }

      if (btnId==="calc_edit"){ s.step="c_modo"; await askCalcModos(from); return res.sendStatus(200); }
      if (btnId==="calc_go"){
        // calcular
        const M = s.matriz || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, nota:"", tasa_est: TASA_ESTATISTICA };
        // flete estimado usando tarifas (si no se encuentra, sigue)
        let fleteUSD = 0, fleteDetalle = "";
        try{
          if (s.calc_modo==="aereo"){
            const r = await cotizarAereo({ origen: s.origen_aeropuerto || "Shanghai", kg: s.peso_kg||0, vol: (s.vol_cbm||0)*167 });
            if (r){ fleteUSD = r.totalUSD; fleteDetalle = `Flete (AÉREO): USD ${fmt(fleteUSD)}`; }
          } else if (s.calc_modo==="maritimo"){
            const modalidad = s.calc_maritimo_tipo==="FCL" ? (s.calc_contenedor?`FCL ${s.calc_contenedor}`:"FCL") : "LCL";
            const r = await cotizarMaritimo({ origen: s.origen_puerto || "Shanghai", modalidad });
            if (r){ fleteUSD = r.totalUSD; fleteDetalle = `Flete (MARÍTIMO ${modalidad}): USD ${fmt(fleteUSD)}`; }
          }
        }catch{ /* sigue sin flete */ }

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

        const header = "📦 *Resultado estimado (FOB)*";
        const fleteLinea = fleteDetalle || "Flete: *sin tarifa* (seguimos el cálculo y te contactamos)";
        const body = [
          header,
          "",
          `FOB total: USD ${fmt(s.fob_total)}`,
          `${fleteLinea}`,
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
          M.nota ? `\nNota: ${M.nota}` : ""
        ].join("\n");

        await sendText(from, body);

        // registrar
        await logCalculo([
          new Date().toISOString(), from, s.empresa, (s.producto_desc||s.categoria||""), (s.matriz?.cat||""),
          s.fob_unit, s.cantidad, s.fob_total, s.peso_kg, s.vol_cbm,
          s.calc_modo, s.calc_maritimo_tipo||"", s.calc_contenedor||"",
          insurance, fleteUSD, cif, di, tasa, iva, ivaAd, iibb, iigg, internos, impTotal, costoAdu
        ]);

        await sendText(from, "¡Gracias por tu consulta! 🙌\n📧 comercial@conektarsa.com");
        await endMenu(from);
        sessions.delete(from);
        return res.sendStatus(200);
      }

      // Calificación (list)
      if (/^rate_\d+$/.test(btnId)){ await sendText(from, "¡Gracias por tu calificación! ⭐"); return res.sendStatus(200); }

      return res.sendStatus(200);
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
      if (s.step==="exw_dir"){ s.exw_dir = text; await sendText(from,"🧑‍💼 El equipo comercial está trabajando en la solicitud y te contactaremos en breve."); await sendText(from,"¿Querés cotizar *despacho aduanero*? Escribí *inicio* para comenzar de nuevo."); sessions.delete(from); return res.sendStatus(200); }

      // Calculadora
      if (s.flow==="calc"){
        if (s.step==="calc_desc_wait"){
          s.producto_desc = text;
          const M = await getMatrix();
          const matches = pickMatches(M.list, text);
          if (!matches.length){
            s.matriz = M.list[0] || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0 };
            await showRowInfo(from, s.matriz);
            s.step="calc_fob_unit";
            await sendText(from,"No encontré coincidencias claras. Usaré una categoría genérica.\n\n💵 Ingresá *FOB unitario (USD)*.");
          } else if (matches.length === 1){
            s.matriz = matches[0];
            await showRowInfo(from, s.matriz);
            s.step="calc_fob_unit";
            await sendText(from,"💵 Ingresá *FOB unitario (USD)*.");
          } else {
            const rows = matches.map((m,i)=>({ id:`m_${i}`, title: m.cat.slice(0,24), description: m.cat.length>24?m.cat:undefined }));
            await sendList(from, "Varios coincidencias. Elegí la que mejor encaje:", rows, "Coincidencias", "Elegir");
            s._matches = matches;
            s.step="calc_match_pick";
          }
          return res.sendStatus(200);
        }
        if (s.step==="calc_match_pick" && msg.interactive?.list_reply){
          const idx = Number((msg.interactive.list_reply.id||"").split("_")[1]||0);
          s.matriz = s._matches?.[idx]; s._matches = null;
          s.categoria = s.matriz?.cat || s.producto_desc;
          await showRowInfo(from, s.matriz);
          s.step="calc_fob_unit";
          await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
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
          s.step="c_modo"; await askCalcModos(from); return res.sendStatus(200);
        }
      }
    }

    /* ===== COTIZAR (ejecución) ===== */
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
          const modalidad = s.maritimo_tipo==="FCL" ? (s.contenedor?`FCL ${s.contenedor}`:"FCL") : "LCL";
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

        // Si es FTL no preguntamos EXW
        if (!(s.modo==="terrestre" && s.terrestre_tipo==="FTL")){
          await sendButtons(from, "¿Tu carga es EXW?", [
            { id:"exw_si", title:"Sí" },
            { id:"exw_no", title:"No" }
          ]);
          s.step="exw_q";
        } else {
          await endMenu(from);
          sessions.delete(from);
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
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo Impo ✅ v3.0"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

/* ========= Start ========= */
app.listen(PORT, ()=> console.log(`🚀 Bot v3.0 en http://localhost:${PORT}`));

/* ========= Helpers de resumen (cotizador clásico) ========= */
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
