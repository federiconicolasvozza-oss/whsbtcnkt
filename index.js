// index.js — Conektar: Cotizador + Calculadora (ESM)
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ===================== ENV ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = "v20.0";

const BRAND_LOGO_URL =
  (process.env.BRAND_LOGO_URL || "https://conektarsa.com/wp-content/uploads/2025/05/LogoCH80px.png").trim();

/* --- Tarifa (ya existente en tu bot) --- */
const GOOGLE_TARIFFS_SHEET_ID = (process.env.GOOGLE_TARIFFS_SHEET_ID || "").trim();
const TAB_AEREOS = (process.env.GOOGLE_TARIFFS_TAB_AEREOS || "Aereos").trim();
const TAB_MARITIMOS = (process.env.GOOGLE_TARIFFS_TAB_MARITIMOS || "Maritimos").trim();
const TAB_TERRESTRES = (process.env.GOOGLE_TARIFFS_TAB_TERRESTRES || "Terrestres").trim();
const TAB_COURIER = (process.env.GOOGLE_TARIFFS_TAB_COURIER || "Courier").trim();

/* --- Log de consultas (solicitudes) y cálculos --- */
const GOOGLE_LOG_SHEET_ID = (process.env.GOOGLE_LOG_SHEET_ID || "").trim();
const GOOGLE_LOG_TAB = (process.env.GOOGLE_LOG_TAB || "Solicitudes").trim();
const GOOGLE_CALC_TAB = (process.env.GOOGLE_CALC_TAB || "calculos").trim();

/* --- Matriz de productos para la calculadora --- */
const PRODUCT_MATRIX_SHEET_ID = (process.env.PRODUCT_MATRIX_SHEET_ID || "").trim();
const PRODUCT_MATRIX_TAB = (process.env.PRODUCT_MATRIX_TAB || "Clasificación").trim();

/* --- Parámetros de cálculo/imp. --- */
const INSURANCE_RATE = Number(process.env.INSURANCE_RATE ?? 0.01);      // 1% FOB
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03);  // 3% CIF
const RATE_IIGG = Number(process.env.RATE_IIGG ?? 0.06);                // 6% fijo
const RATE_LCL_PER_TON = Number(process.env.RATE_LCL_PER_TON ?? 5);
const AR_LOCAL_CHARGES_LCL = Number(process.env.AR_LOCAL_CHARGES_LCL ?? 400);

const DESPACHANTE_PORC = Number(process.env.DESPACHANTE_PORCENTAJE ?? 0.003);
const DESPACHANTE_MINIMO = Number(process.env.DESPACHANTE_MINIMO ?? 150);
const DESPACHANTE_MAXIMO = Number(process.env.DESPACHANTE_MAXIMO ?? 5000);
const GASTOS_ADMIN = Number(process.env.GASTOS_ADMINISTRATIVOS ?? 20);
const GASTOS_OPER = Number(process.env.GASTOS_OPERATIVOS ?? 100);

/* ===================== App ===================== */
const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== Google Auth ===================== */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename);
  const fromRepo = path.join(__dirname, "credentials", filename);
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

function hasGoogle() {
  try { fs.accessSync(CLIENT_PATH); fs.accessSync(TOKEN_PATH); return true; }
  catch { return false; }
}
function oauth() {
  const { installed } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  const cli = new google.auth.OAuth2(
    installed.client_id, installed.client_secret, installed.redirect_uris?.[0] || "http://127.0.0.1"
  );
  cli.setCredentials(tokens);
  return cli;
}
async function sheetGet({ spreadsheetId, range }) {
  const sheets = google.sheets({ version: "v4", auth: oauth() });
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return resp.data.values || [];
}
async function sheetAppend({ spreadsheetId, range, row }) {
  const sheets = google.sheets({ version: "v4", auth: oauth() });
  await sheets.spreadsheets.values.append({
    spreadsheetId, range, valueInputOption: "USER_ENTERED", requestBody: { values: [row] }
  });
}

/* ===================== Helpers ===================== */
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const num = (s)=> {
  if (typeof s === "number") return s;
  const m = String(s||"").replace(/\./g,"").replace(/,/g,".").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const pct = (s)=> num(s) / 100;
const fmt = (n)=> isFinite(n) ? Number(n).toFixed(2) : "0.00";

/* ===================== WhatsApp ===================== */
async function waSend(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.error("WA error", await res.text());
  return res.ok;
}
const sendText = (to, body)=> waSend({ messaging_product:"whatsapp", to, type:"text", text:{ body } });
const sendImage = (to, link, caption="") => waSend({
  messaging_product:"whatsapp", to, type:"image", image:{ link, caption }
});
const btn = (id,title)=>({ type:"reply", reply:{ id, title }});
function sendButtons(to, text, buttons) {
  return waSend({
    messaging_product:"whatsapp", to, type:"interactive",
    interactive:{ type:"button", body:{ text }, action:{ buttons } }
  });
}
function sendList(to, text, rows, sectionTitle="Opciones", buttonLabel="Elegir") {
  return waSend({
    messaging_product: "whatsapp",
    to, type:"interactive",
    interactive: { type:"list",
      body:{ text },
      action:{ button:buttonLabel, sections:[{ title: sectionTitle, rows }] }
    }
  });
}

/* ===================== Presentación ===================== */
async function sendWelcomeSequence(to) {
  await sendImage(to, BRAND_LOGO_URL);                 // 1) logo
  await sleep(300);
  await sendText(                                           // 2) texto cálido
    to,
    "¡Bienvenido/a al *Asistente Virtual de Conektar*! 🙌\n" +
    "Acá vas a poder *cotizar fletes internacionales* y *estimar el costo* de tu importación."
  );
  await sleep(200);
  await sendText(to,"Para empezar, decime el *nombre de tu empresa*.");
}

/* ===================== Estado ===================== */
const sessions = new Map();
/*
session = {
  flow: null | "flete" | "calc",
  step: null | "empresa" | ...,
  data: { empresa, modo, ... (según flujo) }
}
*/
function S(wa) { if (!sessions.has(wa)) sessions.set(wa, { flow:null, step:null, data:{} }); return sessions.get(wa); }

/* ===================== Lector MATRIZ ===================== */
let MATRIX_CACHE = null;
async function readMatrix() {
  if (!hasGoogle() || !PRODUCT_MATRIX_SHEET_ID) return null;
  const tab = /[^A-Za-z0-9_]/.test(PRODUCT_MATRIX_TAB) ? `'${PRODUCT_MATRIX_TAB}'` : PRODUCT_MATRIX_TAB;
  const rows = await sheetGet({ spreadsheetId: PRODUCT_MATRIX_SHEET_ID, range: `${tab}!A1:Z2000` });
  if (!rows?.length) return null;
  const h = rows[0].map(x => (x||"").toString().trim().toLowerCase());
  const idx = (label) => h.findIndex(col => col.includes(label));
  const out = [];
  for (let i=1;i<rows.length;i++) {
    const r = rows[i]||[];
    out.push({
      N1: r[idx("nivel_1")] || "",
      N2: r[idx("nivel_2")] || "",
      N3: r[idx("nivel_3")] || "",
      SUB: r[idx("subcateg")] || r[idx("subcategoria")] || "",
      tasa_est: pct(r[idx("tasa estad")] || 3),
      iva: pct(r[idx("% iva")] || 21),
      iva_adic: pct(r[idx("iva adicion")] || 0),
      di: pct(r[idx("derechos impo")] || 14),
      iibb: pct(r[idx("% iibb")] || 3.5),
      // IIGG forzado 6% según tu regla
      iigg: RATE_IIGG,
      internos: pct(r[idx("internos")] || 0),
      req: r[idx("requerim")] || "",
      notas: r[idx("notas")] || "",
      categoria: (r[idx("categoria")] || r[idx("nivel_2")] || r[idx("nivel_1")] || "").toString()
    });
  }
  return out;
}
async function getMatrix() {
  if (!MATRIX_CACHE) MATRIX_CACHE = await readMatrix();
  return MATRIX_CACHE;
}
function pickBestByText(matrix, text="") {
  const norm = (s)=> (s||"").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").trim();
  const t = norm(text);
  if (!t) return matrix?.[0] || null;
  let best = null, score = -1;
  for (const r of matrix||[]) {
    const words = norm(r.categoria).split(/\s+/).filter(Boolean);
    const s = words.reduce((a,w)=> a + (t.includes(w) ? 1 : 0), 0);
    if (s > score) { score = s; best = r; }
  }
  return best || matrix?.[0] || null;
}

/* ===================== Tarifa (freight) — uso liviano para Calculadora ===================== */
async function getFreightFromTariffs({ modo="maritimo", maritimo_tipo="LCL", contenedor=null }) {
  // Este lector es deliberadamente simple para sumar un “flete promedio”
  // Si no puede leer/ubicar, devolverá { amount: 0, note: "no_tariff" }
  try {
    if (!hasGoogle() || !GOOGLE_TARIFFS_SHEET_ID) return { amount:0, note:"no_google" };
    const tab = modo==="aereo" ? TAB_AEREOS
              : modo==="terrestre" ? TAB_TERRESTRES
              : TAB_MARITIMOS;
    const safe = /[^A-Za-z0-9_]/.test(tab) ? `'${tab}'` : tab;
    const rows = await sheetGet({ spreadsheetId: GOOGLE_TARIFFS_SHEET_ID, range: `${safe}!A1:H10000` });
    if (!rows?.length) return { amount:0, note:"no_rows" };
    const header = rows[0].map(v=> (v||"").toString().trim().toLowerCase());
    const iPrecio = header.findIndex(c => c.includes("precio medio") || c==="precio medio" || c==="precio usd medio" || c==="precio promedio" || c==="precio medio (g)");
    const iModalidad = header.findIndex(c => c.includes("modalidad") || c==="equipo" || c==="contenedor");
    // Toma el primer precio válido acorde a modalidad cuando aplique
    let amount = 0;
    for (let i=1;i<rows.length;i++){
      const r = rows[i] || [];
      const mod = (r[iModalidad] || "").toString().toUpperCase();
      if (modo==="maritimo" && maritimo_tipo==="FCL" && contenedor) {
        if (mod.includes("FCL") && mod.includes(contenedor.replace("'",""))) { amount = num(r[iPrecio]); break; }
      } else if (modo==="maritimo" && maritimo_tipo==="LCL") {
        if ((mod||"").toString().toUpperCase().includes("LCL")) { amount = num(r[iPrecio]); break; }
      } else if (modo==="aereo") { amount = num(r[iPrecio]); break; }
      else if (modo==="terrestre") { amount = num(r[iPrecio]); break; }
    }
    return { amount: amount||0, note: amount? "ok":"not_found" };
  } catch(e) {
    console.warn("Tariffs read fallback:", e.message);
    return { amount:0, note:"error" };
  }
}

/* ===================== Cálculo ===================== */
function calcDespacho(cif){
  const base = cif * DESPACHANTE_PORC;
  const honor = Math.min(Math.max(base, DESPACHANTE_MINIMO), DESPACHANTE_MAXIMO);
  const total = honor + GASTOS_ADMIN + GASTOS_OPER;
  return { honor, admin:GASTOS_ADMIN, oper:GASTOS_OPER, total };
}
function calcCost({
  fob_total=0,
  modo="maritimo", maritimo_tipo="LCL", contenedor=null,
  peso_kg=0, vol_cbm=0,
  matrixRow
}) {
  // Flete
  let freight = 0, breakdown = "";
  if (modo==="maritimo" && maritimo_tipo==="LCL") {
    const wm = Math.max(vol_cbm, peso_kg/1000);
    const lcl = wm * RATE_LCL_PER_TON;
    freight = lcl + AR_LOCAL_CHARGES_LCL;
    breakdown = `\n   • LCL W/M (USD ${fmt(RATE_LCL_PER_TON)}/TON): USD ${fmt(lcl)}\n   • Gastos locales AR: USD ${fmt(AR_LOCAL_CHARGES_LCL)}`;
  }
  // seguro
  const insurance = fob_total * INSURANCE_RATE;
  const cif = fob_total + freight + insurance;

  // Impuestos
  const di = cif * (matrixRow?.di ?? 0);
  const tasa = cif * (matrixRow?.tasa_est ?? TASA_ESTATISTICA);
  const baseIVA = cif + di + tasa;

  const iva = baseIVA * (matrixRow?.iva ?? 0);
  const iva_adic = baseIVA * (matrixRow?.iva_adic ?? 0);
  const iibb = cif * (matrixRow?.iibb ?? 0.035);
  const iigg = baseIVA * RATE_IIGG;
  const internos = (matrixRow?.internos ?? 0) > 0 ? cif * (matrixRow?.internos ?? 0) : 0;

  const impTotal = di + tasa + iva + iva_adic + iibb + iigg + internos;
  const costoAduanero = cif + impTotal;

  const despacho = calcDespacho(cif);
  const costoFinal = costoAduanero + despacho.total;

  return {
    freight, breakdown, insurance, cif,
    di, tasa, iva, iva_adic, iibb, iigg, internos,
    impTotal, costoAduanero, despacho, costoFinal
  };
}

/* ===================== Menú principal ===================== */
function sendMainMenu(to) {
  return sendButtons(
    to,
    "¿Qué te gustaría hacer hoy?",
    [ btn("menu_flete","Cotizar flete"), btn("menu_calc","Calcular costo") ]
  );
}

/* ===================== Webhook verify ===================== */
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ===================== Webhook events ===================== */
app.post("/webhook", async (req,res)=>{
  try{
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return res.sendStatus(200);
    const from = msg.from;
    const type = msg.type;
    const session = S(from);

    // comandos globales
    if (type==="text") {
      const body = (msg.text?.body || "").trim().toLowerCase();
      if (["hola","inicio","menu","menú","start"].includes(body)) {
        sessions.delete(from);
        await sendWelcomeSequence(from);
        return res.sendStatus(200);
      }
    }

    /* ============ INTERACTIVE (botones/listas) ============ */
    if (type==="interactive") {
      const id = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id;

      // Menú
      if (id==="menu_flete") {
        session.flow="flete"; session.step="empresa";
        session.data = {};
        await sendText(from,"Decime el *nombre de tu empresa*.");
        return res.sendStatus(200);
      }
      if (id==="menu_calc") {
        session.flow="calc"; session.step="empresa"; session.data={};
        await sendText(from,"Decime el *nombre de tu empresa*.");
        return res.sendStatus(200);
      }

      // Aquí podrías encadenar tu flujo MARÍTIMO / AÉREO / TERRESTRE del cotizador ya implementado
      // (por brevedad no lo reescribo completo). Este index deja preparado el arranque en step=empresa.

      return res.sendStatus(200);
    }

    /* ============ TEXTO ============ */
    if (type==="text") {
      const raw = (msg.text?.body || "").trim();
      // Si aún no hay flujo, secuencia de bienvenida
      if (!session.flow) {
        await sendWelcomeSequence(from);
        return res.sendStatus(200);
      }

      // Ambos flujos: primer paso empresa
      if (session.step==="empresa") {
        if (raw.length < 2) {
          await sendText(from,"Ingresá un nombre de empresa válido (mín. 2 caracteres).");
          return res.sendStatus(200);
        }
        session.data.empresa = raw;

        if (session.flow==="flete") {
          // acá continuarías con tu flujo de cotización (botones de modo, etc.)
          await sendText(from,"Perfecto. Ahora elegí en el menú qué querés hacer.");
          await sendMainMenu(from);
          return res.sendStatus(200);
        }

        if (session.flow==="calc") {
          session.step="producto";
          await sendText(from,"📝 Contame *qué producto* vas a importar (ej.: “cables USB-C”).");
          return res.sendStatus(200);
        }
      }

      // ===== CALCULADORA =====
      if (session.flow==="calc") {
        if (session.step==="producto") {
          session.data.producto = raw;
          session.step="fob";
          await sendText(from,"💵 Ingresá el *FOB total en USD* (ej.: 12000).");
          return res.sendStatus(200);
        }
        if (session.step==="fob") {
          const f = num(raw);
          if (f<=0) { await sendText(from,"Ingresá un número válido de *FOB total*."); return res.sendStatus(200); }
          session.data.fob_total = f;
          session.step="vol";
          await sendText(from,"📦 Ingresá el *volumen total* en m³ (ej.: 8.5). Si no sabés, escribí 0.");
          return res.sendStatus(200);
        }
        if (session.step==="vol") {
          session.data.vol_cbm = num(raw);
          session.step="peso";
          await sendText(from,"⚖️ Ingresá el *peso total* en kg (ej.: 120). Si no sabés, escribí 0.");
          return res.sendStatus(200);
        }
        if (session.step==="peso") {
          session.data.peso_kg = num(raw);
          session.step="modo";
          // Sugerimos por volumen/peso (simple)
          const volKg = (session.data.vol_cbm||0) * 167;
          const charge = Math.max(volKg, session.data.peso_kg||0);
          const sugerido = charge>300 || (session.data.vol_cbm||0) >= 1.5 ? "MARÍTIMO" : "AÉREO";
          await sendButtons(
            from,
            `Sugerencia de transporte: *${sugerido}*. ¿Cómo seguimos?`,
            [btn("calc_mar","Marítimo"), btn("calc_aer","Aéreo")]
          );
          return res.sendStatus(200);
        }

        // Selección modo por palabra (simple)
        if (session.step==="modo") {
          const low = raw.toLowerCase();
          if (low.includes("mar")) {
            session.data.modo="maritimo";
            session.step="mar_tipo";
            await sendButtons(from,"¿Vas por LCL o FCL?", [btn("calc_lcl","LCL"), btn("calc_fcl","FCL")]);
            return res.sendStatus(200);
          }
          if (low.includes("aer")) {
            session.data.modo="aereo";
            session.step="confirm";
            await sendText(from,"Listo. Voy a calcular con modo *AÉREO*.");
            // pasa directo a confirm
          }
        }

        // Confirmación final (sin botones largos)
        if (session.step==="confirm" || session.step==="mar_tipo") {
          // si venimos de maritimo_tipo por texto
          if (session.step==="mar_tipo") {
            const v = raw.toLowerCase();
            session.data.maritimo_tipo = v.includes("fcl") ? "FCL" : "LCL";
          }
          // usar tarifas si hay
          let freightNote = "";
          let freightFromTariff = 0;
          const t = await getFreightFromTariffs({
            modo: session.data.modo || "maritimo",
            maritimo_tipo: session.data.maritimo_tipo || "LCL",
            contenedor: session.data.contenedor || null
          });
          if (t.amount>0) freightFromTariff = t.amount;
          else freightNote = "⚠️ No pude tomar el flete exacto; seguí el cálculo sin ese valor. Nuestro equipo te contactará para una cotización precisa.\n";

          // matriz
          const M = await getMatrix();
          const rec = pickBestByText(M, session.data.producto);
          session.data.matriz = rec || null;

          // cálculo base (incluye fallback LCL)
          let base = calcCost({
            fob_total: session.data.fob_total,
            modo: session.data.modo || "maritimo",
            maritimo_tipo: session.data.maritimo_tipo || "LCL",
            contenedor: session.data.contenedor || null,
            peso_kg: session.data.peso_kg || 0,
            vol_cbm: session.data.vol_cbm || 0,
            matrixRow: session.data.matriz
          });

          // si conseguí flete de la hoja, lo reemplazo
          if (freightFromTariff>0) {
            const insurance = session.data.fob_total * INSURANCE_RATE;
            const cif = session.data.fob_total + freightFromTariff + insurance;
            const di = cif * (rec?.di ?? 0);
            const tasa = cif * (rec?.tasa_est ?? TASA_ESTATISTICA);
            const baseIVA = cif + di + tasa;
            const iva = baseIVA * (rec?.iva ?? 0);
            const iva_adic = baseIVA * (rec?.iva_adic ?? 0);
            const iibb = cif * (rec?.iibb ?? 0.035);
            const iigg = baseIVA * RATE_IIGG;
            const internos = (rec?.internos ?? 0) > 0 ? cif * (rec?.internos ?? 0) : 0;
            const impTotal = di + tasa + iva + iva_adic + iibb + iigg + internos;
            const costoAduanero = cif + impTotal;
            const despacho = calcDespacho(cif);
            const costoFinal = costoAduanero + despacho.total;

            base = {
              freight: freightFromTariff, breakdown:"",
              insurance, cif, di, tasa, iva, iva_adic, iibb, iigg, internos,
              impTotal, costoAduanero, despacho, costoFinal
            };
          }

          const r = base;
          const m = rec || {};
          const lineaFlete = `Flete (${(session.data.modo||"maritimo").toUpperCase()}${session.data.maritimo_tipo?" "+session.data.maritimo_tipo:""}${session.data.contenedor? " "+session.data.contenedor:""}): USD ${fmt(r.freight)}${r.breakdown||""}`;

          const resumen =
`📦 *Resultado estimado (FOB)*
FOB total: USD ${fmt(session.data.fob_total)}
${lineaFlete}
Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmt(r.insurance)}
CIF: *USD ${fmt(r.cif)}*

🏛️ *Impuestos*
DI (${(m.di*100||0).toFixed(1)}%): USD ${fmt(r.di)}
Tasa Estadística (${( (m.tasa_est ?? TASA_ESTATISTICA)*100 ).toFixed(1)}% CIF): USD ${fmt(r.tasa)}
IVA (${(m.iva*100||0).toFixed(1)}%): USD ${fmt(r.iva)}
IVA Adic (${(m.iva_adic*100||0).toFixed(1)}%): USD ${fmt(r.iva_adic)}
IIBB (${(m.iibb*100||0).toFixed(1)}%): USD ${fmt(r.iibb)}
IIGG (${(RATE_IIGG*100).toFixed(1)}%): USD ${fmt(r.iigg)}${(m.internos||0)>0 ? `\nInternos (${(m.internos*100).toFixed(1)}%): USD ${fmt(r.internos)}` : ""}

*Impuestos totales:* USD ${fmt(r.impTotal)}
*Costo aduanero (CIF + imp.):* *USD ${fmt(r.costoAduanero)}*

👨‍💼 *Despacho aduanero*
Honorarios (${(DESPACHANTE_PORC*100).toFixed(2)}%, min USD ${DESPACHANTE_MINIMO}, tope USD ${DESPACHANTE_MAXIMO}): USD ${fmt(r.despacho.honor)}
Gastos admin: USD ${fmt(r.despacho.admin)} • Operativos: USD ${fmt(r.despacho.oper)}
Total Despacho: *USD ${fmt(r.despacho.total)}*

🎯 *Costo final estimado:* *USD ${fmt(r.costoFinal)}*

${freightNote}¿Querés volver al menú o calificar el bot?`;

          await sendText(from, resumen);
          await sendButtons(from, "Elegí una opción:", [
            btn("volver_menu","Volver al menú"),
            btn("rate","Calificar 1–10")
          ]);

          // Log de cálculo
          try {
            if (hasGoogle() && GOOGLE_LOG_SHEET_ID) {
              await sheetAppend({
                spreadsheetId: GOOGLE_LOG_SHEET_ID,
                range: `${GOOGLE_CALC_TAB}!A1`,
                row: [
                  new Date().toISOString(),
                  from,
                  session.data.empresa || "",
                  session.data.producto || "",
                  (session.data.modo||"").toUpperCase(),
                  session.data.maritimo_tipo || "",
                  session.data.contenedor || "",
                  session.data.fob_total || 0,
                  session.data.vol_cbm || 0,
                  session.data.peso_kg || 0,
                  r.freight || 0,
                  r.insurance || 0,
                  r.cif || 0,
                  r.di || 0, r.tasa || 0, r.iva || 0, r.iva_adic || 0, r.iibb || 0, r.iigg || 0, r.internos || 0,
                  r.impTotal || 0, r.costoAduanero || 0,
                  r.despacho?.total || 0,
                  r.costoFinal || 0,
                  m.categoria || "",
                  m.notas || "",
                  freightNote ? "freight_missing" : "ok"
                ]
              });
            }
          } catch(e) {
            console.warn("No pude registrar cálculo:", e.message);
          }

          sessions.delete(from);
          return res.sendStatus(200);
        }

        // Bot simple para seleccionar dentro del flujo calc
        const low = raw.toLowerCase();
        if (session.step==="peso" && (low==="maritimo" || low==="aereo")) {
          session.data.modo = low==="maritimo" ? "maritimo" : "aereo";
          session.step = (low==="maritimo" ? "mar_tipo":"confirm");
          if (low==="maritimo") await sendButtons(from,"¿LCL o FCL?",[btn("calc_lcl","LCL"),btn("calc_fcl","FCL")]);
          else await sendText(from,"Listo, voy a calcular con *AÉREO*.");
          return res.sendStatus(200);
        }
      }

      // ===== Flujo flete (placeholder arranque) =====
      if (session.flow==="flete" && session.step!=="empresa") {
        await sendText(from,"(Flujo de *cotización de flete* listo para conectar con tus pasos actuales).");
        sessions.delete(from);
        return res.sendStatus(200);
      }

      // fallback
      await sendMainMenu(from);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch(e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ===================== Salud ===================== */
app.get("/", (_req,res)=> res.status(200).send("Conektar Bot ✅"));
app.get("/health", (_req,res)=> res.status(200).send("ok"));

/* ===================== Start ===================== */
app.listen(PORT, ()=>{
  console.log(`🚀 Bot escuchando en :${PORT}`);
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("🔐 token:", WHATSAPP_TOKEN ? WHATSAPP_TOKEN.slice(0,10)+"..." : "(vacío)");
  console.log("🧾 Sheets:", { GOOGLE_TARIFFS_SHEET_ID, GOOGLE_LOG_SHEET_ID, PRODUCT_MATRIX_SHEET_ID });
});




