// index.js - Calculadora de Costos Totales de Importación (basado en tu bot original)
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== ENV (misma base) ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = "v23.0";

const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "").trim();
const PRODUCT_MATRIX_TAB = (process.env.PRODUCT_MATRIX_TAB || "Hoja1").trim();

const TAB_CALCULOS = (process.env.TAB_CALCULOS || "Calculos").trim();

const INSURANCE_RATE = Number(process.env.INSURANCE_RATE ?? 0.01);       // 1% FOB
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0);      // 0..0.03

// Estimadores de flete (pueden tunearse por ENV)
const RATE_AIR_PER_KG   = Number(process.env.RATE_AIR_PER_KG   ?? 5.5);
const RATE_COURIER_PER_KG = Number(process.env.RATE_COURIER_PER_KG ?? 9.0);
const RATE_LCL_PER_CBM  = Number(process.env.RATE_LCL_PER_CBM  ?? 150);
const RATE_FCL_20       = Number(process.env.RATE_FCL_20       ?? 2100);
const RATE_FCL_40       = Number(process.env.RATE_FCL_40       ?? 3000);
const RATE_FCL_40HC     = Number(process.env.RATE_FCL_40HC     ?? 3250);

/* ========= Credenciales Google (misma base) ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename); // Render Secret Files
  const fromRepo    = path.join(process.cwd(), "credentials", filename); // Repo
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

/* ============ Estado por usuario (misma idea) ============ */
/**
 * sessions[wa_id] = {
 *   flow: "calc" | null,
 *   step: string | null,
 *   data: {
 *     empresa, producto_desc, categoria,
 *     fob_unit, cantidad, fob_total,
 *     peso_kg, vol_cbm,
 *     modo, contenedor, // si aplica
 *     matriz: { iva, iva_adic, di, iibb, internos, notas },
 *     resultado: {...}
 *   }
 * }
 */
const sessions = new Map();
function getSession(wa) {
  if (!sessions.has(wa)) sessions.set(wa, { flow: null, step: null, data: {} });
  return sessions.get(wa);
}

/* ============ WhatsApp helpers (misma base) ============ */
async function sendMessage(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Error enviando mensaje:", res.status, txt);
  }
  return res.ok;
}
function sendText(to, body) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

/* ============ UI: menús y listas ============ */
function sendStart(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "¡Bienvenido/a a la Calculadora de Importación de Conektar S.A.! 🧮\n\n¿Cómo querés iniciar?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "start_calc", title: "Iniciar cálculo" } },
          { type: "reply", reply: { id: "start_info", title: "¿Cómo funciona?" } },
        ],
      },
    },
  });
}
function sendProductoMetodo(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Sobre tu producto, ¿preferís escribir una breve descripción o elegir por categoría?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "prod_texto", title: "📝 Descripción" } },
          { type: "reply", reply: { id: "prod_categoria", title: "📂 Categoría" } },
        ],
      },
    },
  });
}
function sendCategoriaLista(to, categorias = []) {
  // WhatsApp List máx ~10 rows por sección
  const rows = categorias.slice(0, 10).map(c => ({
    id: `cat_${c}`,
    title: c,
  }));
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Elegí la categoría que más se acerque:" },
      action: {
        button: "Seleccionar",
        sections: [{ title: "Categorías", rows }]
      }
    }
  });
}
function sendModoSugerencia(to, sugerido) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `Sugerencia de modo: *${sugerido.toUpperCase()}*. ¿Querés usarla u optar por otra?` },
      action: {
        buttons: [
          { type: "reply", reply: { id: `modo_${sugerido}`, title: `Usar ${sugerido}` } },
          { type: "reply", reply: { id: "modo_elegir", title: "Elegir modo" } },
        ],
      },
    },
  });
}
function sendModos(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Elegí el modo de transporte:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "modo_maritimo", title: "🚢 Marítimo" } },
          { type: "reply", reply: { id: "modo_aereo", title: "✈️ Aéreo" } },
          { type: "reply", reply: { id: "modo_courier", title: "📦 Courier" } },
        ],
      },
    },
  });
}
function sendContenedores(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Si es Marítimo FCL, elegí contenedor:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "cont_20", title: "20' ST" } },
          { type: "reply", reply: { id: "cont_40", title: "40' ST" } },
          { type: "reply", reply: { id: "cont_40hc", title: "40' HC" } },
        ],
      },
    },
  });
}
function sendConfirm(to, d) {
  const base = [
    `• Empresa: *${d.empresa}*`,
    `• Producto: *${d.producto_desc || d.categoria}*`,
    `• FOB unit: *USD ${fmt(d.fob_unit)}* × *${d.cantidad || 1}* = *USD ${fmt(d.fob_total)}*`,
    `• Peso: *${fmt(d.peso_kg)} kg*  • Vol: *${fmt(d.vol_cbm)} m³*`,
    `• Modo: *${(d.modo || '—').toUpperCase()}*${d.contenedor ? ` • Contenedor: *${d.contenedor}*` : ''}`,
    `• Cat fiscal: *${d.matriz?.categoria || (d.categoria || '—')}*`
  ].join("\n");
  const body = `Revisá los datos 👇\n${base}\n\nIncoterm: FOB\n¿Confirmás para calcular?`;
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "calc_ok", title: "✅ Calcular" } },
          { type: "reply", reply: { id: "calc_edit", title: "✏️ Editar" } },
        ],
      },
    },
  });
}

/* ============ Utilidades ============ */
const isValidEmpresa = v => String(v).trim().length >= 2;
const toNum = (s) => {
  if (s == null) return 0;
  if (typeof s === "number") return s;
  const n = String(s).replace(/\./g, "").replace(/,/g, ".").match(/-?\d+(\.\d+)?/);
  return n ? Number(n[0]) : 0;
};
const fmt = (n) => (isFinite(n) ? Number(n).toFixed(2) : "0.00");

/* ============ Google helpers (misma base + lectura matriz) ============ */
function getOAuthClient() {
  const missing = [];
  try { fs.accessSync(CLIENT_PATH); } catch { missing.push(CLIENT_PATH); }
  try { fs.accessSync(TOKEN_PATH); }  catch { missing.push(TOKEN_PATH); }
  if (missing.length) {
    console.warn("⚠️ No se encuentran credenciales Google:", missing);
    throw new Error("Faltan credenciales de Google");
  }
  const { installed } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = installed;
  const oauth2 = new google.auth.OAuth2(
    client_id, client_secret, redirect_uris?.[0] || "http://127.0.0.1"
  );
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oauth2.setCredentials(tokens);
  return oauth2;
}
function hasGoogle() {
  try {
    fs.accessSync(CLIENT_PATH);
    fs.accessSync(TOKEN_PATH);
    return Boolean(GOOGLE_SHEETS_ID);
  } catch { return false; }
}
async function appendToSheetRange(a1, values) {
  if (!hasGoogle()) { console.warn("⚠️ Google deshabilitado"); return; }
  try {
    const auth = getOAuthClient();
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: a1,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error("❌ Error al escribir en Sheets:", err?.response?.data || err);
  }
}
async function readMatrix() {
  if (!hasGoogle()) return null;
  try {
    const auth = getOAuthClient();
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${PRODUCT_MATRIX_TAB}!A1:Z1000`;
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEETS_ID, range });
    const rows = resp.data.values || [];
    if (!rows.length) return null;
    const header = rows[0].map(h => (h || "").toString().trim());
    const idx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const map = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rec = {
        NIVEL_1: r[idx("NIVEL_1")] || "",
        NIVEL_2: r[idx("NIVEL_2")] || "",
        NIVEL_3: r[idx("NIVEL_3")] || "",
        CATEGORIA_PRINCIPAL: r[idx("CATEGORIA_PRINCIPAL")] || "",
        SUBCATEGORIA: r[idx("SUBCATEGORIA")] || "",
        iva: toNum(r[idx("% IVA")] || 0) / 100,
        iva_adic: toNum(r[idx("% IVA ADICIONAL")] || 0) / 100,
        di: toNum(r[idx("% DERECHOS IMPO")] || 0) / 100,
        iibb: toNum(r[idx("% IIBB")] || 0) / 100,
        internos: toNum(r[idx("% IMPUESTOS INTERNOS")] || 0) / 100,
        req: r[idx("REQUERIMIENTOS_IMPORTACION")] || "",
        notas: r[idx("NOTAS")] || "",
      };
      rec.categoria = rec.CATEGORIA_PRINCIPAL || rec.SUBCATEGORIA || rec.NIVEL_2 || rec.NIVEL_1;
      map.push(rec);
    }
    return map;
  } catch (e) {
    console.warn("⚠️ No pude leer matriz de Google:", e.message);
    return null;
  }
}

/* Fallback básico de categorías si no hay Google */
const MATRIX_FALLBACK = [
  { categoria: "Electrodomésticos", iva: 0.21, iva_adic: 0.00, di: 0.20, iibb: 0.035, internos: 0.00, notas: "Pequeños electrodomésticos usualmente 0% internos." },
  { categoria: "Electrónica y Electricidad", iva: 0.21, iva_adic: 0.00, di: 0.16, iibb: 0.035, internos: 0.00, notas: "Teléfonos podrían tener internos 17%." },
  { categoria: "Automatización industrial", iva: 0.21, iva_adic: 0.00, di: 0.14, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Maquinaria y piezas", iva: 0.21, iva_adic: 0.00, di: 0.14, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Informática", iva: 0.21, iva_adic: 0.00, di: 0.16, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Textil/Indumentaria", iva: 0.21, iva_adic: 0.00, di: 0.20, iibb: 0.035, internos: 0.00, notas: "" },
];

/* Búsqueda de categoría en la matriz */
let MATRIX_CACHE = null;
async function getMatrix() {
  if (MATRIX_CACHE) return MATRIX_CACHE;
  MATRIX_CACHE = (await readMatrix()) || MATRIX_FALLBACK;
  return MATRIX_CACHE;
}
async function findCategoryRecord({ categoria, descripcion }) {
  const M = await getMatrix();
  if (!M || !M.length) return null;
  const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").trim();
  const c = norm(categoria);
  if (c) {
    const exact = M.find(r => norm(r.categoria) === c);
    if (exact) return { ...exact, categoria: exact.categoria };
  }
  // heurística simple por palabras clave en descripción
  const d = norm(descripcion);
  if (d) {
    const score = (r) => {
      const words = norm(r.categoria).split(/\s+/).filter(Boolean);
      return words.reduce((acc,w)=> acc + (d.includes(w) ? 1 : 0), 0);
    };
    let best = null, bestS = -1;
    for (const r of M) {
      const s = score(r);
      if (s > bestS) { best = r; bestS = s; }
    }
    if (best) return { ...best, categoria: best.categoria };
  }
  return M[0]; // fallback
}

/* ============ Registro del cálculo ============ */
async function recordCalculo({ wa_id, empresa, producto, categoria, fob_unit, cantidad, fob_total, peso_kg, vol_cbm, modo, contenedor, cif, di, iva, iva_adic, iibb, internos, tasa_est, insurance, total_impuestos, total_costo }) {
  await appendToSheetRange(`${TAB_CALCULOS}!A1`, [
    new Date().toISOString(),
    wa_id, empresa, producto, categoria,
    fob_unit, cantidad, fob_total,
    peso_kg, vol_cbm, modo, contenedor || "",
    cif, di, iva, iva_adic, iibb, internos, tasa_est, insurance, total_impuestos, total_costo
  ]);
}

/* ============ Lógica de estimación ============ */
function sugerirModo({ peso_kg = 0, vol_cbm = 0 }) {
  const volKg = vol_cbm * 167; // equivalencia aérea
  const charge_kg = Math.max(peso_kg, volKg);
  if (charge_kg <= 30) return "courier";
  if (charge_kg <= 300) return "aereo";
  return "maritimo";
}
function estimarFlete({ modo, vol_cbm = 0, peso_kg = 0, contenedor = "" }) {
  if (modo === "aereo") {
    const charge = Math.max(peso_kg, vol_cbm * 167);
    return charge * RATE_AIR_PER_KG;
  }
  if (modo === "courier") {
    return Math.max(peso_kg, vol_cbm * 200) * RATE_COURIER_PER_KG;
  }
  if (modo === "maritimo") {
    if (contenedor) {
      if (contenedor === "20' ST") return RATE_FCL_20;
      if (contenedor === "40' ST") return RATE_FCL_40;
      if (contenedor === "40' HC") return RATE_FCL_40HC;
    }
    return Math.max(vol_cbm, 1) * RATE_LCL_PER_CBM; // LCL
  }
  return 0;
}
function calcularCostos({ fob_total = 0, modo, contenedor, peso_kg = 0, vol_cbm = 0, matriz }) {
  const freight = estimarFlete({ modo, vol_cbm, peso_kg, contenedor });
  const insurance = INSURANCE_RATE * fob_total;
  const tasa_est = TASA_ESTATISTICA * (fob_total + freight + insurance);
  const cif = fob_total + freight + insurance;

  const di = cif * (matriz?.di ?? 0);
  const baseIVA = cif + di + tasa_est;
  const iva = baseIVA * (matriz?.iva ?? 0);
  const iva_adic = baseIVA * (matriz?.iva_adic ?? 0);
  const iibb = cif * (matriz?.iibb ?? 0);          // simplificado
  const internos = cif * (matriz?.internos ?? 0);  // simplificado

  const total_impuestos = di + iva + iva_adic + iibb + internos + tasa_est;
  const total_costo = cif + total_impuestos;

  return { freight, insurance, tasa_est, cif, di, iva, iva_adic, iibb, internos, total_impuestos, total_costo };
}

/* ============ WEBHOOK VERIFY (misma base) ============ */
app.get("/webhook", (req, res) => {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFICADO");
    return res.status(200).send(challenge);
  }
  console.log("❌ Verificación rechazada");
  return res.sendStatus(403);
});

/* ============ WEBHOOK EVENTS (nuevo flujo calc) ============ */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = change?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;
    const session = getSession(from);

    // Comandos globales
    if (type === "text") {
      const body = (msg.text?.body || "").trim().toLowerCase();
      if (["hola","menu","menú","inicio","volver","start"].includes(body)) {
        sessions.delete(from);
        await sendStart(from);
        return res.sendStatus(200);
      }
    }

    // Imágenes/documentos no se usan en este flujo
    if (type !== "text" && type !== "interactive") {
      await sendText(from, "ℹ️ Mensaje no soportado. Escribí *inicio* para comenzar.");
      return res.sendStatus(200);
    }

    /* ====== INTERACTIVE ====== */
    if (type === "interactive") {
      const btnId = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id;

      if (btnId === "start_info") {
        await sendText(from, "Te pedimos datos básicos (producto, FOB, cantidad, peso/volumen). Calculamos DI, IVA, etc. El resultado es estimado y no reemplaza la cotización formal por NCM específico.");
        await sendStart(from);
        return res.sendStatus(200);
      }
      if (btnId === "start_calc") {
        sessions.set(from, { flow: "calc", step: "empresa", data: {} });
        await sendText(from, "📌 Decime el nombre de tu empresa.");
        return res.sendStatus(200);
      }

      if (session.flow === "calc") {
        if (btnId === "prod_texto") {
          session.step = "producto_texto";
          await sendText(from, "📝 Escribí una breve descripción del producto (ej.: “batidora de mano”, “PLC Siemens”, “cable USB”).");
          return res.sendStatus(200);
        }
        if (btnId === "prod_categoria") {
          session.step = "producto_categoria";
          const M = await getMatrix();
          const cats = [...new Set(M.map(r => r.categoria))];
          await sendCategoriaLista(from, cats);
          return res.sendStatus(200);
        }
        if (btnId?.startsWith("cat_") && session.step === "producto_categoria") {
          session.data.categoria = btnId.replace(/^cat_/, "");
          session.step = "fob_unit";
          await sendText(from, "💵 Ingresá *FOB unitario en USD* (ej.: 125.50).");
          return res.sendStatus(200);
        }

        // Elegir/sugerir modo
        if (btnId === "modo_elegir" && ["modo_sugerencia","modo_elegir"].includes(session.step)) {
          session.step = "modo";
          await sendModos(from);
          return res.sendStatus(200);
        }
        if (["modo_maritimo","modo_aereo","modo_courier"].includes(btnId)) {
          session.data.modo = btnId.replace("modo_","");
          if (session.data.modo === "maritimo") {
            session.step = "contenedor";
            await sendContenedores(from);
          } else {
            session.step = "confirm";
            await sendConfirm(from, session.data);
          }
          return res.sendStatus(200);
        }
        if (["cont_20","cont_40","cont_40hc"].includes(btnId)) {
          session.data.contenedor = btnId === "cont_20" ? "20' ST" : btnId === "cont_40" ? "40' ST" : "40' HC";
          session.step = "confirm";
          await sendConfirm(from, session.data);
          return res.sendStatus(200);
        }

        if (btnId === "calc_ok" && session.step === "confirm") {
          // Ejecutar cálculo
          const out = calcularCostos({
            fob_total: session.data.fob_total,
            modo: session.data.modo,
            contenedor: session.data.contenedor,
            peso_kg: session.data.peso_kg,
            vol_cbm: session.data.vol_cbm,
            matriz: session.data.matriz
          });
          session.data.resultado = out;

          const r = out;
          const m = session.data.matriz || {};
          const resumen =
`📦 *Resultado estimado (FOB)*

FOB total: USD ${fmt(session.data.fob_total)}
Flete (${session.data.modo}${session.data.contenedor ? " "+session.data.contenedor : ""}): USD ${fmt(r.freight)}
Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmt(r.insurance)}
Tasa Estadística: USD ${fmt(r.tasa_est)}
CIF: *USD ${fmt(r.cif)}*

DI (${(m.di*100||0).toFixed(1)}%): USD ${fmt(r.di)}
IVA (${(m.iva*100||0).toFixed(1)}%): USD ${fmt(r.iva)}
IVA Adic (${(m.iva_adic*100||0).toFixed(1)}%): USD ${fmt(r.iva_adic)}
IIBB (${(m.iibb*100||0).toFixed(1)}%): USD ${fmt(r.iibb)}
Internos (${(m.internos*100||0).toFixed(1)}%): USD ${fmt(r.internos)}

*Impuestos totales:* USD ${fmt(r.total_impuestos)}
*Costo total estimado (CIF + imp.):* *USD ${fmt(r.total_costo)}*

Notas: ${m.notas || "Valores indicativos. Pueden variar según NCM, exenciones y jurisdicción IIBB."}
`;

          await sendText(from, resumen);

          // Registrar en Sheets
          try {
            await recordCalculo({
              wa_id: from,
              empresa: session.data.empresa,
              producto: session.data.producto_desc || "",
              categoria: session.data.matriz?.categoria || session.data.categoria || "",
              fob_unit: session.data.fob_unit,
              cantidad: session.data.cantidad,
              fob_total: session.data.fob_total,
              peso_kg: session.data.peso_kg,
              vol_cbm: session.data.vol_cbm,
              modo: session.data.modo,
              contenedor: session.data.contenedor,
              cif: r.cif, di: r.di, iva: r.iva, iva_adic: r.iva_adic, iibb: r.iibb, internos: r.internos,
              tasa_est: r.tasa_est, insurance: r.insurance,
              total_impuestos: r.total_impuestos, total_costo: r.total_costo
            });
          } catch(e) {
            console.warn("⚠️ No se registró el cálculo en Sheets:", e.message);
          }

          await sendText(from, "¿Querés hacer otro cálculo? Escribí *inicio* o *menu* cuando quieras.");
          sessions.delete(from);
          return res.sendStatus(200);
        }

        if (btnId === "calc_edit" && session.step === "confirm") {
          // Volvemos a elegir modo
          session.step = "modo";
          await sendModos(from);
          return res.sendStatus(200);
        }
      }

      // fallback
      await sendStart(from);
      return res.sendStatus(200);
    }

    /* ====== TEXTO ====== */
    if (type === "text") {
      const bodyRaw = (msg.text?.body || "").trim();
      const body = bodyRaw;

      if (["hola","menu","menú","inicio","volver","start"].includes(body.toLowerCase())) {
        sessions.delete(from);
        await sendStart(from);
        return res.sendStatus(200);
      }

      const session = getSession(from);
      if (session.flow !== "calc") {
        // no hay flujo → ofrecer inicio
        await sendStart(from);
        return res.sendStatus(200);
      }

      // Empresa
      if (session.step === "empresa") {
        if (!isValidEmpresa(body)) {
          await sendText(from, "⚠️ Ingresá un nombre de empresa válido (mínimo 2 caracteres).");
        } else {
          session.data.empresa = body;
          session.step = "producto_metodo";
          await sendProductoMetodo(from);
        }
        return res.sendStatus(200);
      }

      // Producto por texto
      if (session.step === "producto_texto") {
        session.data.producto_desc = body;
        // buscar categoría en matriz
        const rec = await findCategoryRecord({ descripcion: body });
        session.data.matriz = rec;
        session.data.categoria = rec?.categoria || session.data.categoria;
        session.step = "fob_unit";
        await sendText(from, "💵 Ingresá *FOB unitario en USD* (ej.: 125.50).");
        return res.sendStatus(200);
      }

      // FOB unitario
      if (session.step === "fob_unit") {
        const n = toNum(body);
        if (n <= 0) {
          await sendText(from, "⚠️ Ingresá un número válido para FOB unitario (ej.: 125.50).");
        } else {
          session.data.fob_unit = n;
          session.step = "cantidad";
          await sendText(from, "🔢 Ingresá la *cantidad de unidades*.");
        }
        return res.sendStatus(200);
      }

      // Cantidad
      if (session.step === "cantidad") {
        const q = Math.max(1, Math.round(toNum(body)));
        session.data.cantidad = q;
        session.data.fob_total = (session.data.fob_unit || 0) * q;
        session.step = "peso_vol";
        await sendText(from, "⚖️ Indicá *PESO y VOLUMEN* total. Formato sugerido:\nPESO: 120\nVOL: 0.8   (m³)");
        return res.sendStatus(200);
      }

      // Peso y Volumen
      if (session.step === "peso_vol") {
        const pesoMatch = body.match(/peso\s*:\s*([0-9\.,]+)/i);
        const volMatch  = body.match(/vol(umen)?\s*:\s*([0-9\.,]+)/i);
        const peso_kg = pesoMatch ? toNum(pesoMatch[1]) : toNum(body);
        const vol_cbm = volMatch  ? toNum(volMatch[2])  : 0;
        session.data.peso_kg = peso_kg;
        session.data.vol_cbm = vol_cbm;

        // Seleccionar/ Sugerir modo
        const sugerido = sugerirModo({ peso_kg, vol_cbm });
        session.step = "modo_sugerencia";
        await sendModoSugerencia(from, sugerido);
        return res.sendStatus(200);
      }

      // Confirmación directa por texto
      if (session.step === "confirm") {
        await sendConfirm(from, session.data);
        return res.sendStatus(200);
      }

      // Cualquier otra cosa → repetir paso actual
      await sendText(from, "No te entendí. Escribí *inicio* para volver al comienzo.");
      return res.sendStatus(200);
    }

    // Fallback
    await sendText(from, "ℹ️ Escribí *inicio* para comenzar.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ============ Salud y raíz ============ */
app.get("/", (_req, res) => res.status(200).send("Conektar - Calculadora de Importación ✅"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ============ Start (misma base) ============ */
app.listen(PORT, () => {
  console.log(`🚀 Calculadora corriendo en http://localhost:${PORT}`);
  console.log("🔐 Token:", WHATSAPP_TOKEN ? WHATSAPP_TOKEN.slice(0, 10) + "..." : "(vacío)");
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Credenciales usadas:", { CLIENT_PATH, TOKEN_PATH });
});








