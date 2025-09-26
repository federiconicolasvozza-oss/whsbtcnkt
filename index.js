// index.js — Bot Cotizador de Fletes (Conektar S.A.)
// Lee tarifas desde Google Sheets (Aereos / Maritimos / Terrestres / Courier)
// Registra cada consulta en la hoja "Solicitudes"
// WhatsApp Cloud API + Express
//
// Requisitos de entorno (ver .env):
// - PORT, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, API_VERSION
// - GOOGLE_TARIFFS_SHEET_ID (+ tabs Aereos/Maritimos/Terrestres/Courier)
// - GOOGLE_LOG_SHEET_ID, GOOGLE_LOG_TAB=Solicitudes
// - AEREO_MIN_KG=100, VALIDEZ_DIAS=7
//
// Credenciales Google: oauth_client.json y oauth_token.json en /etc/secrets o ./credentials

const express = require("express");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

dotenv.config();
const app = express();
app.use(express.json({ limit: "15mb" }));

/* ====== ENV ====== */
const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.API_VERSION || "v23.0";
const VERIFY_TOKEN = String(process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = String(process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = String(process.env.PHONE_NUMBER_ID || "").trim();

const TAR_SHEET_ID = String(process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AER = String(process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MAR = String(process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TER = String(process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COU = String(process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();

const LOG_SHEET_ID = String(process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const LOG_TAB = String(process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();

const AEREO_MIN_KG = Number(process.env.AEREO_MIN_KG ?? 100);
const VALIDEZ_DIAS = Number(process.env.VALIDEZ_DIAS ?? 7);

/* ====== Google OAuth ====== */
function credPath(file) {
  const p1 = path.join("/etc/secrets", file);
  try { fs.accessSync(p1); return p1; } catch {}
  const p2 = path.join(process.cwd(), "credentials", file);
  return p2;
}
const CLIENT_PATH = credPath("oauth_client.json");
const TOKEN_PATH  = credPath("oauth_token.json");

function getOAuth() {
  const missing = [];
  try { fs.accessSync(CLIENT_PATH);} catch { missing.push("oauth_client.json"); }
  try { fs.accessSync(TOKEN_PATH);}  catch { missing.push("oauth_token.json"); }
  if (missing.length) throw new Error("Faltan credenciales Google: " + missing.join(", "));
  const rawClient = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const installed = rawClient.installed || rawClient.web || rawClient;
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  const o = new google.auth.OAuth2(installed.client_id, installed.client_secret, installed.redirect_uris?.[0]);
  o.setCredentials(tokens);
  return o;
}
function sheetsClient() {
  return google.sheets({ version: "v4", auth: getOAuth() });
}

/* ====== Utils ====== */
const norm = s => (s || "").toString().toLowerCase()
  .normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/\s+/g," ").trim();

const toNum = s => {
  if (typeof s === "number") return s;
  const m = String(s||"").replace(/\./g,"").replace(/,/g,".")
    .match(/-?\d+(\.\d+)?/);
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

/* ====== Sesiones ====== */
const sessions = new Map(); // wa_id -> {step, data:{}}
const getS = id => (sessions.get(id) || (sessions.set(id,{step:"start", data:{}}), sessions.get(id)));

/* ====== Lectura y Log en Sheets ====== */
async function readRange(sheetId, a1) {
  const sheets = sheetsClient();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: a1 });
  return r.data.values || [];
}
async function logSolicitud(values) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: LOG_SHEET_ID,
    range: `${LOG_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

/* ====== COUNTRY → REGION (Courier) ====== */
const COUNTRY_TO_REGION = {
  // América Sur
  "argentina":"america sur","brasil":"america sur","chile":"america sur","uruguay":"america sur","paraguay":"america sur","bolivia":"america sur","peru":"america sur","colombia":"america sur","ecuador":"america sur","venezuela":"america sur",
  // USA & Canadá
  "estados unidos":"usa & canadá","usa":"usa & canadá","eeuu":"usa & canadá","united states":"usa & canadá","canada":"usa & canadá","canadá":"usa & canadá",
  // Europa
  "españa":"europa","portugal":"europa","francia":"europa","alemania":"europa","italia":"europa","paises bajos":"europa","reino unido":"europa","uk":"europa","holanda":"europa","belgica":"europa","suiza":"europa","suecia":"europa","noruega":"europa","dinamarca":"europa","irlanda":"europa","polonia":"europa","chequia":"europa","austria":"europa",
  // Asia / ME
  "china":"asia","hong kong":"asia","india":"asia","japon":"asia","japón":"asia","corea":"asia","singapur":"asia","tailandia":"asia","vietnam":"asia","malasia":"asia","indonesia":"asia","emiratos arabes":"asia","emiratos árabes":"asia","arabia saudita":"asia","qatar":"asia","turquia":"asia","turquía":"asia"
};

/* ====== COTIZADORES ====== */

// AÉREO — Precio Medio USD/kg, mínimo 100 kg, facturable por mayor entre kg y volumétrico
async function cotizarAereo({ origen, kg, vol }) {
  const rows = await readRange(TAR_SHEET_ID, `${TAB_AER}!A1:H10000`);
  if (!rows.length) throw new Error("Aereos vacío");
  const header = rows[0], data = rows.slice(1);

  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");
  const iMinKg  = headerIndex(header,"minimo en kg","mínimo en kg");

  const row = data.find(r => norm(r[iOrigen]) === norm(origen) && norm(r[iDest]).includes("eze"));
  if (!row) return null;

  const pricePerKg = toNum(row[iPrecio]);
  const minKg = toNum(row[iMinKg]) || AEREO_MIN_KG;
  const fact = Math.max(chargeable(kg, vol), 1);
  const applyMin = fact < minKg;
  const facturable = applyMin ? minKg : fact;

  return {
    pricePerKg,
    minKg,
    facturableKg: facturable,
    applyMin,
    totalUSD: pricePerKg * facturable,
    destino: "Buenos Aires (EZE)"
  };
}

// MARÍTIMO — Usa Modalidad + Precio Medio (todo-in). LCL sin prorrateo por m³
async function cotizarMaritimo({ origen, modalidad }) {
  const rows = await readRange(TAR_SHEET_ID, `${TAB_MAR}!A1:H10000`);
  if (!rows.length) throw new Error("Maritimos vacío");
  const header = rows[0], data = rows.slice(1);

  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iMod    = headerIndex(header,"modalidad");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");

  const row = data.find(r =>
    norm(r[iDest]).includes("buenos aires") &&
    norm(r[iOrigen]) === norm(origen) &&
    norm(r[iMod]) === norm(modalidad)
  );
  if (!row) return null;
  return { modalidad, totalUSD: toNum(row[iPrecio]), destino: "Puerto de Buenos Aires" };
}

// TERRESTRE — Precio Medio tal cual
async function cotizarTerrestre({ origen }) {
  const rows = await readRange(TAR_SHEET_ID, `${TAB_TER}!A1:H10000`);
  if (!rows.length) throw new Error("Terrestres vacío");
  const header = rows[0], data = rows.slice(1);

  const iOrigen = headerIndex(header,"origen");
  const iDest   = headerIndex(header,"destino");
  const iPrecio = headerIndex(header,"precio medio","precio usd medio","precio");

  const row = data.find(r => norm(r[iDest]).includes("buenos aires") && norm(r[iOrigen]) === norm(origen));
  if (!row) return null;
  return { totalUSD: toNum(row[iPrecio]), destino: "Buenos Aires" };
}

// COURIER — Usa peso informado; si no hay exacto, toma el más cercano y lo avisa
async function cotizarCourier({ pais, kg }) {
  const rows = await readRange(TAR_SHEET_ID, `${TAB_COU}!A1:Z10000`);
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
  let usado = wanted;
  let ajustado = false;

  if (!exact) {
    let best = null, bestDiff = Infinity;
    for (const r of data) {
      const p = toNum(r[iPeso]); const d = Math.abs(p - wanted);
      if (d < bestDiff) { best = r; bestDiff = d; }
    }
    exact = best; usado = toNum(best[iPeso]); ajustado = true;
  }

  return {
    region,
    escalonKg: usado,
    ajustado,
    totalUSD: toNum(exact[col]),
    destino: "Buenos Aires (EZE)"
  };
}

/* ====== UI ====== */
async function sendHome(to) {
  return sendButtons(
    to,
    "👋 *Bienvenido al Cotizador de Fletes de Conektar S.A.*\nElegí el tipo de flete:",
    [
      { id:"menu_maritimo", title:"🚢 Marítimo" },
      { id:"menu_aereo",    title:"✈️ Aéreo" },
      { id:"menu_terrestre",title:"🚛 Terrestre" },
      { id:"menu_courier",  title:"📦 Courier" }
    ]
  );
}

/* ====== WEBHOOK VERIFY ====== */
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ====== WEBHOOK EVENTS ====== */
app.post("/webhook", async (req,res)=>{
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const s = getS(from);

    const type = msg.type;
    const bodyTxt = type==="text" ? (msg.text?.body || "").trim() : "";
    const lower = norm(bodyTxt);

    // Comandos globales
    if (type==="text" && ["hola","menu","inicio","volver","start"].includes(lower)) {
      sessions.delete(from); await sendHome(from); return res.sendStatus(200);
    }

    // INTERACTIVE
    if (type === "interactive") {
      const id = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;

      if (id?.startsWith("menu_")) {
        s.data.tipo = id.replace("menu_","");
        s.step = "empresa";
        await sendText(from, "🏢 *Decime tu empresa* (ej.: Importodo SRL).");
        return res.sendStatus(200);
      }

      if (id?.startsWith("mar_")) {
        s.data.modalidad = id.replace("mar_","").toUpperCase(); // FCL20/FCL40/FCL40HC/LCL
        s.step = "origen";
        await sendText(from, "📍 *Origen* (puerto de salida, ej.: Shanghai / Ningbo / Shenzhen).");
        return res.sendStatus(200);
      }

      if (id === "aer_carga") { s.data.subtipo="carga"; s.step="origen"; await sendText(from,"✈️ Origen (aeropuerto, ej.: Shanghai (PVG), Guangzhou (CAN))."); return res.sendStatus(200); }
      if (id === "aer_courier") { s.data.subtipo="courier"; s.step="pais"; await sendText(from,"🌍 *País de origen* (ej.: España, China, Estados Unidos)."); return res.sendStatus(200); }

      return res.sendStatus(200);
    }

    // TEXTO
    if (type === "text") {
      if (s.step === "start") { await sendHome(from); return res.sendStatus(200); }

      if (s.step === "empresa") {
        s.data.empresa = bodyTxt;
        // branch según tipo
        if (s.data.tipo === "maritimo") {
          s.step = "maritimo_modalidad";
          await sendButtons(from, "🚢 Marítimo seleccionado. Elegí modalidad:", [
            { id:"mar_FCL20", title:"FCL20" }, { id:"mar_FCL40", title:"FCL40" }, { id:"mar_FCL40HC", title:"FCL40HC" },
            { id:"mar_LCL", title:"LCL" }
          ]);
          return res.sendStatus(200);
        }
        if (s.data.tipo === "aereo") {
          s.step = "aereo_subtipo";
          await sendButtons(from, "✈️ ¿Qué necesitás cotizar?", [
            { id:"aer_carga", title:"Carga general" }, { id:"aer_courier", title:"Courier" }
          ]);
          return res.sendStatus(200);
        }
        if (s.data.tipo === "terrestre") {
          s.step = "origen";
          await sendText(from,"🚛 *Origen* (ciudad/país, ej.: San Pablo – Brasil, Curitiba – Brasil).");
          return res.sendStatus(200);
        }
        if (s.data.tipo === "courier") {
          s.data.subtipo="courier"; s.step="pais";
          await sendText(from,"🌍 *País de origen* (ej.: España, China, Estados Unidos).");
          return res.sendStatus(200);
        }
      }

      if (s.step === "origen") {
        s.data.origen = bodyTxt;

        if (s.data.tipo === "aereo" && s.data.subtipo==="carga") {
          s.step = "peso";
          await sendText(from,"⚖️ *Peso (kg)* (entero).");
          return res.sendStatus(200);
        }
        if (s.data.tipo === "maritimo") {
          const r = await cotizarMaritimo({ origen: s.data.origen, modalidad: s.data.modalidad });
          if (!r) { await sendText(from,"❌ No encontré esa ruta/modalidad en tu planilla. Probá con el nombre tal como figura en la pestaña *Maritimos*."); return res.sendStatus(200); }
          const aclaracion = " + gastos locales en BUE";
          const extra = s.data.modalidad === "LCL" ? "\nNota: *LCL según valor de planilla; no se prorratea por m³*" : "";
          const resp =
`🚢 *Marítimo ${s.data.modalidad}*
Origen: *${s.data.origen}* → Destino: *${r.destino}*
*Total estimado:* USD ${fmt(r.totalUSD)}${aclaracion}${extra}

Validez: ${VALIDEZ_DIAS} días.
¿Cotizamos también *despacho aduanero*?`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","maritimo", s.data.origen, r.destino, "", "", s.data.modalidad, r.totalUSD, `Resumen: Marítimo ${s.data.modalidad} ${s.data.origen}→${r.destino}`]);
          sessions.delete(from);
          return res.sendStatus(200);
        }

        if (s.data.tipo === "terrestre") {
          const r = await cotizarTerrestre({ origen: s.data.origen });
          if (!r) { await sendText(from,"❌ No encontré esa ruta en *Terrestres*. Probá exactamente como figura en la planilla."); return res.sendStatus(200); }
          const resp =
`🚛 *Terrestre*
Origen: *${s.data.origen}* → Destino: *${r.destino}*
*Total estimado:* USD ${fmt(r.totalUSD)} + gastos locales en BUE

Validez: ${VALIDEZ_DIAS} días.`;
          await sendText(from, resp);
          await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","terrestre", s.data.origen, r.destino, "", "", "", r.totalUSD, `Resumen: Terrestre ${s.data.origen}→${r.destino}`]);
          sessions.delete(from);
          return res.sendStatus(200);
        }

        return res.sendStatus(200);
      }

      if (s.step === "peso") {
        const kg = Math.max(0, Math.round(toNum(bodyTxt)));
        s.data.kg = kg;
        s.step = "peso_vol";
        await sendText(from,"📦 *Peso volumétrico (kg)* (opcional, poné 0 si no sabés).");
        return res.sendStatus(200);
      }

      if (s.step === "peso_vol") {
        s.data.vol = Math.max(0, toNum(bodyTxt));

        const r = await cotizarAereo({ origen: s.data.origen, kg: s.data.kg, vol: s.data.vol || 0 });
        if (!r) { await sendText(from,"❌ No encontré esa ruta en *Aereos*. Usá el nombre tal cual está (ej.: “Shanghai (PVG)”)."); return res.sendStatus(200); }

        const lineMin = r.applyMin ? `\n*Mínimo facturable:* ${r.minKg} kg` : "";
        const aclaracion = " + gastos locales en BUE";
        const resp =
`✈️ *Aéreo – Carga general*
Origen: *${s.data.origen}* → Destino: *${r.destino}*
Tarifa: USD ${fmt(r.pricePerKg)} / kg${lineMin}
Kilos facturables: *${r.facturableKg}*
*Total estimado:* USD ${fmt(r.totalUSD)}${aclaracion}

Validez: ${VALIDEZ_DIAS} días.
¿Querés que coticemos también el *despacho aduanero*?`;
        await sendText(from, resp);
        await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","aereo", s.data.origen, r.destino, s.data.kg, s.data.vol||"", "", r.totalUSD, `Resumen: Aéreo ${s.data.origen}→${r.destino}; unit:${fmt(r.pricePerKg)}; fact:${r.facturableKg}kg; min:${r.minKg}`]);
        sessions.delete(from);
        return res.sendStatus(200);
      }

      if (s.step === "pais") {
        s.data.pais = bodyTxt;
        s.step = "peso_courier";
        await sendText(from,"⚖️ *Peso (kg)* (podés poner decimales: 1.5, 2, 2.5, etc.)");
        return res.sendStatus(200);
      }

      if (s.step === "peso_courier") {
        const kg = toNum(bodyTxt);
        s.data.kg = kg;
        const r = await cotizarCourier({ pais: s.data.pais, kg });
        if (!r) { await sendText(from,"❌ No pude calcular courier. Revisá la pestaña *Courier*."); return res.sendStatus(200); }
        const nota = r.ajustado ? `\n*Nota:* ajustado al escalón de ${r.escalonKg} kg de la tabla.` : "";
        const resp =
`📦 *Courier*
Origen: *${s.data.pais}* (${r.region}) → Destino: *${r.destino}*
Peso: ${fmt(s.data.kg)} kg${nota}
*Total estimado:* USD ${fmt(r.totalUSD)} + gastos locales en BUE

Validez: ${VALIDEZ_DIAS} días.`;
        await sendText(from, resp);
        await logSolicitud([new Date().toISOString(), from, "", s.data.empresa, "whatsapp","courier", s.data.pais, r.destino, s.data.kg, "", "", r.totalUSD, `Resumen: Courier ${s.data.pais}(${r.region})→${r.destino}; escalon:${r.escalonKg}`]);
        sessions.delete(from);
        return res.sendStatus(200);
      }

      // fallback
      await sendHome(from);
      return res.sendStatus(200);
    }

    await sendText(from,"Escribí *inicio* para comenzar.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("webhook error", e);
    return res.sendStatus(200);
  }
});

/* ====== Salud ====== */
app.get("/", (_req,res)=>res.status(200).send("Conektar - Bot Cotizador de Fletes ✅"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

app.listen(PORT, ()=> {
  console.log(`🚀 Bot en http://localhost:${PORT}`);
});
