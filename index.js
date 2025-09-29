// index.js — Conektar S.A. • Bot de Cotizaciones + Costeo Impo (ESM) • v3.1 (hotfix)
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

/* Tarifas (cotizador clásico) */
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

/* Matriz (costeo de importación) */
const MATRIX_SHEET_ID = (process.env.PRODUCT_MATRIX_SHEET_ID || TAR_SHEET_ID || "").trim();
const PRODUCT_MATRIX_TAB = (process.env.PRODUCT_MATRIX_TAB || "Clasificación").trim();

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

/* Reseña 1–5 */
const askRating = (to) =>
  sendButtons(to, "¿Cómo calificarías al bot del *1 al 5*? ⭐️", [
    { id:"rate_1", title:"⭐️ 1" },
    { id:"rate_2", title:"⭐️⭐️ 2" },
    { id:"rate_3", title:"⭐️⭐️⭐️ 3" },
    { id:"rate_4", title:"⭐️⭐️⭐️⭐️ 4" },
    { id:"rate_5", title:"⭐️⭐️⭐️⭐️⭐️ 5" },
  ]);
const endMenu = async (to) => {
  await sendMainActions(to);
  await askRating(to);
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
  // ampliamos a Z por si hay más columnas
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
  // ampliamos a Z para tomar columnas más allá de H (precio, etc.)
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
  empresa:null, welcomed:false, step:"start",
  // cotizador
  modo:null, maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null, terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  // LCL específico
  lcl_ton:null, lcl_cbm:null, lcl_stack:true,
  // calculadora
  flow:null,
  niv1:null, niv2:null, niv3:null, subcat:null,
  matriz:null,
  producto_desc:null,
  fob_unit:null, cantidad:null, fob_total:null,
  vol_total:null, kg_total:null,
  calc_modo:null, calc_maritimo_tipo:null, calc_contenedor:null
});
function getS(id){ if(!sessions.has(id)) sessions.set(id, { data: emptyState() }); return sessions.get(id); }

/* ========= Matriz (lectura y navegación) ========= */
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
    SUB:  find("SUBCATEGORIA","SUBCATEGORÍA","UBCATEGORI","SUB CATEG"),
    TASA: find("Tasa Estad","Tasa estad"),
    IVA:  find("% IVA","IVA","IVA %"),
    IVA_A:find("IVA ADIC","% IVA ADICIONAL","IVA ADICIONAL"),
    DI:   find("DERECHOS IM","% DERECHOS","DERECHOS"),
    IIBB: find("% IIBB","IIBB"),
    IIGG: find("% IIGG","IIGG"),
    INT:  find("IMPUESTOS INT","INTERNOS"),
    NOTA: find("NOTAS","OBS"),
  };

  const data = rows.slice(1).map(r => ({
    n1: (r[idx.NIV1]||"").toString().trim(),
    n2: (r[idx.NIV2]||"").toString().trim(),
    n3: (r[idx.NIV3]||"").toString().trim(),
    sub:(r[idx.SUB] ||"").toString().trim(),
    tasa: toNum(r[idx.TASA]??3)/100,
    iva: toNum(r[idx.IVA]??21)/100,
    iva_ad: toNum(r[idx.IVA_A]??0)/100,
    di: toNum(r[idx.DI]??0)/100,
    iibb: toNum(r[idx.IIBB]??3.5)/100,
    iigg: isNaN(toNum(r[idx.IIGG])) ? RATE_IIGG : (toNum(r[idx.IIGG])/100),
    internos: toNum(r[idx.INT]??0)/100,
    nota: (r[idx.NOTA]||"").toString()
  })).filter(x => x.n1 || x.sub);

  return data;
}
let MATRIX_CACHE=null;
async function getMatrix(){ if (MATRIX_CACHE) return MATRIX_CACHE; MATRIX_CACHE = await readMatrix(); return MATRIX_CACHE||[]; }

const uniques = (arr)=> [...new Set(arr.filter(Boolean))];
// ⬆️ aumentamos a 20 opciones para que veas las 9 categorías completas
const toRows = (arr, prefix) => arr.slice(0,20).map((t,i)=>({ id:`${prefix}_${i}`, title:String(t).slice(0,24), description: String(t).length>24?String(t):undefined }));

/* ========= Helpers de UI ========= */
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
    if (d.maritimo_tipo==="LCL"){
      if (d.lcl_ton!=null) lines.push(`• Ton: *${fmt(d.lcl_ton)}* • m³: *${fmt(d.lcl_cbm)}* • Apilable: *${d.lcl_stack?"Sí":"No"}*`);
    }
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

/* ========= VERIFY ========= */
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ===== helper: ejecutar cotización inmediatamente al confirmar ===== */
async function ejecutarCotizacion(from, s){
  try{
    if (s.modo==="aereo" && s.aereo_tipo==="carga_general"){
      const r = await cotizarAereo({ origen: s.origen_aeropuerto, kg: s.peso_kg||0, vol: s.vol_cbm||0 });
      if (!r){ await sendText(from,"❌ No encontré esa ruta en *Aéreos*. Probá con ciudad o IATA (PVG, PEK, NRT)."); return; }
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
      if (!r){ await sendText(from,"❌ No pude calcular *Courier*. Revisá la pestaña."); return; }
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
      let r;
      if (s.maritimo_tipo==="LCL"){
        const wm = Math.max(Number(s.lcl_ton||0), Number(s.lcl_cbm||0));
        const factor = s.lcl_stack ? 1 : 1.1; // +10% si no apilable
        r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad: "LCL", wm: wm*factor });
      } else {
        const modalidad = s.contenedor?`FCL ${s.contenedor}`:"FCL";
        r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
      }
      if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*. Usá el nombre tal cual figura."); return; }
      const extra = s.maritimo_tipo==="LCL" ? ` (W/M aplicado)` : "";
      const resp =
`✅ *Tarifa estimada (Marítimo ${r.modalidad})*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.${extra}
*Origen:* ${s.origen_puerto}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
      await sendText(from, resp);
      await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, s.lcl_ton||"", s.lcl_cbm||"", r.modalidad, r.totalUSD, `Marítimo ${r.modalidad} ${s.origen_puerto}→${r.destino}`]);
    } else if (s.modo==="terrestre"){
      const r = await cotizarTerrestre({ origen: s.origen_direccion || "" });
      if (!r){ await sendText(from,"❌ No encontré esa ruta en *Terrestres*."); return; }
      const resp =
`✅ *Tarifa estimada (TERRESTRE FTL)*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
      await sendText(from, resp);
      await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","terrestre", s.origen_direccion||"", r.destino, "", "", "FTL", r.totalUSD, `Terrestre ${s.origen_direccion}→${r.destino}`]);
    }

    await sendText(from, "✅ *Tu consulta ha sido registrada.* Nuestro equipo te contactará con una respuesta personalizada.\n📧 comercial@conektarsa.com");

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

    // Bienvenida una sola vez (no repetir banner si ya saludó)
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
      await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
      s.step = "ask_empresa";
    };

    // Comandos globales (sin resetear si ya saludó)
    if (type==="text" && ["hola","buenas","menu","inicio","start","volver"].includes(lower)) {
      if (!s.welcomed) { await showWelcomeOnce(); }
      else { await sendMainActions(from); s.step="main"; }
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
      if (btnId==="action_calcular"){ s.flow="calc"; s.step="c_n1"; 
        const M = await getMatrix();
        const n1 = uniques(M.map(x=>x.n1)).filter(Boolean);
        await sendList(from, "Elegí el *NIVEL 1*:", toRows(n1,"n1"), "NIVEL 1", "Elegir");
        return res.sendStatus(200);
      }

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

      if (btnId==="mar_LCL"){
        s.maritimo_tipo = "LCL"; 
        s.step="lcl_origen"; 
        await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
        return res.sendStatus(200);
      }
      if (btnId==="mar_FCL"){
        s.maritimo_tipo = "FCL";
        s.step="mar_equipo"; await sendContenedores(from);
        return res.sendStatus(200);
      }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        s.contenedor = btnId.replace("mar_FCL","").replace("40HC","40HC");
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

      // ⚠️ AQUÍ: ejecutar cotización en el click de "Confirmar"
      if (btnId==="confirmar"){ await ejecutarCotizacion(from, s); return res.sendStatus(200); }
      if (btnId==="editar"){ await sendMainActions(from); s.step="main"; return res.sendStatus(200); }
      if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); return res.sendStatus(200); }

      if (btnId==="exw_si"){ s.step="exw_dir"; await sendText(from,"📍 *Dirección EXW* (calle, ciudad, CP, país)."); return res.sendStatus(200); }
      if (btnId==="exw_no"){ await sendText(from,"¡Gracias por tu consulta! 🙌\n📧 comercial@conektarsa.com"); await endMenu(from); sessions.delete(from); return res.sendStatus(200); }

      // LCL: apilable
      if (btnId==="lcl_stack_yes" || btnId==="lcl_stack_no"){
        s.lcl_stack = btnId==="lcl_stack_yes";
        await askResumen(from, s);
        return res.sendStatus(200);
      }

      // ===== Calculadora (navegación por niveles) =====
      if (s.flow==="calc") {
        const M = await getMatrix();

        if (btnId.startsWith("n1_") && s.step==="c_n1"){
          const label = msg.interactive?.list_reply?.title || "";
          s.niv1 = label;
          const n2 = uniques(M.filter(x=>norm(x.n1)===norm(label)).map(x=>x.n2));
          s.step="c_n2";
          await sendList(from, "Elegí el *NIVEL 2*:", toRows(n2,"n2"), "NIVEL 2", "Elegir");
          return res.sendStatus(200);
        }
        if (btnId.startsWith("n2_") && s.step==="c_n2"){
          const label = msg.interactive?.list_reply?.title || "";
          s.niv2 = label;
          const n3 = uniques(M.filter(x=>norm(x.n1)===norm(s.niv1) && norm(x.n2)===norm(label)).map(x=>x.n3));
          s.step="c_n3";
          await sendList(from, "Elegí el *NIVEL 3*:", toRows(n3,"n3"), "NIVEL 3", "Elegir");
          return res.sendStatus(200);
        }
        if (btnId.startsWith("n3_") && s.step==="c_n3"){
          const label = msg.interactive?.list_reply?.title || "";
          s.niv3 = label;
          const subs = uniques(M.filter(x=>
            norm(x.n1)===norm(s.niv1) && norm(x.n2)===norm(s.niv2) && norm(x.n3)===norm(label)
          ).map(x=>x.sub)).filter(Boolean);
          s.step="c_sub";
          await sendList(from, "Elegí la *Subcategoría*:", toRows(subs,"sub"), "SUBCATEGORÍAS", "Elegir");
          return res.sendStatus(200);
        }
        if (btnId.startsWith("sub_") && s.step==="c_sub"){
          const label = msg.interactive?.list_reply?.title || "";
          s.subcat = label;
          s.matriz = M.find(x=> norm(x.n1)===norm(s.niv1) && norm(x.n2)===norm(s.niv2) && norm(x.n3)===norm(s.niv3) && norm(x.sub)===norm(label)) || null;
          s.step="calc_fob_unit";
          await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125.50).");
          return res.sendStatus(200);
        }

        if (btnId==="calc_modo_aer"){ s.calc_modo="aereo"; s.step="calc_confirm"; await sendText(from, sugerenciaTexto(s)); await sendButtons(from,"¿Cómo querés simular el flete?",[
          {id:"calc_go", title:"✅ Calcular"}
        ]); return res.sendStatus(200); }
        if (btnId==="calc_modo_mar"){ s.calc_modo="maritimo"; s.step="calc_mar_tipo"; await sendButtons(from,"Marítimo: ¿LCL o FCL?",[
          {id:"calc_lcl", title:"LCL"},
          {id:"calc_fcl", title:"FCL"}
        ]); return res.sendStatus(200); }
        if (btnId==="calc_lcl"){ s.calc_maritimo_tipo="LCL"; s.step="calc_confirm"; await sendText(from, sugerenciaTexto(s)); await sendButtons(from,"¿Confirmás para calcular?",[
          {id:"calc_go", title:"✅ Calcular"}
        ]); return res.sendStatus(200); }
        if (btnId==="calc_fcl"){ s.calc_maritimo_tipo="FCL"; s.step="calc_fcl_eq"; await sendContenedores(from); return res.sendStatus(200); }
        if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId) && s.step==="calc_fcl_eq"){
          s.calc_contenedor = btnId==="mar_FCL20"?"20' ST":btnId==="mar_FCL40"?"40' ST":"40' HC";
          s.step="calc_confirm"; await sendText(from, sugerenciaTexto(s)); await sendButtons(from,"¿Confirmás para calcular?",[{id:"calc_go",title:"✅ Calcular"}]); return res.sendStatus(200);
        }

        if (btnId==="calc_go"){
          await ejecutarCosteo(from, s);
          return res.sendStatus(200);
        }
      }

      // Calificación
      if (/^rate_[1-5]$/.test(btnId)){ await sendText(from, "¡Gracias por tu calificación! ⭐"); return res.sendStatus(200); }

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

      // Cotizador clásico — rutas
      if (s.step==="mar_origen"){ s.origen_puerto = text; await askResumen(from, s); return res.sendStatus(200); }
      if (s.step==="lcl_origen"){ s.origen_puerto = text; s.step="lcl_ton"; await sendText(from,"⚖️ Ingresá *TONELADAS* totales (ej.: 2.5)."); return res.sendStatus(200); }
      if (s.step==="lcl_ton"){ s.lcl_ton = Math.max(0, toNum(text)||0); s.step="lcl_cbm"; await sendText(from,"📦 Ingresá el *VOLUMEN* en m³ (ej.: 8.5)."); return res.sendStatus(200); }
      if (s.step==="lcl_cbm"){ s.lcl_cbm = Math.max(0, toNum(text)||0); s.step="lcl_stack"; await sendButtons(from,"¿La mercadería es *apilable*?",[
        {id:"lcl_stack_yes", title:"Sí"},{id:"lcl_stack_no", title:"No"}
      ]); return res.sendStatus(200); }

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
      if (s.step==="exw_dir"){ s.exw_dir = text; await sendText(from,"🧑‍💼 El equipo comercial está trabajando en la solicitud y te contactaremos en breve."); await sendButtons(from,"¿Querés que te cotizemos el *despacho de aduana*?",[
        {id:"desp_yes",title:"Sí"},{id:"desp_no",title:"No"}
      ]); s.step="desp"; return res.sendStatus(200); }
      if (s.step==="desp"){ await endMenu(from); sessions.delete(from); return res.sendStatus(200); }
    }

    return res.sendStatus(200);
  }catch(e){
    console.error("webhook error", e);
    return res.sendStatus(200);
  }
});

/* ========= HEALTH ========= */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo Impo ✅ v3.1 (hotfix)"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

app.listen(PORT, ()=> console.log(`🚀 Bot v3.1 (hotfix) en http://localhost:${PORT}`));

/* ========= Costeo: reglas, cálculo y salida ========= */
function sugerenciaTexto(s){
  const kg = Number(s.kg_total||0);
  const m3 = Number(s.vol_total||0);
  let sug = "Sugerencia: ";
  if (kg<1000 && m3<3){ sug += "✈️ *AÉREO* (carga liviana/compacta)."; }
  else if ((kg>=1000 && kg<=10000) || (m3>=3 && m3<=13)){ sug += "🚢 *MARÍTIMO LCL* (medianas sin llenar contenedor)."; }
  else if (kg>10000 || m3>13){ sug += "🚢 *MARÍTIMO FCL* (conviene contenedor)."; }
  else { sug += "Depende del valor/urgencia; podemos evaluar." }
  // Tip costo relativo
  sug += "\n• Nota: si el *flete aéreo* supera ~15–20% del *FOB*, conviene revisar marítimo.";
  return sug;
}

function calcDespacho(cif){
  const base = cif * 0.003; // 0.30%
  const honor = Math.min(Math.max(base, 150), 5000);
  const total = honor + 20 + 100;
  return { honor, admin:20, oper:100, total };
}

async function ejecutarCosteo(to, s){
  const M = s.matriz || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa:TASA_ESTATISTICA, nota:"" };

  // flete estimado (opcional, solo si hay tarifa)
  let fleteUSD = 0, fDetalle = "Flete: sin tarifa (seguimos cálculo)";
  try{
    if (s.calc_modo==="aereo"){
      const r = await cotizarAereo({ origen: s.origen_aeropuerto || "Shanghai", kg: s.kg_total||0, vol: (s.vol_total||0)*167 });
      if (r){ fleteUSD = r.totalUSD; fDetalle = `Flete (AÉREO): USD ${fmt(fleteUSD)}`; }
    } else if (s.calc_modo==="maritimo"){
      if (s.calc_maritimo_tipo==="LCL"){
        const wm = Math.max((s.kg_total||0)/1000, s.vol_total||0);
        const r = await cotizarMaritimo({ origen: s.origen_puerto || "Shanghai", modalidad:"LCL", wm });
        if (r){ fleteUSD = r.totalUSD; fDetalle = `Flete (MARÍTIMO LCL): USD ${fmt(fleteUSD)}`; }
      } else {
        const modalidad = s.calc_contenedor?`FCL ${s.calc_contenedor}`:"FCL";
        const r = await cotizarMaritimo({ origen: s.origen_puerto || "Shanghai", modalidad });
        if (r){ fleteUSD = r.totalUSD; fDetalle = `Flete (MARÍTIMO ${modalidad}): USD ${fmt(fleteUSD)}`; }
      }
    }
  }catch{}

  const insurance = INSURANCE_RATE * (s.fob_total||0);
  const cif = (s.fob_total||0) + fleteUSD + insurance;

  const di     = cif * (M.di ?? 0);
  const tasa   = cif * (M.tasa ?? TASA_ESTATISTICA);
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

  const body =
`📦 *Resultado estimado (FOB)*

FOB total: USD ${fmt(s.fob_total)}
${fDetalle}
Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmt(insurance)}
CIF: *USD ${fmt(cif)}*

🏛️ *Impuestos*
DI (${((M.di||0)*100).toFixed(1)}%): USD ${fmt(di)}
Tasa Estadística (${(((M.tasa??TASA_ESTATISTICA))*100).toFixed(1)}% CIF): USD ${fmt(tasa)}
IVA (${((M.iva||0)*100).toFixed(1)}%): USD ${fmt(iva)}
IVA Adic (${((M.iva_ad||0)*100).toFixed(1)}%): USD ${fmt(ivaAd)}
IIBB (${((M.iibb||0)*100).toFixed(1)}%): USD ${fmt(iibb)}
IIGG (${((M.iigg??RATE_IIGG)*100).toFixed(1)}%): USD ${fmt(iigg)}${(M.internos||0)>0?`\nInternos (${(M.internos*100).toFixed(1)}%): USD ${fmt(internos)}`:""}

*Impuestos totales:* USD ${fmt(impTotal)}
*Costo aduanero (CIF + imp.):* *USD ${fmt(costoAdu)}*

👨‍💼 *Despacho aduanero*
Honorarios (0.30% min USD 150 tope USD 5000): USD ${fmt(desp.honor)}
Gastos admin: USD ${fmt(desp.admin)}  •  Operativos: USD ${fmt(desp.oper)}
Total Despacho: *USD ${fmt(desp.total)}*

🎯 *Costo final estimado: USD ${fmt(costoFinal)}*${M.nota?`\n\nNota: ${M.nota}`:""}`;

  await sendText(to, body);

  await logCalculo([
    new Date().toISOString(), to, s.empresa, (s.producto_desc||s.subcat||""), (s.niv1||"")+"/"+(s.niv2||"")+"/"+(s.niv3||""),
    s.fob_unit, s.cantidad, s.fob_total, s.kg_total, s.vol_total,
    s.calc_modo||"", s.calc_maritimo_tipo||"", s.calc_contenedor||"",
    insurance, fleteUSD, cif, di, tasa, iva, ivaAd, iibb, iigg, internos, impTotal, costoAdu
  ]);

  await sendText(to, "¿Querés volver al menú principal?");
  await endMenu(to);
  sessions.delete(to);
}
