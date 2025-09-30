// index.js — Conektar S.A. • Bot Cotizaciones + Costeo Importe + Flete Local
// v4.0 — Flete Local ($ ARS), rating+EXW+Despachante+Email log, courier PF/Empresa, títulos árbol, formato CIF

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

/* Tarifa Sheets (cotizador + matriz) */
const TAR_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AER_HINT = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MAR_HINT = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TER_HINT = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COU_HINT = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();
const TAB_CLASIF   = (process.env.GOOGLE_TARIFFS_TAB_CLASIFICACION || "Clasificación").trim();
const TAB_LOCAL    = (process.env.GOOGLE_TARIFFS_TAB_FLETE_LOCAL || "Flete Local").trim();

const LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB      = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();
const TAB_CALCULOS = (process.env.GOOGLE_CALC_TAB || "calculos").trim();

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);

const LOGO_URL = (process.env.LOGO_URL ||
  "https://conektarsa.com/wp-content/uploads/2025/09/Conektarsa_logo_Whapp.jpg").trim();

/* Parámetros cálculo */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01);
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03);
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06);

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
  str = str.replace(/[^\d.,-]/g, ""); // quita $ y letras

  const hasDot = str.includes(".");
  const hasComma = str.includes(",");

  if (hasDot && hasComma) {
    // "1.234,56" -> 1234.56
    str = str.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    // "123,45" -> 123.45
    str = str.replace(",", ".");
  } else if (hasDot && !hasComma) {
    // "1.234" (miles) o "1234.5" (decimal). Tomo el último punto como decimal
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

/* ---- Menús / rating / upsell ---- */
const sendMainActions = (to) =>
  sendButtons(to, "¿Qué te gustaría hacer hoy?", [
    { id:"action_cotizar",  title:"🌍 Cotiz. Flete Intl" },
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
  const row = data.find(r => norm(r[iDest]).includes("buenos aires") && (norm(r[iOrigen]||"")===want || norm(r[iOrigen]||"").includes(want)));
  if (!row) return null;

  return { totalUSD: toNum(row[iPrecio]), destino: "Buenos Aires" };
}

/* ========= Flete Local ========= */
async function cotizarFleteLocal({ capacidad, tipo, distancia }) {
  const rows = await readTabRange(TAR_SHEET_ID, TAB_LOCAL, "A1:Z10000", ["flete local","local"]);
  if (!rows.length) throw new Error("Flete Local vacío");

  const header = rows[0], data = rows.slice(1);
  const iCap = headerIndex(header, "capacidad");
  const iTipo = headerIndex(header, "tipo");
  const iDist = headerIndex(header, "distancia");
  const iPrecio = headerIndex(header, "precio", "tarifa");

  const row = data.find(r => {
    const cap = norm(r[iCap]||"");
    const tip = norm(r[iTipo]||"");
    const dis = norm(r[iDist]||"");
    return cap.includes(norm(capacidad)) && tip.includes(norm(tipo)) && dis.includes(norm(distancia));
  });

  if (!row) return null;
  return { totalARS: toNum(row[iPrecio]) };
}

/* ========= Matriz clasificación ========= */
let matrizCache = null;
async function getMatrix() {
  if (matrizCache) return matrizCache;
  const rows = await readTabRange(TAR_SHEET_ID, TAB_CLASIF, "A1:Z10000", ["clasificacion","clasificación"]);
  if (!rows.length) throw new Error("Clasificación vacía");

  const header = rows[0], data = rows.slice(1);
  const iNiv1 = headerIndex(header, "nivel 1", "niv1", "industria");
  const iNiv2 = headerIndex(header, "nivel 2", "niv2", "sector");
  const iNiv3 = headerIndex(header, "nivel 3", "niv3", "categoria", "categoría");
  const iSub = headerIndex(header, "sub", "subcategoria", "subcategoría", "producto");
  const iDI = headerIndex(header, "di", "derecho importacion", "derecho de importación");
  const iIVA = headerIndex(header, "iva");
  const iIVAAd = headerIndex(header, "iva adicional", "iva ad");
  const iIIBB = headerIndex(header, "iibb", "ingresos brutos");
  const iIIGG = headerIndex(header, "iigg", "ganancias");
  const iInternos = headerIndex(header, "internos", "impuestos internos");
  const iTasa = headerIndex(header, "tasa", "tasa estadistica", "tasa estadística");
  const iNota = headerIndex(header, "nota", "notas", "observaciones");

  matrizCache = data.map(r => ({
    NIV1: r[iNiv1]||"",
    NIV2: r[iNiv2]||"",
    NIV3: r[iNiv3]||"",
    SUB: r[iSub]||"",
    di: toNum(r[iDI]) || 0,
    iva: toNum(r[iIVA]) || 0.21,
    iva_ad: toNum(r[iIVAAd]) || 0,
    iibb: toNum(r[iIIBB]) || 0.035,
    iigg: toNum(r[iIIGG]) || RATE_IIGG,
    internos: toNum(r[iInternos]) || 0,
    tasa_est: toNum(r[iTasa]) || TASA_ESTATISTICA,
    nota: r[iNota]||""
  }));
  return matrizCache;
}

function indexMatrix(M) {
  return M.map(x => ({ niv1: x.NIV1, niv2: x.NIV2, niv3: x.NIV3, sub: x.SUB }));
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
const listFrom = (arr, pref) => arr.slice(0,10).map((t,i)=>({ id:`${pref}_${i}`, title: clip24(t), description: t.length>24?t:undefined }));

/* ========= Sessions ========= */
const sessions = new Map();
const getS = (waId) => {
  if (!sessions.has(waId)) {
    sessions.set(waId, { data: { step: "main" } });
  }
  return sessions.get(waId);
};

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
        "Acá vas a poder *cotizar fletes internacionales*, *estimaciones CIF* y *flete local*."
      );
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
    if (type==="text" && ["menu","inicio","start","volver"].includes(lower)) {
      if (lower==="inicio") { sessions.delete(from); getS(from); }
      await sendMainActions(from);
      return res.sendStatus(200);
    }

    /* ===== TEXT ===== */
    if (type==="text") {
      // Empresa
      if (s.step==="ask_empresa") {
        s.empresa = text;
        await sendText(from, `¡Perfecto, *${text}*! 👍`);
        await sleep(300);
        await sendMainActions(from);
        s.step = "main";
        return res.sendStatus(200);
      }

      // Cotizador clásico
      if (s.step==="mar_origen") {
        s.origen_puerto = text;
        s.destino_puerto = "Puerto de Buenos Aires";
        if (s.maritimo_tipo==="LCL") {
          s.step="mar_lcl_tn";
          await sendText(from,"⚖️ *Peso en TONELADAS* (ej.: 1.5).");
        } else {
          s.step="resumen";
          await askResumen(from, s);
        }
        return res.sendStatus(200);
      }
      if (s.step==="mar_lcl_tn") {
        s.lcl_tn = toNum(text);
        s.step="mar_lcl_m3";
        await sendText(from,"📦 *Volumen en M³* (ej.: 2.3).");
        return res.sendStatus(200);
      }
      if (s.step==="mar_lcl_m3") {
        s.lcl_m3 = toNum(text);
        s.step="resumen";
        await askResumen(from, s);
        return res.sendStatus(200);
      }

      if (s.step==="aer_origen") {
        s.origen_aeropuerto = text;
        s.destino_aeropuerto = "Ezeiza (EZE)";
        s.step="aer_peso";
        await sendText(from,"⚖️ *Peso en KG* (ej.: 150).");
        return res.sendStatus(200);
      }
      if (s.step==="aer_peso") {
        s.peso_kg = toNum(text);
        s.step="aer_vol";
        await sendText(from,"📦 *Volumen en M³* (ej.: 0.8).");
        return res.sendStatus(200);
      }
      if (s.step==="aer_vol") {
        s.vol_cbm = toNum(text);
        s.step="resumen";
        await askResumen(from, s);
        return res.sendStatus(200);
      }

      if (s.step==="ter_origen") {
        s.origen_direccion = text;
        s.destino_direccion = "Buenos Aires";
        s.step="resumen";
        await askResumen(from, s);
        return res.sendStatus(200);
      }

      if (s.step==="courier_origen") {
        s.origen_aeropuerto = text;
        s.destino_aeropuerto = "Ezeiza (EZE)";
        s.step="courier_peso";
        await sendText(from,"⚖️ *Peso en KG* (ej.: 5).");
        return res.sendStatus(200);
      }
      if (s.step==="courier_peso") {
        s.peso_kg = toNum(text);
        s.step="resumen";
        await askResumen(from, s);
        return res.sendStatus(200);
      }

      if (s.step==="exw_dir") {
        s.exw_direccion = text;
        await sendText(from,"✅ Dirección EXW registrada.");
        s.step="upsell";
        await upsellDespacho(from);
        return res.sendStatus(200);
      }

      // Calculadora
      if (s.step==="calc_desc_wait") {
        const query = text;
        const M = await getMatrix();
        const V = indexMatrix(M);

        const n3Matches = distinct(
          V.filter(x => norm(x.niv3).includes(norm(query)) || norm(x.sub).includes(norm(query))),
          x => x.niv3
        ).filter(Boolean);

        if (!n3Matches.length) {
          s.matriz = M[0] || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa_est:TASA_ESTATISTICA };
          s.producto_desc = query;
          s.step="calc_fob_unit";
          await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).");
        } else {
          const rows = listFrom(n3Matches,"n3s");
          s._find = { V, n3Matches };
          await sendList(from, "Elegí *Nivel 3: Categoría*:", rows, "Nivel 3: Categoría", "Elegir");
          s.step = "calc_find_n3_pick";
        }
        return res.sendStatus(200);
      }

      if (s.step==="calc_fob_unit") {
        s.fob_unit = toNum(text);
        s.step="calc_cantidad";
        await sendText(from,"🔢 *Cantidad de unidades* (ej.: 100).");
        return res.sendStatus(200);
      }
      if (s.step==="calc_cantidad") {
        s.cantidad = toNum(text);
        s.fob_total = (s.fob_unit||0) * (s.cantidad||0);
        s.step="calc_peso";
        await sendText(from,"⚖️ *Peso total en KG* (ej.: 500).");
        return res.sendStatus(200);
      }
      if (s.step==="calc_peso") {
        s.peso_kg = toNum(text);
        s.step="calc_vol";
        await sendText(from,"📦 *Volumen total en M³* (ej.: 2.5).");
        return res.sendStatus(200);
      }
      if (s.step==="calc_vol") {
        s.vol_cbm = toNum(text);
        s.step="c_modo";
        await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]);
        return res.sendStatus(200);
      }

      // COSTEADOR - captura Puerto de ORIGEN antes de confirmar
      if (s.flow==="calc" && s.step==="c_origen_puerto"){
        s.origen_puerto = text;
        s.step = "c_confirm";
        await confirmCalc(from, s);
        return res.sendStatus(200);
      }

      // Email
      if (s.step==="ask_email"){
        const mail = text.trim();
        // si querés mantener un mínimo:
        if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(mail)){
          await sendText(from, "⚠️ Ingresá un email válido (ej.: nombre@empresa.com).");
          return res.sendStatus(200);
        }
        s.email = mail;
        await sendText(from, "¡Perfecto! Te enviamos la cotización por correo. ✅");
        await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","email", "", "", "", "", "", "", `email=${mail}`]);
        s.step = "upsell";
        await upsellDespacho(from);
        return res.sendStatus(200);
      }

      // Flete Local
      if (s.flow==="local" && s.step==="local_dir") {
        s.local_direccion = text;
        s.step="local_calc";
        try {
          const r = await cotizarFleteLocal({
            capacidad: s.local_cap||"",
            tipo: s.local_tipo||"seca",
            distancia: s.local_distancia||"CABA"
          });
          if (!r) {
            await sendText(from,"❌ No encontré esa combinación en *Flete Local*.");
            return res.sendStatus(200);
          }
          const resp = `✅ *Flete Local estimado*
$ ${fmtARS(r.totalARS)} ARS

*Capacidad:* ${s.local_cap}
*Tipo:* ${s.local_tipo}
*Distancia:* ${s.local_distancia}
*Dirección:* ${s.local_direccion}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* Tarifa orientativa. Sujeta a confirmación.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","flete_local", s.local_direccion||"", "Buenos Aires", s.local_cap||"", s.local_tipo||"", s.local_distancia||"", r.totalARS, `Flete Local ${s.local_cap} ${s.local_tipo} ${s.local_distancia}`]);
          await endFlow(from);
          sessions.delete(from);
        } catch (e) {
          console.error("flete local error", e);
          await sendText(from,"⚠️ Error al calcular flete local.");
        }
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    /* ===== INTERACTIVE (botones/listas) ===== */
    if (type==="interactive") {

      // ===== Menú principal
      if (btnId==="action_cotizar"){ s.flow=null; s.step="choose_modo"; await sendModos(from); }
      else if (btnId==="action_calcular"){ s.flow="calc"; s.step="calc_prod_m"; await askProdMetodo(from); }
      else if (btnId==="action_local"){ s.flow="local"; s.step="local_cap";
        const caps = ["1 Pallet - 2 m3 -500 Kg","3 Pallet - 9 m3 - 1500 Kg","6 Pallet - 14 m3 - 3200 Kg","12 Pallet - 20 m3 - 10 TN","1x20","1x40","1x40 Jumbo"];
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
        if (s.modo==="terrestre"){ s.terrestre_tipo="FTL"; s.step="ter_origen"; await sendText(from,"🚛 *Terrestre FTL (Camión completo):* Indicá ciudad."); }
      }
      else if (btnId==="mar_LCL"){
        s.maritimo_tipo = "LCL";
        s.step="mar_origen"; await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
      }
      else if (btnId==="mar_FCL"){
        s.maritimo_tipo = "FCL"; s.step="mar_equipo"; await sendContenedores(from);
      }
      else if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        s.contenedor = btnId==="mar_FCL20" ? "20" : btnId==="mar_FCL40" ? "40" : "40HC";
        s.step="mar_origen";
        await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
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
      else if (btnId==="calc_desc"){ s.step="calc_desc_wait"; await sendText(from,"Escribí una *breve descripción* (p.ej., \"químicos\", \"memorias RAM\").");
 }
      else if (btnId==="calc_cat"){
        const M = await getMatrix(); const V = indexMatrix(M);
        const n1 = distinct(V, x=>x.niv1).filter(Boolean);
        await sendList(from, "Elegí *Nivel 1: Industria*:", listFrom(n1,"n1"), "Nivel 1: Industria", "Elegir");
        s._tree = { V, n1 }; s.step="calc_n1_pick";
      }
      else if (btnId==="calc_pop"){
        await sendList(from, "⭐ Productos más consultados:", listFrom(populares,"pop"), "Populares", "Ver");
        s.step="calc_pop_pick";
      }

      // POPULARES -> igual que búsqueda libre: intentamos mapear a NIV3/sub; si no, pedimos FOB
      else if (/^pop_\d+$/.test(btnId) && s.step==="calc_pop_pick"){
        const title = msg.interactive?.list_reply?.title || "";
        const query = title;
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
          await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).");
        } else {
          const rows = listFrom(n3Matches,"n3s");
          s._find = { V, n3Matches };
          await sendList(from, "Elegí *Nivel 3: Categoría*:", rows, "Nivel 3: Categoría", "Elegir");
          s.step = "calc_find_n3_pick";
        }
        return res.sendStatus(200);
      }

      // árbol picks
      else if (/^n1_\d+$/.test(btnId) && s.step==="calc_n1_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n1 = label;
        const V = s._tree.V;
        const n2 = distinct(V.filter(x=>x.niv1===label), x=>x.niv2).filter(Boolean);
        await sendList(from, "Elegí *Nivel 2: Sector*:", listFrom(n2,"n2"), "Nivel 2: Sector", "Elegir");
        s._tree.n2 = n2; s.step="calc_n2_pick";
      }
      else if (/^n2_\d+$/.test(btnId) && s.step==="calc_n2_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n2 = label;
        const V = s._tree.V;
        const n3 = distinct(V.filter(x=>x.niv1===s.sel_n1 && x.niv2===label), x=>x.niv3).filter(Boolean);
        await sendList(from, "Elegí *Nivel 3: Categoría*:", listFrom(n3,"n3"), "Nivel 3: Categoría", "Elegir");
        s._tree.n3 = n3; s.step="calc_n3_pick";
      }
      else if (/^n3_\d+$/.test(btnId) && s.step==="calc_n3_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        s.sel_n3 = label;
        const V = s._tree.V;
        const subs = distinct(V.filter(x=>x.niv1===s.sel_n1 && x.niv2===s.sel_n2 && x.niv3===label), x=>x.sub).filter(Boolean);
        await sendList(from, "Elegí *Nivel 4: Producto / Subcategoría*:", listFrom(subs,"sub"), "Nivel 4: Producto", "Elegir");
        s._tree.subs = subs; s.step="calc_sub_pick";
      }
      else if (/^sub_\d+$/.test(btnId) && s.step==="calc_sub_pick"){
        const label = msg.interactive?.list_reply?.title || "";
        const M = await getMatrix();
        const fila = M.find(x => clip24(x.SUB)===clip24(label)) || M[0];
        s.matriz = fila;
        s.categoria = label;
        s.step="calc_fob_unit";
        await sendText(from,"💵 Ingresá *FOB unitario (USD)* (ej.: 125,50).");
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
      
      // MODIFICACIÓN 1: Pedir puerto antes de confirmar
      else if (btnId==="c_lcl"){ 
        s.calc_maritimo_tipo = "LCL";
        s.step = "c_origen_puerto";
        await sendText(from, "📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
      }
      else if (btnId==="c_fcl"){ 
        s.calc_maritimo_tipo = "FCL"; 
        s.step = "c_cont"; 
        await sendContenedores(from); 
      }
      else if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId) && s.flow==="calc"){
        s.calc_contenedor = btnId==="mar_FCL20"?"20":btnId==="mar_FCL40"?"40":"40HC";
        s.step = "c_origen_puerto";
        await sendText(from, "📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
      }

      else if (btnId==="calc_edit"){ s.step="c_modo"; await sendButtons(from,"Elegí el modo de transporte:",[{id:"c_maritimo",title:"🚢 Marítimo"},{id:"c_aereo",title:"✈️ Aéreo"}]); }
      else if (btnId==="calc_go"){
        // === calcular CIF+impuestos
        const M = s.matriz || { di:0, iva:0.21, iva_ad:0, iibb:0.035, iigg:RATE_IIGG, internos:0, tasa_est:TASA_ESTATISTICA, nota:"" };
        let fleteUSD = 0, fleteDetalle = "";
        try{
          if (s.calc_modo==="aereo"){
            const r = await cotizarAereo({ origen: s.origen_aeropuerto || "Shanghai", kg: s.peso_kg||0, vol: (s.vol_cbm||0)*167 });
            if (r){ fleteUSD = r.totalUSD; fleteDetalle = `Flete ✈️ (Aéreo): USD ${fmtUSD(fleteUSD)}`; }
          } else if (s.calc_modo==="maritimo"){
            const modalidad = s.calc_maritimo_tipo==="FCL" ? (s.calc_contenedor?`FCL${s.calc_contenedor}`:"FCL") : "LCL";
            // MODIFICACIÓN 1C: usar vol_m3 en lugar de vol_cbm para LCL
            const wm = s.calc_maritimo_tipo==="LCL"
              ? Math.max( (s.lcl_tn||0), (s.vol_m3||s.vol_cbm||0) )  // usa vol_m3 (o vol_cbm si no renombraste)
              : null;
            const r = await cotizarMaritimo({ origen: s.origen_puerto || "Shanghai", modalidad, wm });
            if (r){ fleteUSD = r.totalUSD; fleteDetalle = `Flete 🚢 (Marítimo ${modalidad}): USD ${fmtUSD(fleteUSD)}`; }
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

        // MODIFICACIÓN 3: pedir email con pregunta binaria
        s.step = "ask_email_yesno";
        await sendButtons(from, "📧 ¿Querés que te enviemos la cotización por correo?", [
          { id:"email_si", title:"Sí" },
          { id:"email_no", title:"No" }
        ]);
      }

      // MODIFICACIÓN 3: handlers para email sí/no
      else if (btnId==="email_si"){
        s.step = "ask_email";
        await sendText(from, "Perfecto. Decime el *email* para enviarte la cotización.");
        return res.sendStatus(200);
      }
      else if (btnId==="email_no"){
        // seguir con upsell/cierre sin pedir mail
        s.step = "upsell";
        await upsellDespacho(from);
        return res.sendStatus(200);
      }

      // rating + volver
      else if (/^rate_[1-5]$/.test(btnId)){ 
        const val = Number(btnId.split("_")[1]);
        await sendText(from,"¡Gracias por tu calificación! ⭐"); 
        await logRating(from, s.empresa, val);
      }

      else if (btnId==="menu_si"){ await sendMainActions(from); }
      else if (btnId==="menu_no"){ await sendText(from,"¡Gracias! Si necesitás algo más, escribinos cuando quieras."); }

      // === Flete Local ===
      else if (/^cap_\d+$/.test(btnId) && s.flow==="local" && s.step==="local_cap"){
        s.local_cap = msg.interactive?.list_reply?.title || "";
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
        const idx = Number(btnId.split("_")[1]);
        s.local_distancia = s._localDists?.[idx]?.key || "CABA";
        s.step="local_dir";
        await sendText(from,"📍 *Dirección de entrega* (calle, altura, barrio).");
      }

      return res.sendStatus(200);
    }

    /* ===== COTIZAR ===== */
    if (s.step==="cotizar") {
      try {
        if (s.modo==="aereo") {
          if (s.aereo_tipo==="courier") {
            const r = await cotizarCourierTarifas({ pais: s.origen_aeropuerto||"", kg: s.peso_kg||0 });
            if (!r){ await sendText(from,"❌ No encontré esa región/peso en *Courier*."); return res.sendStatus(200); }
            const texto = `✅ *Tarifa estimada (Courier ${s.courier_pf})*
USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.
*Región:* ${r.region}
*Escalón:* ${r.escalonKg} kg${r.ajustado?" (ajustado)":""}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
            await sendText(from, texto);
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","courier", s.origen_aeropuerto, r.destino, s.courier_pf, "", "courier", r.totalUSD, `Courier ${s.courier_pf} ${s.origen_aeropuerto}→${r.destino} ${r.escalonKg}kg`]);
          } else {
            const r = await cotizarAereo({ origen: s.origen_aeropuerto||"", kg: s.peso_kg||0, vol: (s.vol_cbm||0)*167 });
            if (!r){ await sendText(from,"❌ No encontré esa ruta en *Aéreos*."); return res.sendStatus(200); }
            const texto = `✅ *Tarifa estimada (Aéreo)*
USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.
*Origen:* ${s.origen_aeropuerto}
*Peso facturable:* ${r.facturableKg} kg${r.applyMin?" (mínimo aplicado)":""}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
            await sendText(from, texto);
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","aereo", s.origen_aeropuerto, r.destino, "", "", "carga_general", r.totalUSD, `Aéreo ${s.origen_aeropuerto}→${r.destino} ${r.facturableKg}kg`]);
          }
        } else if (s.modo==="maritimo") {
          if (s.maritimo_tipo==="LCL") {
            const wm = Math.max(s.lcl_tn||0, s.lcl_m3||0);
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad: "LCL", wm });
            if (!r){ await sendText(from,"❌ No encontré esa ruta en *Marítimos*."); return res.sendStatus(200); }
            const texto = `✅ *Tarifa estimada (Marítimo LCL)*
USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.
*Origen:* ${s.origen_puerto}
*W/M:* ${wm} (${s.lcl_tn||0}t / ${s.lcl_m3||0}m³)

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
            await sendText(from, texto);
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", "LCL", r.totalUSD, `Marítimo LCL ${s.origen_puerto}→${r.destino} WM:${wm}`]);
          } else { // FCL
            const modalidad = "FCL" + (s.contenedor||"");
            const r = await cotizarMaritimo({ origen: s.origen_puerto, modalidad });
            if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*."); return res.sendStatus(200); }
            const texto = `✅ *Tarifa estimada (Marítimo ${modalidad})*
USD ${fmtUSD(r.totalUSD)} + *Gastos Locales*.
*Origen:* ${s.origen_puerto}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
            await sendText(from, texto);
            await logSolicitud([new Date().toISOString(), from, "", s.empresa, "whatsapp","maritimo", s.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.origen_puerto}→${r.destino}`]);
          }
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

        // MODIFICACIÓN 3: pregunta binaria para email
        s.step = "ask_email_yesno";
        await sendButtons(from, "📧 ¿Querés que te enviemos la cotización por correo?", [
          { id:"email_si", title:"Sí" },
          { id:"email_no", title:"No" }
        ]);

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
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador + Costeo + Local ✅ v4.0"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

/* ========= Start ========= */
app.listen(PORT, ()=> console.log(`🚀 Bot v4.0 en http://localhost:${PORT}`));

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
      lines.push(`• W/M input: t=${fmtUSD(d.lcl_tn||0)} • m³=${fmtUSD(d.lcl_m3||0)}`);
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
  const rows = await readTabRange(TAR_SHEET_ID, TAB_COU_HINT, "A1:Z10000", ["courier"]);
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

