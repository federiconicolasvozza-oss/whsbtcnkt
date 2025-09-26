// index.js — Conektar S.A. • Bot de Cotizaciones (ESM)
// - Datos desde tus Google Sheets (Aéreos / Marítimos / Terrestres / Courier)
// - Bienvenida con logo, SOLO BOTONES (máx 3 por mensaje), tono cálido rioplatense
// - Flujo con RESUMEN + Confirmar / Editar
// - Upsell: despacho aduanero (Sí / No) post-cotización
// - Registro en hoja “Solicitudes”
// - Match tolerante de aeropuertos (IATA/ciudad) y puertos
// - Pestañas resueltas de forma robusta (evita A1:H10000 inválidos)

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
  return m ? Number(m[0]) : 0;
};
const fmt = n => isFinite(n) ? Number(n).toFixed(2) : "0.00";
const chargeable = (kg, vol) => Math.max(Math.ceil(kg||0), Math.ceil(vol||0));

function headerIndex(header, ...names) {
  const H = header.map(h => norm(h));
  const targets = names.map(x => norm(x));
  return H.findIndex(h => targets.some(t => h === t || h.includes(t)));
}

/* ====== WhatsApp helpers ====== */
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

/* ====== Resolución robusta de pestañas ====== */
const tabCache = new Map(); // sheetId -> { normTitle: realTitle }
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
  await sheetsClient().spreadsheets.values.append({
    spreadsheetId: LOG_SHEET_ID,
    range: `${LOG_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

/* ====== COUNTRY → REGION (Courier) ====== */
const COUNTRY_TO_REGION = {
  "argentina":"america sur","brasil":"america sur","chile":"america sur","uruguay":"america sur","paraguay":"america sur","bolivia":"america sur","peru":"america sur","colombia":"america sur","ecuador":"america sur","venezuela":"america sur",
  "estados unidos":"usa & canadá","usa":"usa & canadá","eeuu":"usa & canadá","united states":"usa & canadá","canada":"usa & canadá","canadá":"usa & canadá",
  "españa":"europa","portugal":"europa","francia":"europa","alemania":"europa","italia":"europa","paises bajos":"europa","reino unido":"europa","uk":"europa","holanda":"europa","belgica":"europa","suiza":"europa","suecia":"europa","noruega":"europa","dinamarca":"europa","irlanda":"europa","polonia":"europa","chequia":"europa","austria":"europa",
  "china":"asia","hong kong":"asia","india":"asia","japon":"asia","japón":"asia","corea":"asia","singapur":"asia","tailandia":"asia","vietnam":"asia","malasia":"asia","indonesia":"asia","emiratos arabes":"asia","emiratos árabes":"asia","arabia saudita":"asia","qatar":"asia","turquia":"asia","turquía":"asia","doha":"asia","dubai":"asia"
};

/* ====== Aeropuertos (sinónimos IATA/ciudad) ====== */
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

  return { pricePerKg, minKg, facturableKg: facturable, applyMin, totalUSD: pricePerKg * facturable, destino: "Buenos Aires (EZE)" };
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
  return { region, escalonKg: usado, ajustado, totalUSD: toNum(exact[col]), destino: "Buenos Aires (EZE)" };
}

/* ====== UI ====== */
async function sendHome(to) {
  await sendImage(to, LOGO_URL, "Conektar S.A. — Logística internacional");
  return sendButtons(
    to,
    "¡Bienvenido/a al *Bot de Cotizaciones de Conektar S.A.*! 👋\nElegí el modo:",
    [
      { id:"menu_maritimo",  title:"🚢 Marítimo" },
      { id:"menu_aereo",     title:"✈️ Aéreo" },
      { id:"menu_terrestre", title:"🚛 Terrestre" }
    ]
  );
}

/* ====== Verify ====== */
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ====== STATE ====== */
const sessions = new Map();
const emptyState = () => ({
  empresa:null, modo:null,
  maritimo_tipo:null, contenedor:null, origen_puerto:null, destino_puerto:"Buenos Aires (AR)",
  aereo_tipo:null, origen_aeropuerto:null, destino_aeropuerto:"Ezeiza (EZE)",
  courier_persona:null,
  terrestre_tipo:null, origen_direccion:null, destino_direccion:"Buenos Aires (AR)",
  peso_kg:null, vol_cbm:null, tarifa:null, moneda:"USD", validez_dias:VALIDEZ_DIAS
});
function getS(id){ if(!sessions.has(id)) sessions.set(id,{step:"start", data:emptyState()}); return sessions.get(id); }

/* ====== Helpers de flujo ====== */
function resumenTexto(d){
  const lines = [];
  lines.push("🧾 *Revisá los datos:*");
  if (d.empresa) lines.push(`• Empresa: *${d.empresa}*`);
  if (d.modo)    lines.push(`• Modo: *${d.modo}*`);
  if (d.modo==="maritimo"){
    lines.push(`• Tipo: *${d.maritimo_tipo || "-"}* ${d.contenedor?`(Equipo: ${d.contenedor})`:""}`);
    lines.push(`• Ruta: *${d.origen_puerto || "?"}* ➡️ *${d.destino_puerto}*`);
  }
  if (d.modo==="aereo"){
    if(d.aereo_tipo==="carga_general"){
      lines.push(`• Subtipo: *Carga general*`);
      lines.push(`• Ruta: *${d.origen_aeropuerto || "?"}* ➡️ *${d.destino_aeropuerto}*`);
      if (d.peso_kg!=null) lines.push(`• Peso: *${d.peso_kg} kg*`);
      if (d.vol_cbm!=null) lines.push(`• Peso volumétrico: *${d.vol_cbm} kg*`);
    } else {
      lines.push(`• Subtipo: *Courier* (${d.courier_persona||"—"})`);
      lines.push(`• Origen: *${d.origen_aeropuerto || "?"}* ➡️ Destino: *${d.destino_aeropuerto}*`);
      if (d.peso_kg!=null) lines.push(`• Peso: *${fmt(d.peso_kg)} kg*`);
    }
  }
  if (d.modo==="terrestre"){
    lines.push(`• Tipo: *${d.terrestre_tipo || "-"}*`);
    lines.push(`• Origen: *${d.origen_direccion || "?"}* ➡️ Destino: *${d.destino_direccion}*`);
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
  return sendButtons(to, "¿Te interesaría cotizar también el *despacho aduanero*?", [
    { id:"desp_si", title:"Sí" },
    { id:"desp_no", title:"No" }
  ]);
}

/* ====== WEBHOOK ====== */
app.post("/webhook", async (req,res)=>{
  try{
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const s = getS(from);
    const type = msg.type;
    const bodyTxt = type==="text" ? (msg.text?.body || "").trim() : "";
    const lower = norm(bodyTxt);

    // restart keywords
    if (type==="text" && ["hola","menu","inicio","volver","start"].includes(lower)) {
      sessions.set(from,{step:"start", data:emptyState()});
      await sendHome(from);
      return res.sendStatus(200);
    }

    // ======= BOTONES =======
    if (type==="interactive") {
      const id = msg.interactive?.button_reply?.id;

      // menú principal
      if (["menu_maritimo","menu_aereo","menu_terrestre"].includes(id)) {
        s.data = emptyState(); // reset
        s.data.modo = id.replace("menu_","");
        s.step = "empresa";
        await sendText(from,"🔹 *¿A nombre de qué empresa es la consulta?*");
        return res.sendStatus(200);
      }

      // marítimo tipo
      if (["mar_LCL","mar_FCL","mar_volver"].includes(id)) {
        if (id==="mar_volver"){ await sendHome(from); sessions.delete(from); return res.sendStatus(200); }
        s.data.maritimo_tipo = (id==="mar_LCL")?"LCL":"FCL";
        if (s.data.maritimo_tipo==="FCL"){
          s.step = "mar_equipo";
          await sendButtons(from,"⚓ *Elegí equipo*",[
            { id:"mar_FCL20", title:"1×20’" },
            { id:"mar_FCL40", title:"1×40’" },
            { id:"mar_FCL40HC", title:"1×40’ HC" }
          ]);
        } else {
          s.step = "mar_origen";
          await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
        }
        return res.sendStatus(200);
      }
      if (["mar_FCL20","mar_FCL40","mar_FCL40HC"].includes(id)) {
        s.data.contenedor = id.replace("mar_FCL","");
        s.step = "mar_origen";
        await sendText(from,"📍 *Puerto de ORIGEN* (ej.: Shanghai / Ningbo / Shenzhen).");
        return res.sendStatus(200);
      }

      // aéreo subtipo
      if (["aer_carga","aer_courier","aer_volver"].includes(id)){
        if (id==="aer_volver"){ await sendHome(from); sessions.delete(from); return res.sendStatus(200); }
        s.data.aereo_tipo = id==="aer_carga" ? "carga_general" : "courier";
        if (s.data.aereo_tipo==="carga_general"){
          s.step = "aer_origen";
          await sendText(from,"✈️ *AEROPUERTO ORIGEN* (IATA o ciudad. Ej.: PVG / Shanghai).");
        } else {
          s.step = "courier_persona";
          await sendButtons(from,"📦 *¿Quién envía?*",[
            { id:"courier_pf", title:"Persona Física" },
            { id:"courier_pj", title:"Persona Jurídica" },
            { id:"aer_volver", title:"Volver" }
          ]);
        }
        return res.sendStatus(200);
      }
      if (["courier_pf","courier_pj"].includes(id)){
        s.data.courier_persona = (id==="courier_pf")?"fisica":"juridica";
        s.step = "courier_origen";
        await sendText(from,"🌍 *País/Ciudad de ORIGEN* (ej.: España / China / USA).");
        return res.sendStatus(200);
      }

      // terrestre tipo
      if (["ter_LTL","ter_FTL","ter_volver"].includes(id)){
        if (id==="ter_volver"){ await sendHome(from); sessions.delete(from); return res.sendStatus(200); }
        s.data.terrestre_tipo = (id==="ter_LTL")?"LTL":"FTL";
        s.step = "ter_origen";
        const hint = s.data.terrestre_tipo==="LTL"
          ? "🏠 *Dirección ORIGEN* con ciudad y CP (ej.: Av. Siempre Viva 742, CABA, CP 1001)."
          : "📍 *Ciudad/País ORIGEN* (ej.: San Pablo – Brasil).";
        await sendText(from,hint);
        return res.sendStatus(200);
      }

      // resumen
      if (id==="confirmar"){
        s.step="cotizar";
        // se resuelve en bloque de texto más abajo
      }
      if (id==="editar"){
        // vuelvo a pedir según modo
        if (s.data.modo==="maritimo"){
          s.step="maritimo_modalidad";
          await sendButtons(from,"🚢 *Marítimo.* Elegí modalidad:",[
            { id:"mar_LCL", title:"LCL" },
            { id:"mar_FCL", title:"FCL" },
            { id:"mar_volver", title:"Volver" }
          ]);
        } else if (s.data.modo==="aereo"){
          s.step="aereo_subtipo";
          await sendButtons(from,"✈️ ¿Qué necesitás cotizar?",[
            { id:"aer_carga", title:"Carga general" },
            { id:"aer_courier", title:"Courier" },
            { id:"aer_volver", title:"Volver" }
          ]);
        } else {
          s.step="terrestre_tipo";
          await sendButtons(from,"🚛 *Terrestre:*",[
            { id:"ter_LTL", title:"LTL" },
            { id:"ter_FTL", title:"FTL" },
            { id:"ter_volver", title:"Volver" }
          ]);
        }
        return res.sendStatus(200);
      }
      if (id==="cancelar"){
        sessions.set(from,{step:"start", data:emptyState()});
        await sendHome(from);
        return res.sendStatus(200);
      }

      // upsell despacho
      if (id==="desp_si"){
        await sendText(from,"🧾 *Genial!* Para cotizar el despacho decime:\n• Tipo de mercadería\n• HS Code (si lo tenés)\n• Valor FOB\n• País de origen\n• Importador/Exportador");
        return res.sendStatus(200);
      }
      if (id==="desp_no"){
        await sendText(from,"¡Gracias por tu consulta! 🙌 Cualquier cosa, escribinos cuando quieras.\n📧 comercial@conektarsa.com");
        sessions.delete(from);
        return res.sendStatus(200);
      }
    }

    // ======= TEXTO =======
    if (type==="text") {
      // inicio directo
      if (s.step==="start"){ await sendHome(from); return res.sendStatus(200); }

      // empresa
      if (s.step==="empresa"){
        s.data.empresa = bodyTxt;

        if (s.data.modo==="maritimo"){
          s.step="maritimo_modalidad";
          await sendButtons(from,"🚢 *Marítimo seleccionado.* Elegí modalidad:",[
            { id:"mar_LCL", title:"LCL" },
            { id:"mar_FCL", title:"FCL" },
            { id:"mar_volver", title:"Volver" }
          ]);
          return res.sendStatus(200);
        }
        if (s.data.modo==="aereo"){
          s.step="aereo_subtipo";
          await sendButtons(from,"✈️ ¿Qué necesitás cotizar?",[
            { id:"aer_carga", title:"Carga general" },
            { id:"aer_courier", title:"Courier" },
            { id:"aer_volver", title:"Volver" }
          ]);
          return res.sendStatus(200);
        }
        if (s.data.modo==="terrestre"){
          s.step="terrestre_tipo";
          await sendButtons(from,"🚛 *Terrestre:*",[
            { id:"ter_LTL", title:"LTL" },
            { id:"ter_FTL", title:"FTL" },
            { id:"ter_volver", title:"Volver" }
          ]);
          return res.sendStatus(200);
        }
      }

      // MARÍTIMO
      if (s.step==="mar_origen"){
        s.data.origen_puerto = bodyTxt;
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // AÉREO CARGA GENERAL
      if (s.step==="aer_origen"){
        s.data.origen_aeropuerto = bodyTxt;
        s.step="aer_peso";
        await sendText(from,"⚖️ *Peso (kg)* (entero).");
        return res.sendStatus(200);
      }
      if (s.step==="aer_peso"){
        s.data.peso_kg = Math.max(0, Math.round(toNum(bodyTxt)));
        s.step="aer_vol";
        await sendText(from,"📦 *Peso volumétrico (kg)* (opcional, poné 0 si no sabés).");
        return res.sendStatus(200);
      }
      if (s.step==="aer_vol"){
        s.data.vol_cbm = Math.max(0, toNum(bodyTxt));
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // COURIER
      if (s.step==="courier_origen"){
        s.data.origen_aeropuerto = bodyTxt; // ciudad/país origen
        s.step="courier_peso";
        await sendText(from,"⚖️ *Peso (kg)* (podés usar decimales: 1.5, 2, 2.5...).");
        return res.sendStatus(200);
      }
      if (s.step==="courier_peso"){
        s.data.peso_kg = toNum(bodyTxt);
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // TERRESTRE
      if (s.step==="ter_origen"){
        s.data.origen_direccion = bodyTxt;
        await askResumen(from, s.data);
        return res.sendStatus(200);
      }

      // CONFIRMADO → COTIZAR
      if (s.step==="cotizar"){
        // ignorar texto, seguimos a cotizar (por si usuario escribe algo)
      }
    }

    /* ======= EJECUTAR COTIZACIÓN AL CONFIRMAR ======= */
    if (s.step==="cotizar"){
      try{
        let resp="", total=0;

        if (s.data.modo==="aereo" && s.data.aereo_tipo==="carga_general"){
          const r = await cotizarAereo({ origen: s.data.origen_aeropuerto, kg: s.data.peso_kg||0, vol: s.data.vol_cbm||0 });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Aéreos*. Probá con ciudad o IATA (PVG, PEK, NRT)."); return res.sendStatus(200); }
          total = r.totalUSD;
          const unit = `USD ${fmt(r.pricePerKg)} por KG (FOB)`;
          const min = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
          resp =
`✅ *Tarifa estimada (Aéreo – Carga general)*
${unit} + *Gastos Locales*.${min}

*Kilos facturables:* ${r.facturableKg}
*Total estimado:* USD ${fmt(r.totalUSD)}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);

          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","aereo", s.data.origen_aeropuerto, r.destino, s.data.peso_kg||"", s.data.vol_cbm||"", "", r.totalUSD, `Aéreo ${s.data.origen_aeropuerto}→${r.destino}; unit:${fmt(r.pricePerKg)}; fact:${r.facturableKg}kg; min:${r.minKg}`]);
        }

        else if (s.data.modo==="aereo" && s.data.aereo_tipo==="courier"){
          const r = await cotizarCourier({ pais: s.data.origen_aeropuerto, kg: s.data.peso_kg||0 });
          if (!r){ await sendText(from,"❌ No pude calcular *Courier*. Revisá la pestaña."); return res.sendStatus(200); }
          total = r.totalUSD;
          const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg.` : "";
          resp =
`✅ *Tarifa estimada (Courier ${s.data.courier_persona||""})*
*Peso:* ${fmt(s.data.peso_kg)} kg${nota}
*Total:* USD ${fmt(r.totalUSD)} + *Gastos Locales*

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);

          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","courier", s.data.origen_aeropuerto, r.destino, s.data.peso_kg||"", "", "", r.totalUSD, `Courier ${s.data.origen_aeropuerto}(${r.region})→${r.destino}; escalon:${r.escalonKg}`]);
        }

        else if (s.data.modo==="maritimo"){
          const modalidad = s.data.maritimo_tipo==="FCL" ? (s.data.contenedor?`FCL${s.data.contenedor}`:"FCL") : "LCL";
          const r = await cotizarMaritimo({ origen: s.data.origen_puerto, modalidad });
          if (!r){ await sendText(from,"❌ No encontré esa ruta/modalidad en *Marítimos*. Usá el nombre tal cual figura."); return res.sendStatus(200); }
          total = r.totalUSD;
          const notaLCL = modalidad==="LCL" ? "\nNota: *LCL según valor de planilla; no se prorratea por m³*" : "";
          resp =
`✅ *Tarifa estimada (Marítimo ${modalidad})*
USD ${fmt(r.totalUSD)} *todo-in freight* + *Gastos Locales*.${notaLCL}

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);

          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","maritimo", s.data.origen_puerto, r.destino, "", "", modalidad, r.totalUSD, `Marítimo ${modalidad} ${s.data.origen_puerto}→${r.destino}`]);
        }

        else if (s.data.modo==="terrestre"){
          const r = await cotizarTerrestre({ origen: s.data.origen_direccion || "" });
          if (!r){ await sendText(from,"❌ No encontré esa ruta en *Terrestres*. Usá el nombre tal cual figura."); return res.sendStatus(200); }
          total = r.totalUSD;
          resp =
`✅ *Tarifa estimada (Terrestre ${s.data.terrestre_tipo||""})*
USD ${fmt(r.totalUSD)} + *Gastos Locales*.

*Validez:* ${VALIDEZ_DIAS} días
*Nota:* No incluye impuestos ni gastos locales.`;
          await sendText(from, resp);

          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","terrestre", s.data.origen_direccion||"", r.destino, "", "", s.data.terrestre_tipo||"", r.totalUSD, `Terrestre ${s.data.origen_direccion}→${r.destino}`]);
        }

        await sendText(from,"✨ *Tu consulta ha sido registrada correctamente.*\nNuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n📧 comercial@conektarsa.com");
        await upsellDespacho(from);
        sessions.delete(from);
      } catch(e){
        console.error("cotizar error", e);
        await sendText(from,"⚠️ Tuvimos un problema al leer la planilla. Revisá nombres de pestañas y permisos.");
      }
      return res.sendStatus(200);
    }

    // fallback
    await sendHome(from);
    return res.sendStatus(200);
  }catch(e){
    console.error("webhook error", e);
    return res.sendStatus(200);
  }
});

/* ====== Salud ====== */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador de Fletes ✅"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

app.listen(PORT, ()=> console.log(`🚀 Bot en http://localhost:${PORT}`));
