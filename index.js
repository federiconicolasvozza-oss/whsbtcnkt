// index.js — Conektar S.A. • Bot de Cotizaciones (ESM) • v2.2
// - Bienvenida con bandera `welcomed` (evita loop)
// - Menú principal + pedido de empresa en paralelo, sin resets
// - Cotizadores: Aéreo (carga/courier), Marítimo (LCL/FCL), Terrestre (FTL)
// - EXW y upsell despacho

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
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();

const TAR_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AER_HINT = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MAR_HINT = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TER_HINT = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COU_HINT = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();

const LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);
const LOGO_URL = (
  process.env.LOGO_URL ||
  "https://www.conektarsa.com/wp-content/uploads/2022/06/cropped-Logo-1-2048x521.png"
).trim();

/* ====== Google OAuth ====== */
function credPath(file) {
  const p1 = path.join("/etc/secrets", file);
  try { fs.accessSync(p1); return p1; } catch {}
  return path.join(process.cwd(), "credentials", file);
}
const CLIENT_PATH = credPath("oauth_client.json");
const TOKEN_PATH  = credPath("oauth_token.json");

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

/* ====== Utils ====== */
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

/* ====== WhatsApp API ====== */
async function waSend(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>"(no body)");
    console.error("WA error", res.status, t);
  }
  return res.ok;
}
const sendText = (to, body) => waSend({ messaging_product:"whatsapp", to, type:"text", text:{ body } });
const sendButtons = (to, text, buttons) =>
  waSend({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{ type:"button", body:{ text }, action:{ buttons: buttons.map(b => ({type:"reply", reply:{id:b.id, title:b.title}})) } }
  });
const sendImage = (to, link, caption="") =>
  waSend({ messaging_product:"whatsapp", to, type:"image", image:{ link, caption } });

/* ====== Lectura de pestañas con tolerancia ====== */
const tabCache = new Map();
async function resolveTabTitle(sheetId, hint, extras = []) {
  const n = norm(hint);
  if (!tabCache.has(sheetId)) {
    const meta = await sheetsClient().spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets(properties(title))" });
    const map = {};
    for (const s of meta.data.sheets || []) { const t = s.properties?.title || ""; map[norm(t)] = t; }
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

/* ====== LOG en Sheets ====== */
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

/* ====== Datos auxiliares ====== */
const COUNTRY_TO_REGION = {
  "argentina":"america sur","brasil":"america sur","chile":"america sur","uruguay":"america sur","paraguay":"america sur","bolivia":"america sur","peru":"america sur","colombia":"america sur","ecuador":"america sur","venezuela":"america sur",
  "estados unidos":"usa & canadá","usa":"usa & canadá","eeuu":"usa & canadá","united states":"usa & canadá","canada":"usa & canadá","canadá":"usa & canadá",
  "españa":"europa","portugal":"europa","francia":"europa","alemania":"europa","italia":"europa","paises bajos":"europa","reino unido":"europa","uk":"europa","holanda":"europa","belgica":"europa","suiza":"europa","suecia":"europa","noruega":"europa","dinamarca":"europa","irlanda":"europa","polonia":"europa","chequia":"europa","austria":"europa",
  "china":"asia","hong kong":"asia","india":"asia","japon":"asia","japón":"asia","corea":"asia","singapur":"asia","tailandia":"asia","vietnam":"asia","malasia":"asia","indonesia":"asia","emiratos arabes":"asia","emiratos árabes":"asia","arabia saudita":"asia","qatar":"asia","turquia":"asia","turquía":"asia","doha":"asia","dubai":"asia"
};
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

/* ====== COTIZADORES ====== */
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

/* ====== Estado de sesión ====== */
const sessions = new Map();
const emptyState = () => ({
  empresa:null, modo:null,
  maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null,
  terrestre_tipo:"FTL", origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, tarifa:null, moneda:"USD", validez_dias:VALIDEZ_DIAS,
  exw_dir:null, valor_mercaderia:null, tipo_mercaderia:null,
  welcomed:false
});
function getS(id){ if(!sessions.has(id)) sessions.set(id,{step:"start", data:emptyState()}); return sessions.get(id); }

/* ====== UI ====== */
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
      lines.push(`• Subtipo: *Courier*`);
      lines.push(`• Origen: *${d.origen_aeropuerto || "?"}* ➡️ *${d.destino_aeropuerto}*`);
      if (d.peso_kg!=null) lines.push(`• Peso: *${fmt(d.peso_kg)} kg*`);
    }
  }
  if (d.modo==="terrestre"){
    lines.push(`• Tipo: *FTL*`);
    lines.push(`• Origen: *${d.origen_direccion || "?"}* ➡️ *${d.destino_direccion}*`);
  }
  lines.push("\n¿Confirmás para cotizar?");
  return lines.join("\n");
}
async function askResumen(to, d){
  return sendButtons(to, resumenTexto(d), [
    { id:"confirmar", title:"✅ Confirmar" },
    { id:"editar",    title:"✏️ Editar" },
    { id:"cancelar",  title:"Cancelar" }
  ]);
}
async function upsellDespacho(to){
  return sendButtons(to, "¿Sabías que también somos *despachantes de aduana*? ¿Te interesaría cotizarlo?", [
    { id:"desp_si", title:"Sí" },
    { id:"desp_no", title:"No" }
  ]);
}

/* ====== VERIFY ====== */
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ====== WEBHOOK ====== */
app.post("/webhook", async (req,res)=>{
  try{
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from  = msg.from;
    const s     = getS(from);
    const type  = msg.type;
    const text  = (type==="text") ? (msg.text?.body || "").trim() : "";
    const lower = norm(text);
    const btnId = (type==="interactive") ? (msg.interactive?.button_reply?.id || "") : "";

    // helper: bienvenida una sola vez
    const showWelcomeOnce = async () => {
      if (s.data.welcomed) return;
      s.data.welcomed = true;
      await sendImage(from, LOGO_URL, "Conektar S.A. — Logística internacional");
      await sendButtons(
        from,
        "¡Bienvenido/a al *Bot de Cotizaciones de Conektar S.A.*! 👋\nElegí el modo:",
        [
          { id:"menu_maritimo",  title:"🚢 Marítimo" },
          { id:"menu_aereo",     title:"✈️ Aéreo" },
          { id:"menu_terrestre", title:"🚛 Terrestre" }
        ]
      );
      await sendText(from, "Para empezar, decime el *nombre de tu empresa*.");
      s.step = s.step || "ask_empresa";
    };

    // arranque/volver sin resetear
    if (type==="text" && ["hola","menu","inicio","start","volver"].includes(lower)) {
      await showWelcomeOnce();
      return res.sendStatus(200);
    }
    if (!s.data.welcomed) {
      await showWelcomeOnce();
      // si el primer mensaje ya es empresa, guardarla
      if (type==="text" && text && !["hola","menu","inicio","start","volver"].includes(lower)) {
        s.data.empresa = text;
        await sendText(from, `Gracias. Empresa guardada: *${s.data.empresa}*`);
      }
      return res.sendStatus(200);
    }

    /* ===== BOTONES ===== */
    if (type==="interactive") {
      // Menú principal
      if (btnId.startsWith("menu_")) {
        s.data.modo = btnId.replace("menu_","");
        if (!s.data.empresa) { s.step="ask_empresa"; await sendText(from,"Antes de seguir, decime el *nombre de tu empresa*."); return res.sendStatus(200); }

        if (s.data.modo==="maritimo"){
          s.step="mar_tipo";
          await sendButtons(from,"🚢 *Marítimo:* Elegí modalidad",[
            { id:"mar_LCL", title:"LCL" },
            { id:"mar_FCL", title:"FCL" }
          ]);
        } else if (s.data.modo==="aereo"){
          s.step="aereo_subtipo";
          await sendButtons(from,"✈️ *Aéreo:* ¿Qué necesitás cotizar?",[
            { id:"aer_carga",   title:"Carga general" },
            { id:"aer_courier", title:"Courier" }
          ]);
        } else if (s.data.modo==="terrestre"){
          s.data.terrestre_tipo="FTL";
          s.step="ter_origen";
          await sendText(from,"🚛 *Terrestre FTL:* Indicá ciudad/país de ORIGEN.");
        }
        return res.sendStatus(200);
      }

      // Marítimo
      if (btnId==="mar_LCL" || btnId==="mar_FCL"){
        s.data.maritimo_tipo = btnId==="mar_LCL" ? "LCL" : "FCL";
        if (s.data.maritimo_tipo==="FCL"){
          s.step="mar_equipo";
          await sendButtons(from,"⚓ Elegí equipo",[
            { id:"mar_FCL20",  title:"1×20’" },
            { id:"mar_FCL40",  title:"1×40’" },
            { id:"mar_FCL40HC",title:"1×40’ HC" }
          ]);
        } else {
          s.step="mar_origen";
          await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
        }
        return res.sendStatus(200);
      }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(btnId)){
        s.data.contenedor = btnId.replace("mar_FCL","");
        s.step="mar_origen";
        await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
        return res.sendStatus(200);
      }

      // Aéreo subtipo
      if (btnId==="aer_carga" || btnId==="aer_courier"){
        s.data.aereo_tipo = btnId==="aer_carga" ? "carga_general" : "courier";
        if (s.data.aereo_tipo==="carga_general"){
          s.step="aer_origen";
          await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad. Ej.: PVG / Shanghai).");
        } else {
          s.step="courier_origen";
          await sendText(from,"🌍 *País/Ciudad ORIGEN* (ej.: España / China / USA).");
        }
        return res.sendStatus(200);
      }

      // Resumen
      if (btnId==="confirmar"){ s.step="cotizar"; }
      if (btnId==="editar"){ await showWelcomeOnce(); s.step="ask_empresa"; return res.sendStatus(200); }
      if (btnId==="cancelar"){ sessions.delete(from); await sendText(from,"Solicitud cancelada. ¡Gracias!"); return res.sendStatus(200); }

      // EXW y despacho
      if (btnId==="exw_si"){ s.step="exw_dir"; await sendText(from,"📍 *Dirección EXW* (calle, ciudad, CP, país)."); return res.sendStatus(200); }
      if (btnId==="exw_no"){ s.step="ask_despacho"; await upsellDespacho(from); return res.sendStatus(200); }
      if (btnId==="desp_si"){ s.step="desp_valor"; await sendText(from,"💰 *Valor de la mercadería (USD)*"); return res.sendStatus(200); }
      if (btnId==="desp_no"){ sessions.delete(from); await sendText(from,"¡Gracias por tu consulta! 🙌\n📧 comercial@conektarsa.com"); return res.sendStatus(200); }
    }

    /* ===== TEXTO ===== */
    if (type==="text") {
      // Empresa
      if (s.step==="ask_empresa"){
        s.data.empresa = text;
        await sendText(from, `Gracias. Empresa guardada: *${s.data.empresa}*`);
        // si ya había modo elegido, retomar
        if (s.data.modo==="maritimo"){
          s.step="mar_tipo";
          await sendButtons(from,"🚢 *Marítimo:* Elegí modalidad",[
            { id:"mar_LCL", title:"LCL" },
            { id:"mar_FCL", title:"FCL" }
          ]);
        } else if (s.data.modo==="aereo"){
          s.step="aereo_subtipo";
          await sendButtons(from,"✈️ *Aéreo:* ¿Qué necesitás cotizar?",[
            { id:"aer_carga",   title:"Carga general" },
            { id:"aer_courier", title:"Courier" }
          ]);
        } else if (s.data.modo==="terrestre"){
          s.data.terrestre_tipo="FTL";
          s.step="ter_origen";
          await sendText(from,"🚛 *Terrestre FTL:* Indicá ciudad/país de ORIGEN.");
        }
        return res.sendStatus(200);
      }

      // Marítimo
      if (s.step==="mar_origen"){
        s.data.origen_puerto = text;
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // Aéreo carga general
      if (s.step==="aer_origen"){
        s.data.origen_aeropuerto = text;
        s.step="aer_peso";
        await sendText(from,"⚖️ *Peso (kg)* (entero).");
        return res.sendStatus(200);
      }
      if (s.step==="aer_peso"){
        const peso = toNum(text); if (isNaN(peso)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); }
        s.data.peso_kg = Math.max(0, Math.round(peso));
        s.step="aer_vol";
        await sendText(from,"📦 *Peso volumétrico (kg)* (poné 0 si no sabés).");
        return res.sendStatus(200);
      }
      if (s.step==="aer_vol"){
        const vol = toNum(text); if (isNaN(vol)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); }
        s.data.vol_cbm = Math.max(0, vol);
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // Courier
      if (s.step==="courier_origen"){
        s.data.origen_aeropuerto = text; // país/ciudad
        s.step="courier_peso";
        await sendText(from,"⚖️ *Peso (kg)* (podés usar decimales).");
        return res.sendStatus(200);
      }
      if (s.step==="courier_peso"){
        const peso = toNum(text); if (isNaN(peso)) { await sendText(from,"Ingresá un número válido."); return res.sendStatus(200); }
        s.data.peso_kg = peso;
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // Terrestre
      if (s.step==="ter_origen"){
        s.data.origen_direccion = text;
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // EXW
      if (s.step==="exw_dir"){
        s.data.exw_dir = text;
        await sendText(from,"🧑‍💼 El equipo comercial está trabajando en la solicitud y te contactaremos en breve.");
        s.step="ask_despacho";
        await upsellDespacho(from);
        return res.sendStatus(200);
      }

      // Despacho
      if (s.step==="desp_valor"){
        s.data.valor_mercaderia = text;
        s.step="desp_merc";
        await sendText(from,"📦 *¿Qué mercadería es?*");
        return res.sendStatus(200);
      }
      if (s.step==="desp_merc"){
        s.data.tipo_mercaderia = text;
        await sendText(from,"Gracias, en breve nos comunicaremos contigo para brindarte la tarifa. 🙌");
        sessions.delete(from);
        return res.sendStatus(200);
      }
    }

    /* ===== COTIZAR ===== */
    if (s.step==="cotizar"){
      try{
        if (s.data.modo==="aereo" && s.data.aereo_tipo==="carga_general"){
          const r = await cotizarAereo({ origen: s.data.origen_aeropuerto, kg: s.data.peso_kg||0, vol: s.data.vol_cbm||0 });
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
          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","aereo", s.data.origen_aeropuerto, r.destino, s.data.peso_kg||"", s.data.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.data.origen_aeropuerto}→${r.destino}`]);
        } else if (s.data.modo==="aereo" && s.data.aereo_tipo==="courier"){
          const r = await cotizarCourier({ pais: s.data.origen_aeropuerto, kg: s.data.peso_kg||0 });
          if (!r){ await sendText(from,"❌ No pude calcular *Courier*. Revisá la pestaña."); return res.sendStatus(200); }
          const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg.` : "";
          const resp =
`✅ *Tarifa estimada (COURIER)*
*Peso:* ${fmt(s.data.peso_kg)} kg${nota}
*Total:* USD ${fmt(r.totalUSD)} + *Gastos Locales*

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","courier", s.data.origen_aeropuerto, r.destino, s.data.peso_kg||"", "", "", r.totalUSD, `Courier ${s.data.origen_aeropuerto}`]);
        } else if (s.data.modo==="maritimo"){
          const modalidad = s.data.maritimo_tipo==="FCL" ? (s.data.contenedor?`FCL${s.data.contenedor}`:"FCL") : "LCL";
          const r = await cotizarMaritimo({ origen: s.data.origen_puerto, modalidad });
          if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*. Usá el nombre tal cual figura."); return res.sendStatus(200); }
          const resp =
`✅ *Tarifa estimada (Marítimo ${modalidad})*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.
*Origen:* ${s.data.origen_puerto}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","maritimo", s.data.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.data.origen_puerto}→${r.destino}`]);
        } else if (s.data.modo==="terrestre"){
          const r = await cotizarTerrestre({ origen: s.data.origen_direccion || "" });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Terrestres*."); return res.sendStatus(200); }
          const resp =
`✅ *Tarifa estimada (TERRESTRE FTL)*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","terrestre", s.data.origen_direccion||"", r.destino, "", "", "FTL", r.totalUSD, `Terrestre ${s.data.origen_direccion}→${r.destino}`]);
        }

        await sendText(from, "✅ *Tu consulta ha sido registrada correctamente.*\nNuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n📧 comercial@conektarsa.com");
        s.step = "exw_q";
        await sendButtons(from, "¿Tu carga es EXW?", [
          { id:"exw_si", title:"Sí" },
          { id:"exw_no", title:"No" }
        ]);
      }catch(e){
        console.error("cotizar error", e);
        await sendText(from,"⚠️ Hubo un problema al leer la planilla. Revisá nombres de pestañas y permisos.");
      }
      return res.sendStatus(200);
    }

    // nada más que hacer, no reseteamos
    return res.sendStatus(200);
  }catch(e){
    console.error("webhook error", e);
    return res.sendStatus(200);
  }
});

/* ====== HEALTH ====== */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador de Fletes ✅ v2.2"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

app.listen(PORT, ()=> console.log(`🚀 Bot v2.2 en http://localhost:${PORT}`));
