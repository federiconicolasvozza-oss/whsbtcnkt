// index.js - Calculadora de Costos Totales de Importación (con Despachante + TCA + LCL W/M + flujo centrado en producto)
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

const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "").trim();
// Si te copiaron el link entero, limpiamos y nos quedamos con el nombre de pestaña
const PRODUCT_MATRIX_TAB_RAW = (process.env.PRODUCT_MATRIX_TAB || "Hoja 1")
  .replace(/https?:\/\/.*/i, "")
  .trim();

const TAB_CALCULOS = (process.env.TAB_CALCULOS || "Calculos").trim();

/* Impuestos y tasas */
const INSURANCE_RATE   = Number(process.env.INSURANCE_RATE   ?? 0.01); // 1% FOB
const TASA_ESTATISTICA = Number(process.env.TASA_ESTATISTICA ?? 0.03); // 3% sobre CIF
const RATE_IIGG        = Number(process.env.RATE_IIGG        ?? 0.06); // 6% sobre base IVA

/* Fletes (tuneables por ENV; LCL con W/M + gastos locales AR según tu pedido) */
const RATE_AIR_PER_KG       = Number(process.env.RATE_AIR_PER_KG       ?? 5.5);
const RATE_COURIER_PER_KG   = Number(process.env.RATE_COURIER_PER_KG   ?? 9.0);
const RATE_LCL_PER_TON      = Number(process.env.RATE_LCL_PER_TON      ?? 5);     // USD por TON (1 m³ = 1 TON)
const AR_LOCAL_CHARGES_LCL  = Number(process.env.AR_LOCAL_CHARGES_LCL  ?? 400);   // Gastos locales Argentina LCL
const RATE_FCL_20           = Number(process.env.RATE_FCL_20           ?? 2100);  // USD por cntr
const RATE_FCL_40           = Number(process.env.RATE_FCL_40           ?? 3000);
const RATE_FCL_40HC         = Number(process.env.RATE_FCL_40HC         ?? 3250);

/* Despachante y gastos */
const DESPACHANTE_PORCENTAJE = Number(process.env.DESPACHANTE_PORCENTAJE ?? 0.003); // 0.3% de CIF
const DESPACHANTE_MINIMO     = Number(process.env.DESPACHANTE_MINIMO     ?? 150);   // USD
const GASTOS_ADMINISTRATIVOS = Number(process.env.GASTOS_ADMINISTRATIVOS ?? 20);    // USD
const GASTOS_OPERATIVOS      = Number(process.env.GASTOS_OPERATIVOS      ?? 100);   // USD

/* TCA (Depósito Fiscal) – tabla por rangos de PESO (kg) */
const TCA_TABLE_DEFAULT = [
  { min: 0, max: 5, price: 52.31 },
  { min: 5, max: 10, price: 71.14 },
  { min: 10, max: 20, price: 103.14 },
  { min: 20, max: 50, price: 149.93 },
  { min: 50, max: 100, price: 205.82 },
  { min: 100, max: 200, price: 279.50 },
  { min: 200, max: 350, price: 381.16 },
  { min: 350, max: 500, price: 526.48 },
  { min: 500, max: 750, price: 622.56 },
  { min: 750, max: 1000, price: 750.60 },
  { min: 1000, max: 1500, price: 880.22 },
  { min: 1500, max: 2000, price: 1019.95 },
  { min: 2000, max: 2500, price: 1155.66 },
  { min: 2500, max: 3000, price: 1359.42 },
  { min: 3000, max: 4000, price: 1577.46 },
  { min: 4000, max: 5000, price: null }, // Consultar
];
let TCA_TABLE = TCA_TABLE_DEFAULT;
try {
  if (process.env.TCA_TABLE_JSON) {
    const parsed = JSON.parse(process.env.TCA_TABLE_JSON);
    if (Array.isArray(parsed)) TCA_TABLE = parsed;
  }
} catch {
  console.warn("⚠️ TCA_TABLE_JSON inválido; usando tabla default.");
}

/* ========= Credenciales Google ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename);
  const fromRepo    = path.join(process.cwd(), "credentials", filename);
  try { fs.accessSync(fromSecrets); return fromSecrets; } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

/* ============ Estado por usuario ============ */
const sessions = new Map();
/**
 * sessions[wa_id] = {
 *   flow: "calc" | null,
 *   step: string | null,
 *   data: {
 *     empresa, producto_desc, categoria,
 *     fob_unit, cantidad, fob_total,
 *     vol_cbm, peso_kg,
 *     modo, maritimo_tipo, contenedor,
 *     matriz: { iva, iva_adic, di, iibb, internos, categoria },
 *     resultado: {...}
 *   }
 * }
 */
function getSession(wa) {
  if (!sessions.has(wa)) sessions.set(wa, { flow: null, step: null, data: {} });
  return sessions.get(wa);
}

/* ============ WhatsApp helpers ============ */
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

/* ============ UI ============ */
function sendStart(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "🧮 ¡Bienvenido/a a la *Calculadora de Importación* de Conektar S.A.!\n\n¿Cómo querés iniciar?" },
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
      body: { text: "Sobre tu producto, ¿preferís escribir una breve descripción, elegir por categoría o ver populares?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "prod_texto", title: "📝 Descripción" } },
          { type: "reply", reply: { id: "prod_categoria", title: "📂 Categoría" } },
          { type: "reply", reply: { id: "prod_populares", title: "⭐ Populares" } },
        ],
      },
    },
  });
}
function sendCategoriaLista(to, categorias = []) {
  const rows = categorias.slice(0, 10).map(c => ({ id: `cat_${c}`, title: c }));
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Elegí la categoría que más se acerque:" },
      action: { button: "Seleccionar", sections: [{ title: "Categorías", rows }] }
    }
  });
}
function sendPopulares(to) {
  const populares = ["Celulares y Smartphones", "Memorias RAM", "Cables USB-C"];
  const rows = populares.map((p, i) => ({ id: `pop_${i}_${p}`, title: p }));
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "⭐ Productos más consultados:" },
      action: { button: "Ver", sections: [{ title: "Populares", rows }] }
    }
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
function sendTiposMaritimo(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Marítimo seleccionado. ¿Vas por LCL (carga parcial) o FCL (contenedor completo)?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "mar_lcl", title: "LCL" } },
          { type: "reply", reply: { id: "mar_fcl", title: "FCL" } },
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
      body: { text: "Elegí contenedor para FCL:" },
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
function sendModoSugerencia(to, sugerido) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `Sugerencia de transporte: *${sugerido.toUpperCase()}*.\n¿Querés usarla u optar por otra?` },
      action: {
        buttons: [
          { type: "reply", reply: { id: `modo_${sugerido}`, title: `Usar ${sugerido}` } },
          { type: "reply", reply: { id: "modo_elegir", title: "Elegir modo" } },
        ],
      },
    },
  });
}
function sendConfirm(to, d) {
  const base = [
    `• Empresa: *${d.empresa}*`,
    `• Producto: *${d.producto_desc || d.categoria || "—"}*`,
    `• FOB unit: *USD ${fmt(d.fob_unit)}* × *${d.cantidad || 1}* = *USD ${fmt(d.fob_total)}*`,
    `• Volumen: *${fmt(d.vol_cbm)} m³*  • Peso: *${fmt(d.peso_kg)} kg*`,
    `• Modo: *${(d.modo || '—').toUpperCase()}*${d.modo==='maritimo' && d.maritimo_tipo ? ` • ${d.maritimo_tipo}` : ''}${d.contenedor ? ` • Contenedor: *${d.contenedor}*` : ''}`
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

/* ============ Google helpers ============ */
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

    const rawTab = PRODUCT_MATRIX_TAB_RAW.replace(/^'+|'+$/g, "");
    const needsQuotes = /[^A-Za-z0-9_]/.test(rawTab);
    const tabForRange = needsQuotes ? `'${rawTab}'` : rawTab;
    const range = `${tabForRange}!A1:Z2000`;

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range
    });
    const rows = resp.data.values || [];
    if (!rows.length) return null;

    const header = rows[0].map(h => (h || "").toString().trim());
    const idx = (name) =>
      header.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const map = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
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

/* Mapa fallback + reglas rápidas (ej.: “cable usb”) */
const MATRIX_FALLBACK = [
  { categoria: "Electrónica y Electricidad", iva: 0.21, iva_adic: 0.20, di: 0.14, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Electrodomésticos",          iva: 0.21, iva_adic: 0.00, di: 0.20, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Automatización industrial",   iva: 0.21, iva_adic: 0.00, di: 0.14, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Maquinaria y piezas",         iva: 0.21, iva_adic: 0.00, di: 0.14, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Informática",                 iva: 0.21, iva_adic: 0.00, di: 0.16, iibb: 0.035, internos: 0.00, notas: "" },
  { categoria: "Textil/Indumentaria",         iva: 0.21, iva_adic: 0.00, di: 0.20, iibb: 0.035, internos: 0.00, notas: "" },
];
const KEYWORD_RULES = [
  {
    pattern: /\bcable\s*usb\b/i,
    rec: { categoria: "Electrónica y Electricidad - Cables y Conectores",
           iva: 0.21, iva_adic: 0.20, di: 0.14, iibb: 0.035, internos: 0.00, notas: "SEGURIDAD ELÉCTRICA" }
  },
];

let MATRIX_CACHE = null;
async function getMatrix() {
  if (MATRIX_CACHE) return MATRIX_CACHE;
  MATRIX_CACHE = (await readMatrix()) || MATRIX_FALLBACK;
  return MATRIX_CACHE;
}
function byKeyword(desc) {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(desc || "")) return rule.rec;
  }
  return null;
}
async function findCategoryRecord({ categoria, descripcion }) {
  const kw = byKeyword(descripcion);
  if (kw) return kw;

  const M = await getMatrix();
  if (!M || !M.length) return null;
  const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"").trim();
  const c = norm(categoria);
  if (c) {
    const exact = M.find(r => norm(r.categoria) === c);
    if (exact) return { ...exact, categoria: exact.categoria };
  }
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
  return M[0];
}

/* Registro de cálculos */
async function recordCalculo({
  wa_id, empresa, producto, categoria,
  fob_unit, cantidad, fob_total,
  peso_kg, vol_cbm, modo, maritimo_tipo, contenedor,
  cif, di, iva, iva_adic, iibb, iigg, internos, tasa_est, insurance, freight,
  despacho_total, despacho_honor, despacho_admin, despacho_oper,
  tca_monto, tca_band,
  total_impuestos, costo_aduanero, costo_final
}) {
  await appendToSheetRange(`${TAB_CALCULOS}!A1`, [
    new Date().toISOString(),
    wa_id, empresa, producto, categoria,
    fob_unit, cantidad, fob_total,
    peso_kg, vol_cbm, modo, (maritimo_tipo || ""), contenedor || "",
    insurance, freight, cif,
    di, tasa_est, iva, iva_adic, iibb, iigg, internos,
    total_impuestos, costo_aduanero,
    despacho_honor, despacho_admin, despacho_oper, despacho_total,
    tca_band, tca_monto,
    costo_final
  ]);
}

/* ====== Lógica de transporte y costos ====== */
function sugerirModo({ peso_kg = 0, vol_cbm = 0, fob_total = 0 }) {
  // heurística inspirada en tu lógica Python + ajustes prácticos
  const volKg = vol_cbm * 167;           // conversión volumétrica aérea
  const charge_kg = Math.max(peso_kg, volKg);
  const valorPorKg = peso_kg > 0 ? (fob_total / peso_kg) : 0;

  // cargas muy chicas: courier
  if (charge_kg <= 30 && fob_total >= 200) return "courier";
  // alto valor por kg y peso moderado: aéreo
  if (charge_kg <= 200 && valorPorKg > 20) return "aereo";
  // volumen/peso ya sugieren marítimo
  if (vol_cbm >= 1.5 || charge_kg > 300) return "maritimo";
  return "aereo";
}

function estimarFlete({ modo, maritimo_tipo, vol_cbm = 0, peso_kg = 0, contenedor = "" }) {
  // retornamos detalle para mostrar "gastos locales LCL" aparte
  const det = { total: 0, breakdown: {} };

  if (modo === "aereo") {
    const charge = Math.max(peso_kg, vol_cbm * 167);
    det.breakdown.air_kg = charge * RATE_AIR_PER_KG;
    det.total = det.breakdown.air_kg;
    return det;
  }
  if (modo === "courier") {
    const charge = Math.max(peso_kg, vol_cbm * 200);
    det.breakdown.courier_kg = charge * RATE_COURIER_PER_KG;
    det.total = det.breakdown.courier_kg;
    return det;
  }
  if (modo === "maritimo") {
    if (maritimo_tipo === "FCL" && contenedor) {
      const map = { "20' ST": RATE_FCL_20, "40' ST": RATE_FCL_40, "40' HC": RATE_FCL_40HC };
      det.breakdown.fcl_base = map[contenedor] || 0;
      det.total = det.breakdown.fcl_base;
      return det;
    }
    // LCL: W/M (1 m³ = 1 TON) + gastos locales AR
    const charge_ton = Math.max(peso_kg / 1000, vol_cbm);
    det.breakdown.lcl_wm = charge_ton * RATE_LCL_PER_TON;
    det.breakdown.lcl_ar_local = AR_LOCAL_CHARGES_LCL;
    det.total = det.breakdown.lcl_wm + det.breakdown.lcl_ar_local;
    return det;
  }
  return det;
}

function calcularTCA(peso_total_kg) {
  for (const band of TCA_TABLE) {
    if (peso_total_kg > band.min && peso_total_kg <= band.max) {
      return { monto: band.price ?? 0, banda: `${band.min}-${band.max}kg${band.price==null?" (CONSULTAR)":""}` };
    }
  }
  return { monto: 0, banda: ">5000kg (CONSULTAR)" };
}

function calcularDespacho(cif) {
  const honor = Math.max(cif * DESPACHANTE_PORCENTAJE, DESPACHANTE_MINIMO);
  const total = honor + GASTOS_ADMINISTRATIVOS + GASTOS_OPERATIVOS;
  return { honor, admin: GASTOS_ADMINISTRATIVOS, oper: GASTOS_OPERATIVOS, total };
}

function calcularCostos({ fob_total = 0, modo, maritimo_tipo, contenedor, peso_kg = 0, vol_cbm = 0, matriz }) {
  // Flete + Seguro
  const fletDet = estimarFlete({ modo, maritimo_tipo, vol_cbm, peso_kg, contenedor });
  const freight = fletDet.total;
  const insurance = INSURANCE_RATE * fob_total;

  // CIF (antes de tasa estadística)
  const cif = fob_total + freight + insurance;

  // Impuestos (tasa estadística se muestra junto a impuestos y entra a base IVA)
  const di       = cif * (matriz?.di ?? 0);
  const tasa_est = cif * TASA_ESTATISTICA;
  const baseIVA  = cif + di + tasa_est;

  const iva      = baseIVA * (matriz?.iva ?? 0);
  const iva_adic = baseIVA * (matriz?.iva_adic ?? 0);
  const iibb     = cif * (matriz?.iibb ?? 0);
  const iigg     = baseIVA * RATE_IIGG;
  const internos = (matriz?.internos ?? 0) > 0 ? cif * (matriz?.internos ?? 0) : 0;

  const total_impuestos = di + tasa_est + iva + iva_adic + iibb + iigg + internos;
  const costo_aduanero  = cif + total_impuestos; // CIF + impuestos

  // Despachante
  const despacho = calcularDespacho(cif);
  // TCA
  const tca = calcularTCA(peso_kg);

  // Costo final (puesto con despacho + TCA)
  const costo_final = costo_aduanero + despacho.total + (tca.monto || 0);

  return {
    flete_detalle: fletDet, freight, insurance, cif,
    di, tasa_est, iva, iva_adic, iibb, iigg, internos,
    total_impuestos, costo_aduanero,
    despacho, tca,
    costo_final
  };
}

/* ============ WEBHOOK VERIFY ============ */
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

/* ============ WEBHOOK EVENTS ============ */
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

    if (type !== "text" && type !== "interactive") {
      await sendText(from, "ℹ️ Mensaje no soportado. Escribí *inicio* para comenzar.");
      return res.sendStatus(200);
    }

    /* ====== INTERACTIVE ====== */
    if (type === "interactive") {
      const btnId = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id;

      if (btnId === "start_info") {
        await sendText(from, "Pido datos de producto (FOB, cantidad, volumen/peso). Calculo DI, IVA, IIGG, etc. Incluyo despacho y TCA. Resultado estimado; puede variar según NCM/jurisdicción.");
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
          await sendText(from, "📝 Describí el producto (p.ej., “cable USB”, “memoria RAM”, “batidora de mano”).");
          return res.sendStatus(200);
        }
        if (btnId === "prod_categoria") {
          session.step = "producto_categoria";
          const M = await getMatrix();
          const cats = [...new Set(M.map(r => r.categoria))];
          await sendCategoriaLista(from, cats);
          return res.sendStatus(200);
        }
        if (btnId === "prod_populares") {
          session.step = "producto_populares";
          await sendPopulares(from);
          return res.sendStatus(200);
        }
        if (btnId?.startsWith("cat_") && session.step === "producto_categoria") {
          session.data.categoria = btnId.replace(/^cat_/, "");
          const rec = await findCategoryRecord({ categoria: session.data.categoria });
          session.data.matriz = rec;
          session.step = "fob_unit";
          await sendText(from, "💵 Ingresá *FOB unitario en USD* (ej.: 125.50).");
          return res.sendStatus(200);
        }
        if (btnId?.startsWith("pop_") && session.step === "producto_populares") {
          const label = btnId.split("_").slice(2).join("_").replace(/_/g, " ");
          session.data.producto_desc = label;
          const rec = await findCategoryRecord({ descripcion: label });
          session.data.matriz = rec;
          session.step = "fob_unit";
          await sendText(from, `⭐ Seleccionado: ${label}\n\n💵 Ingresá *FOB unitario en USD* (ej.: 125.50).`);
          return res.sendStatus(200);
        }

        if (btnId === "modo_elegir" && ["modo_sugerencia","modo_elegir"].includes(session.step)) {
          session.step = "modo";
          await sendModos(from);
          return res.sendStatus(200);
        }
        if (btnId === "modo_maritimo") {
          session.data.modo = "maritimo";
          session.step = "maritimo_tipo";
          await sendTiposMaritimo(from);
          return res.sendStatus(200);
        }
        if (btnId === "modo_aereo" || btnId === "modo_courier") {
          session.data.modo = btnId.replace("modo_","");
          session.step = "confirm";
          await sendConfirm(from, session.data);
          return res.sendStatus(200);
        }
        if (btnId === "mar_lcl") {
          session.data.maritimo_tipo = "LCL";
          session.step = "confirm";
          await sendConfirm(from, session.data);
          return res.sendStatus(200);
        }
        if (btnId === "mar_fcl") {
          session.data.maritimo_tipo = "FCL";
          session.step = "contenedor";
          await sendContenedores(from);
          return res.sendStatus(200);
        }
        if (["cont_20","cont_40","cont_40hc"].includes(btnId)) {
          session.data.contenedor = btnId === "cont_20" ? "20' ST" : btnId === "cont_40" ? "40' ST" : "40' HC";
          session.step = "confirm";
          await sendConfirm(from, session.data);
          return res.sendStatus(200);
        }

        if (btnId === "calc_ok" && session.step === "confirm") {
          const out = calcularCostos({
            fob_total: session.data.fob_total,
            modo: session.data.modo,
            maritimo_tipo: session.data.maritimo_tipo,
            contenedor: session.data.contenedor,
            peso_kg: session.data.peso_kg,
            vol_cbm: session.data.vol_cbm,
            matriz: session.data.matriz
          });
          session.data.resultado = out;
          const r = out;
          const m = session.data.matriz || {};

          // Detalle de flete (muestra LCL W/M + Locales por separado)
          let fleteLinea = `Flete (${session.data.modo}`;
          if (session.data.modo === 'maritimo' && session.data.maritimo_tipo) fleteLinea += ` ${session.data.maritimo_tipo}`;
          if (session.data.contenedor) fleteLinea += ` ${session.data.contenedor}`;
          fleteLinea += `): USD ${fmt(r.freight)}`;
          const detFlete =
            session.data.modo === 'maritimo' && session.data.maritimo_tipo === 'LCL'
              ? `\n   • LCL W/M (USD ${fmt(RATE_LCL_PER_TON)}/TON): USD ${fmt(r.flete_detalle.breakdown.lcl_wm || 0)}\n   • Gastos locales AR: USD ${fmt(r.flete_detalle.breakdown.lcl_ar_local || 0)}`
              : "";

          const resumen =
`📦 *Resultado estimado (FOB)*

FOB total: USD ${fmt(session.data.fob_total)}
${fleteLinea}${detFlete}
Seguro (${(INSURANCE_RATE*100).toFixed(1)}%): USD ${fmt(r.insurance)}
CIF: *USD ${fmt(r.cif)}*

🏛️ *Impuestos*
DI (${(m.di*100||0).toFixed(1)}%): USD ${fmt(r.di)}
Tasa Estadística (${(TASA_ESTATISTICA*100).toFixed(1)}% CIF): USD ${fmt(r.tasa_est)}
IVA (${(m.iva*100||0).toFixed(1)}%): USD ${fmt(r.iva)}
IVA Adic (${(m.iva_adic*100||0).toFixed(1)}%): USD ${fmt(r.iva_adic)}
IIBB (${(m.iibb*100||0).toFixed(1)}%): USD ${fmt(r.iibb)}
IIGG (${(RATE_IIGG*100).toFixed(1)}%): USD ${fmt(r.iigg)}${(m.internos||0)>0 ? `\nInternos (${(m.internos*100).toFixed(1)}%): USD ${fmt(r.internos)}` : ""}

*Impuestos totales:* USD ${fmt(r.total_impuestos)}
*Costo aduanero (CIF + imp.):* *USD ${fmt(r.costo_aduanero)}*

👨‍💼 *Despacho aduanero*
Honorarios (${(DESPACHANTE_PORCENTAJE*100).toFixed(2)}% min USD ${DESPACHANTE_MINIMO}): USD ${fmt(r.despacho.honor)}
Gastos admin: USD ${fmt(r.despacho.admin)}  •  Operativos: USD ${fmt(r.despacho.oper)}
Total Despacho: *USD ${fmt(r.despacho.total)}*

🏢 *Depósito fiscal (TCA)* ${r.tca.banda}
Monto: ${r.tca.monto ? `USD ${fmt(r.tca.monto)}` : "Consultar"}

🎯 *Costo final estimado: USD ${fmt(r.costo_final)}*
(Costo aduanero + Despacho + TCA)

¿Querés hacer otro cálculo? Escribí *inicio* cuando quieras.`;

          await sendText(from, resumen);

          // Guardar en Sheets (si está configurado)
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
              maritimo_tipo: session.data.maritimo_tipo,
              contenedor: session.data.contenedor,
              insurance: r.insurance,
              freight: r.freight,
              cif: r.cif,
              di: r.di, tasa_est: r.tasa_est, iva: r.iva, iva_adic: r.iva_adic, iibb: r.iibb, iigg: r.iigg, internos: r.internos,
              total_impuestos: r.total_impuestos, costo_aduanero: r.costo_aduanero,
              despacho_total: r.despacho.total, despacho_honor: r.despacho.honor, despacho_admin: r.despacho.admin, despacho_oper: r.despacho.oper,
              tca_monto: r.tca.monto || 0, tca_band: r.tca.banda,
              costo_final: r.costo_final
            });
          } catch(e) {
            console.warn("⚠️ No se registró el cálculo en Sheets:", e.message);
          }

          sessions.delete(from);
          return res.sendStatus(200);
        }

        if (btnId === "calc_edit" && session.step === "confirm") {
          session.step = "modo";
          await sendModos(from);
          return res.sendStatus(200);
        }
      }

      await sendStart(from);
      return res.sendStatus(200);
    }

    /* ====== TEXTO ====== */
    if (type === "text") {
      const raw = (msg.text?.body || "").trim();
      const low = raw.toLowerCase();

      if (["hola","menu","menú","inicio","volver","start"].includes(low)) {
        sessions.delete(from);
        await sendStart(from);
        return res.sendStatus(200);
      }

      const session = getSession(from);
      if (session.flow !== "calc") {
        await sendStart(from);
        return res.sendStatus(200);
      }

      if (session.step === "empresa") {
        if (!isValidEmpresa(raw)) {
          await sendText(from, "⚠️ Ingresá un nombre de empresa válido (mínimo 2 caracteres).");
        } else {
          session.data.empresa = raw;
          session.step = "producto_metodo";
          await sendProductoMetodo(from);
        }
        return res.sendStatus(200);
      }

      if (session.step === "producto_texto") {
        session.data.producto_desc = raw;
        const rec = await findCategoryRecord({ descripcion: raw });
        session.data.matriz = rec;
        session.step = "fob_unit";
        await sendText(from, "💵 Ingresá *FOB unitario en USD* (ej.: 125.50).");
        return res.sendStatus(200);
      }

      if (session.step === "fob_unit") {
        const n = toNum(raw);
        if (n <= 0) {
          await sendText(from, "⚠️ Ingresá un número válido para FOB unitario (ej.: 125.50).");
        } else {
          session.data.fob_unit = n;
          session.step = "cantidad";
          await sendText(from, "🔢 Ingresá la *cantidad de unidades*.");
        }
        return res.sendStatus(200);
      }

      if (session.step === "cantidad") {
        const q = Math.max(1, Math.round(toNum(raw)));
        session.data.cantidad = q;
        session.data.fob_total = (session.data.fob_unit || 0) * q;
        session.step = "volumen";
        await sendText(from, "📦 Ingresá el *VOLUMEN total* en m³ (ej.: 8.5). Si no sabés, escribí 0.");
        return res.sendStatus(200);
      }

      if (session.step === "volumen") {
        session.data.vol_cbm = toNum(raw);
        session.step = "peso";
        await sendText(from, "⚖️ Ingresá el *PESO total* en kg (ej.: 120). Si no tenés el dato, escribí 0.");
        return res.sendStatus(200);
      }

      if (session.step === "peso") {
        session.data.peso_kg = toNum(raw);
        const sugerido = sugerirModo({
          peso_kg: session.data.peso_kg,
          vol_cbm: session.data.vol_cbm,
          fob_total: session.data.fob_total
        });
        session.step = "modo_sugerencia";
        await sendModoSugerencia(from, sugerido);
        return res.sendStatus(200);
      }

      if (session.step === "confirm") {
        await sendConfirm(from, session.data);
        return res.sendStatus(200);
      }

      await sendText(from, "No te entendí. Escribí *inicio* para volver al comienzo.");
      return res.sendStatus(200);
    }

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

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`🚀 Calculadora corriendo en http://localhost:${PORT}`);
  console.log("🔐 Token:", WHATSAPP_TOKEN ? WHATSAPP_TOKEN.slice(0, 10) + "..." : "(vacío)");
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Credenciales usadas:", { CLIENT_PATH, TOKEN_PATH });
  console.log("🗂️ PRODUCT_MATRIX_TAB:", PRODUCT_MATRIX_TAB_RAW);
});












