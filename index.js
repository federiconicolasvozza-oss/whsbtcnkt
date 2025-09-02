// index.js - Bot de Cotizaciones de Fletes (adaptado del original)
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ===================== ENV (100% Compatible con el original) ===================== */
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "botconektar123").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const API_VERSION = "v23.0";

const GOOGLE_SHEETS_ID = (process.env.GOOGLE_SHEETS_ID || "").trim();
// Reutilizamos las variables existentes pero las adaptamos para cotizaciones
const TAB_COTIZACIONES = (process.env.GOOGLE_SHEET_TAB_RENDIR || "Cotizaciones").trim(); // Reutiliza la pestaña de Rendir
const TAB_CONSULTAS = (process.env.GOOGLE_SHEET_TAB_FOTOS || "Consultas").trim(); // Reutiliza la pestaña de Fotos
const GOOGLE_DRIVE_FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim() || null;
const TMP_DIR = process.env.TMP_DIR || "tmp";

/* ========= Rutas de credenciales (CÓDIGO ORIGINAL SIN CAMBIOS) ========= */
function chooseCredPath(filename) {
  const fromSecrets = path.join("/etc/secrets", filename); // Render Secret Files
  const fromRepo    = path.join(process.cwd(), "credentials", filename); // Tu repo
  try {
    fs.accessSync(fromSecrets);
    return fromSecrets;
  } catch {}
  return fromRepo;
}
const CLIENT_PATH = chooseCredPath("oauth_client.json");
const TOKEN_PATH  = chooseCredPath("oauth_token.json");

/* ============ Estado en memoria por usuario (adaptado para cotizaciones) ============ */
/**
 * sessions[wa_id] = {
 *   flow: "cotizar" | "consultar" | null,
 *   step: string | null,
 *   data: { empresa, modo, maritimo_tipo, contenedor, origen_puerto, destino_puerto, etc. }
 * }
 */
const sessions = new Map();

/* ============ Helpers de WhatsApp (adaptados para cotizaciones) ============ */
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

// NUEVO: Menú principal adaptado para cotizaciones
function sendMenu(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "¡Bienvenido al Cotizador de Fletes de Conektar S.A.! 👋\n\n¿Qué necesitás hacer?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "menu_cotizar", title: "💰 Cotizar flete" } },
          { type: "reply", reply: { id: "menu_consultar", title: "📋 Consultar cotización" } },
        ],
      },
    },
  });
}

// NUEVO: Botones para seleccionar modo de transporte
function sendModos(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "¿Qué tipo de flete querés cotizar?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "modo_maritimo", title: "🚢 Marítimo" } },
          { type: "reply", reply: { id: "modo_aereo", title: "✈️ Aéreo" } },
          { type: "reply", reply: { id: "modo_terrestre", title: "🚚 Terrestre" } },
        ],
      },
    },
  });
}

// NUEVO: Botones para tipo de flete marítimo
function sendTiposMaritimo(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Marítimo seleccionado. ¿Es carga consolidada (LCL) o contenedor completo (FCL)?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "mar_lcl", title: "LCL (Consolidado)" } },
          { type: "reply", reply: { id: "mar_fcl", title: "FCL (Completo)" } },
        ],
      },
    },
  });
}

// NUEVO: Botones para tipo de contenedor FCL
function sendContenedores(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Elegí el tipo de contenedor:" },
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

// NUEVO: Confirmación de cotización
function sendConfirmCotizar(to, data) {
  let detalle = "";
  if (data.modo === 'maritimo') {
    detalle += `• Tipo: ${data.maritimo_tipo || 'No definido'}\n`;
    if (data.maritimo_tipo === 'FCL') detalle += `• Contenedor: ${data.contenedor || 'No definido'}\n`;
    detalle += `• Ruta: ${data.origen_puerto || '?'} ➡️ ${data.destino_puerto || '?'}`;
  } else if (data.modo === 'aereo') {
    detalle += `• Ruta: ${data.origen_aeropuerto || '?'} ➡️ ${data.destino_aeropuerto || '?'}`;
  } else if (data.modo === 'terrestre') {
    detalle += `• Ruta: ${data.origen_direccion || '?'} ➡️ ${data.destino_direccion || '?'}`;
  }

  const body = `🧾 Revisá los datos:\n• Empresa: *${data.empresa}*\n• Modo: *${data.modo}*\n${detalle}\n\nIncoterm: FOB\n¿Confirmás para cotizar?`;
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "cotiz_si", title: "✅ Sí" } },
          { type: "reply", reply: { id: "cotiz_no", title: "❌ No" } },
        ],
      },
    },
  });
}

// NUEVO: Upsell de despacho aduanero
function sendUpsellDespacho(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "¿Sabías que también ofrecemos despacho aduanero? ¿Te interesaría cotizarlo?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "upsell_si", title: "Sí, cotizar" } },
          { type: "reply", reply: { id: "upsell_no", title: "No, gracias" } },
        ],
      },
    },
  });
}

/* ============ Validaciones (adaptadas) ============ */
const isValidEmpresa = (v) => String(v).trim().length >= 2;

function modoFromId(id) {
  if (id === "modo_maritimo") return "maritimo";
  if (id === "modo_aereo") return "aereo";
  if (id === "modo_terrestre") return "terrestre";
  return "";
}

function tipoMaritimoFromId(id) {
  if (id === "mar_lcl") return "LCL";
  if (id === "mar_fcl") return "FCL";
  return "";
}

function contenedorFromId(id) {
  if (id === "cont_20") return "1×20' ST";
  if (id === "cont_40") return "1×40' ST";
  if (id === "cont_40hc") return "1×40' HC";
  return "";
}

/* ============ Google OAuth (CÓDIGO ORIGINAL SIN CAMBIOS) ============ */
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
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://127.0.0.1"
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
  } catch {
    return false;
  }
}

async function appendToSheetRange(a1, values) {
  if (!hasGoogle()) {
    console.warn("⚠️ Google deshabilitado (faltan credenciales o GOOGLE_SHEETS_ID)");
    return;
  }
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

// NUEVO: Guardar cotización (reemplaza recordRendir)
async function recordCotizacion({ wa_id, empresa, modo, maritimo_tipo, contenedor, origen, destino, tarifa, moneda, estado = "cotizado" }) {
  await appendToSheetRange(`${TAB_COTIZACIONES}!A1`, [
    new Date().toISOString(),
    wa_id, empresa, modo, maritimo_tipo || "", contenedor || "", origen || "", destino || "", tarifa || 0, moneda || "USD", estado,
  ]);
  console.log("✅ Cotización grabada en Sheets");
}

// NUEVO: Guardar consulta (reemplaza recordFotos)
async function recordConsulta({ wa_id, empresa, consulta, estado = "recibida" }) {
  await appendToSheetRange(`${TAB_CONSULTAS}!A1`, [
    new Date().toISOString(),
    wa_id, empresa, consulta, "", "", "", "", 0, "", estado,
  ]);
  console.log("✅ Consulta registrada en Sheets");
}

// NUEVO: Motor de tarifas (placeholder)
function calcularTarifa(data) {
  console.log("Calculando tarifa para:", data);
  let tarifa = 1000; // Tarifa base
  let unidad = "";
  
  if (data.modo === 'maritimo') {
    if (data.maritimo_tipo === 'FCL') {
      if (data.contenedor === '1×40 HC') {
        tarifa = 3250;
        unidad = "por contenedor";
      } else if (data.contenedor === '1×40 ST') {
        tarifa = 3000;
        unidad = "por contenedor";
      } else { // 1x20
        tarifa = 2100;
        unidad = "por contenedor";
      }
    } else { // LCL
      tarifa = 150;
      unidad = "por CBM";
    }
  } else if (data.modo === 'aereo') {
    tarifa = 4.5;
    unidad = "por KG";
  } else { // terrestre
    tarifa = 800;
    unidad = "por envío";
  }
  
  return { valor: tarifa, moneda: "USD", unidad, validez_dias: 7 };
}

/* ============ Helpers de sesión (CÓDIGO ORIGINAL SIN CAMBIOS) ============ */
function getSession(wa_id) {
  if (!sessions.has(wa_id)) sessions.set(wa_id, { flow: null, step: null, data: {} });
  return sessions.get(wa_id);
}

/* ============ Webhook Verify (GET - CÓDIGO ORIGINAL SIN CAMBIOS) ============ */
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

/* ============ Webhook Events (POST - LÓGICA PRINCIPAL ADAPTADA) ============ */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = change?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;
    const session = getSession(from);

    // === Imagen (para consultas futuras) ===
    if (type === "image") {
      await sendText(from, "✅ Imagen recibida. Para consultas específicas, usá la opción *Consultar cotización* del menú.");
      return res.sendStatus(200);
    }

    // === Botones ===
    if (type === "interactive") {
      const btn = msg?.interactive?.button_reply?.id;

      // Menú principal
      if (btn === "menu_cotizar") {
        sessions.set(from, { flow: "cotizar", step: "empresa", data: {} });
        await sendText(from, "📌 Para empezar, decime el nombre de tu empresa.");
        return res.sendStatus(200);
      }
      if (btn === "menu_consultar") {
        sessions.set(from, { flow: "consultar", step: "empresa", data: {} });
        await sendText(from, "📌 Decime el nombre de tu empresa para registrar tu consulta.");
        return res.sendStatus(200);
      }

      // Cotizar: modo de transporte
      if (session.flow === "cotizar" && ["modo_maritimo","modo_aereo","modo_terrestre"].includes(btn)) {
        session.data.modo = modoFromId(btn);
        if (session.data.modo === 'maritimo') {
          session.step = "maritimo_tipo";
          await sendTiposMaritimo(from);
        } else if (session.data.modo === 'aereo') {
          session.step = "aereo_ruta";
          await sendText(from, "✈️ Indicá AEROPUERTO de ORIGEN y DESTINO (código IATA o ciudad).\n\nEjemplo:\nORIGEN: PVG (Shanghai)\nDESTINO: EZE (Buenos Aires)");
        } else { // terrestre
          session.step = "terrestre_ruta";
          await sendText(from, "🚚 Indicá ORIGEN y DESTINO con ciudad y país.\n\nEjemplo:\nORIGEN: Sao Paulo, Brasil\nDESTINO: Buenos Aires, Argentina");
        }
        return res.sendStatus(200);
      }

      // Cotizar: tipo marítimo
      if (session.flow === "cotizar" && ["mar_lcl","mar_fcl"].includes(btn)) {
        session.data.maritimo_tipo = tipoMaritimoFromId(btn);
        if (session.data.maritimo_tipo === 'FCL') {
          session.step = "contenedor";
          await sendContenedores(from);
        } else { // LCL
          session.step = "maritimo_ruta";
          await sendText(from, "🚢 Indicá PUERTO de ORIGEN y DESTINO.\n\nEjemplo:\nORIGEN: Shanghai, China\nDESTINO: Buenos Aires, Argentina");
        }
        return res.sendStatus(200);
      }

      // Cotizar: contenedor
      if (session.flow === "cotizar" && ["cont_20","cont_40","cont_40hc"].includes(btn)) {
        session.data.contenedor = contenedorFromId(btn);
        session.step = "maritimo_ruta";
        await sendText(from, "🚢 Indicá PUERTO de ORIGEN y DESTINO.\n\nEjemplo:\nORIGEN: Shanghai, China\nDESTINO: Buenos Aires, Argentina");
        return res.sendStatus(200);
      }

      // Cotizar: confirmar
      if (session.flow === "cotizar" && session.step === "confirm_cotizar") {
        if (btn === "cotiz_si") {
          try {
            const tarifaInfo = calcularTarifa(session.data);
            const origen = session.data.origen_puerto || session.data.origen_aeropuerto || session.data.origen_direccion;
            const destino = session.data.destino_puerto || session.data.destino_aeropuerto || session.data.destino_direccion;
            
            await recordCotizacion({
              wa_id: from,
              empresa: session.data.empresa,
              modo: session.data.modo,
              maritimo_tipo: session.data.maritimo_tipo,
              contenedor: session.data.contenedor,
              origen: origen,
              destino: destino,
              tarifa: tarifaInfo.valor,
              moneda: tarifaInfo.moneda,
              estado: "cotizado",
            });
            
            const tarifaMsg = `✅ *Tarifa estimada:*\n${tarifaInfo.moneda} ${tarifaInfo.valor} ${tarifaInfo.unidad} (FOB)\n\n*Validez:* ${tarifaInfo.validez_dias} días\n*Nota:* No incluye impuestos ni gastos locales.`;
            await sendText(from, tarifaMsg);
            
            sessions.delete(from);
            await sendUpsellDespacho(from);
          } catch (err) {
            console.error("❌ Error en recordCotizacion:", err);
            await sendText(from, "⚠️ No pude registrar la cotización. Intentá más tarde.");
            sessions.delete(from);
            await sendMenu(from);
          }
        } else {
          await sendText(from, "❌ Cotización cancelada.");
          sessions.delete(from);
          await sendMenu(from);
        }
        return res.sendStatus(200);
      }

      // Upsell despacho
      if (["upsell_si","upsell_no"].includes(btn)) {
        if (btn === "upsell_si") {
          await sendText(from, "¡Excelente! Para cotizar el despacho aduanero, contactate con nuestro equipo comercial:\n📧 comercial@conektar.com\n📱 Respondé a este mensaje para que un representante te asista.");
        } else {
          await sendText(from, "Entendido. ¡Gracias por cotizar con Conektar S.A.! 👋\n\nEscribí *menu* cuando necesites una nueva cotización.");
        }
        sessions.delete(from);
        return res.sendStatus(200);
      }

      // Cualquier otro botón
      await sendMenu(from);
      return res.sendStatus(200);
    }

    // === Texto ===
    if (type === "text") {
      const body = (msg.text?.body || "").trim();

      // Comandos globales
      if (["hola","menu","menú","inicio","volver","cotizar"].includes(body.toLowerCase())) {
        sessions.delete(from);
        await sendMenu(from);
        return res.sendStatus(200);
      }

      // Flow: COTIZAR
      if (session.flow === "cotizar") {
        if (session.step === "empresa") {
          if (!isValidEmpresa(body)) {
            await sendText(from, "⚠️ Por favor, ingresá un nombre de empresa válido (mínimo 2 caracteres).");
          } else {
            session.data.empresa = body;
            session.step = "modo";
            await sendModos(from);
          }
          return res.sendStatus(200);
        }
        
        if (session.step === "maritimo_ruta") {
          // Extraer origen y destino del texto
          const origenMatch = body.match(/ORIGEN:\s*(.+?)(?:\n|DESTINO:)/i);
          const destinoMatch = body.match(/DESTINO:\s*(.+)/i);
          
          if (origenMatch && destinoMatch) {
            session.data.origen_puerto = origenMatch[1].trim();
            session.data.destino_puerto = destinoMatch[1].trim();
            session.step = "confirm_cotizar";
            await sendConfirmCotizar(from, session.data);
          } else {
            await sendText(from, "⚠️ Por favor, seguí el formato:\nORIGEN: [puerto/ciudad]\nDESTINO: [puerto/ciudad]");
          }
          return res.sendStatus(200);
        }
        
        if (session.step === "aereo_ruta") {
          const origenMatch = body.match(/ORIGEN:\s*(.+?)(?:\n|DESTINO:)/i);
          const destinoMatch = body.match(/DESTINO:\s*(.+)/i);
          
          if (origenMatch && destinoMatch) {
            session.data.origen_aeropuerto = origenMatch[1].trim();
            session.data.destino_aeropuerto = destinoMatch[1].trim();
            session.step = "confirm_cotizar";
            await sendConfirmCotizar(from, session.data);
          } else {
            await sendText(from, "⚠️ Por favor, seguí el formato:\nORIGEN: [aeropuerto/ciudad]\nDESTINO: [aeropuerto/ciudad]");
          }
          return res.sendStatus(200);
        }
        
        if (session.step === "terrestre_ruta") {
          const origenMatch = body.match(/ORIGEN:\s*(.+?)(?:\n|DESTINO:)/i);
          const destinoMatch = body.match(/DESTINO:\s*(.+)/i);
          
          if (origenMatch && destinoMatch) {
            session.data.origen_direccion = origenMatch[1].trim();
            session.data.destino_direccion = destinoMatch[1].trim();
            session.step = "confirm_cotizar";
            await sendConfirmCotizar(from, session.data);
          } else {
            await sendText(from, "⚠️ Por favor, seguí el formato:\nORIGEN: [ciudad, país]\nDESTINO: [ciudad, país]");
          }
          return res.sendStatus(200);
        }
        
        if (session.step === "confirm_cotizar") {
          await sendConfirmCotizar(from, session.data);
          return res.sendStatus(200);
        }
      }

      // Flow: CONSULTAR
      if (session.flow === "consultar") {
        if (session.step === "empresa") {
          if (!isValidEmpresa(body)) {
            await sendText(from, "⚠️ Por favor, ingresá un nombre de empresa válido (mínimo 2 caracteres).");
          } else {
            session.data.empresa = body;
            session.step = "consulta";
            await sendText(from, "📝 Escribí tu consulta o pregunta sobre fletes y logística.");
          }
          return res.sendStatus(200);
        }
        
        if (session.step === "consulta") {
          try {
            await recordConsulta({
              wa_id: from,
              empresa: session.data.empresa,
              consulta: body,
              estado: "recibida",
            });
            await sendText(from, "✅ Tu consulta ha sido registrada correctamente.\n\nNuestro equipo comercial te contactará pronto para darte una respuesta personalizada.\n\n📧 comercial@conektar.com");
            sessions.delete(from);
            await sendMenu(from);
          } catch (err) {
            console.error("❌ Error en recordConsulta:", err);
            await sendText(from, "⚠️ No pude registrar tu consulta. Intentá más tarde.");
            sessions.delete(from);
            await sendMenu(from);
          }
          return res.sendStatus(200);
        }
      }

      // Mensaje por defecto
      await sendText(from, "No entendí esa parte. Escribí *menu* para ver las opciones disponibles.");
      return res.sendStatus(200);
    }

    // Otros tipos no soportados
    await sendText(from, "ℹ️ Tipo de mensaje no soportado. Escribí *menu* para ver las opciones.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ============ Start (CÓDIGO ORIGINAL SIN CAMBIOS) ============ */
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en http://localhost:${PORT}`);
  console.log("🔐 Token:", WHATSAPP_TOKEN ? WHATSAPP_TOKEN.slice(0, 10) + "..." : "(vacío)");
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
  console.log("📄 Credenciales usadas:", { CLIENT_PATH, TOKEN_PATH });
});



