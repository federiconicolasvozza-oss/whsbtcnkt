// index.js
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
const TAB_RENDIR = (process.env.GOOGLE_SHEET_TAB_RENDIR || "Rendir").trim();
const TAB_FOTOS  = (process.env.GOOGLE_SHEET_TAB_FOTOS  || "Fotos").trim();
const GOOGLE_DRIVE_FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim() || null;
const TMP_DIR = process.env.TMP_DIR || "tmp";

const CLIENT_PATH = path.join(process.cwd(), "/etc/secrets/oauth_client.json");
const TOKEN_PATH  = path.join(process.cwd(), "/etc/secrets/oauth_token.json");

/* ============ Estado en memoria por usuario ============ */
/**
 * sessions[wa_id] = {
 *   flow: "rendir" | "fotos" | null,
 *   step: string | null,
 *   data: { op, importe, canal, precinto, contenedor, folderId, uploaded }
 * }
 */
const sessions = new Map();

/* ============ Helpers de WhatsApp ============ */
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

function sendMenu(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "¿Qué necesitás hacer?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "menu_rendir", title: "📋 Rendir operación" } },
          { type: "reply", reply: { id: "menu_fotos",  title: "📸 Enviar fotos" } },
        ],
      },
    },
  });
}

function sendCanales(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "¿Qué canal tuvo la operación?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "canal_rojo",    title: "🟥 Rojo" } },
          { type: "reply", reply: { id: "canal_naranja", title: "🟧 Naranja" } },
          { type: "reply", reply: { id: "canal_verde",   title: "🟩 Verde" } },
        ],
      },
    },
  });
}

function sendConfirmRendir(to, { op, importe, canal }) {
  const body = `🧾 Vas a rendir la operación *${op}*, gasto *$${importe}*, canal *${canal}*. ¿Confirmás?`;
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "rendir_si", title: "✅ Sí" } },
          { type: "reply", reply: { id: "rendir_no", title: "❌ No" } },
        ],
      },
    },
  });
}

function sendConfirmFotos(to, { op, precinto, contenedor }) {
  const body = `🧾 Vas a registrar:\n• Operación: *${op}*\n• Precinto: *${precinto}*\n• Contenedor: *${contenedor}*\n¿Confirmás?`;
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "fotos_si", title: "✅ Sí" } },
          { type: "reply", reply: { id: "fotos_no", title: "❌ No" } },
        ],
      },
    },
  });
}

/* ============ Validaciones ============ */
const isTenDigits = (v) => /^\d{10}$/.test(String(v).trim());
const parseImporte = (v) => {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};
function canalFromId(id) {
  if (id === "canal_rojo") return "Rojo";
  if (id === "canal_naranja") return "Naranja";
  if (id === "canal_verde") return "Verde";
  return "";
}

/* ============ Google OAuth (Sheets & Drive) ============ */
function getOAuthClient() {
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
  if (!hasGoogle()) return;
  const auth = getOAuthClient();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: a1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}
async function recordRendir({ wa_id, op, importe, canal, estado = "registrado" }) {
  await appendToSheetRange(`${TAB_RENDIR}!A1`, [
    new Date().toISOString(),
    wa_id, op, importe, canal, estado,
  ]);
}
async function recordFotos({ wa_id, op, precinto, contenedor, driveFolderId, count, estado = "registrado" }) {
  const link = driveFolderId ? `https://drive.google.com/drive/folders/${driveFolderId}` : "";
  await appendToSheetRange(`${TAB_FOTOS}!A1`, [
    new Date().toISOString(),
    wa_id, op, precinto, contenedor, link, count || 0, estado,
  ]);
}
async function createDriveFolder(name) {
  const auth = getOAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.create({
    resource: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: GOOGLE_DRIVE_FOLDER_ID ? [GOOGLE_DRIVE_FOLDER_ID] : undefined,
    },
    fields: "id, webViewLink",
  });
  return res.data; // { id, webViewLink }
}
async function uploadToDrive(localPath, name, mimeType, folderId) {
  const auth = getOAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.create({
    resource: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  return res.data; // { id, webViewLink }
}

/* ============ Descarga de media WhatsApp ============ */
async function downloadWhatsAppMedia(mediaId, filenameHint = "media") {
  // 1) Obtener metadata (URL firmada)
  const metaRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(await metaRes.text());
  const meta = await metaRes.json(); // { url, mime_type, ... }

  // 2) Descargar binario usando el mismo token
  const binRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!binRes.ok) throw new Error(await binRes.text());

  // 3) Guardar temporalmente
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const mime = meta.mime_type || "application/octet-stream";
  const ext = mime.split("/")[1] || "bin";
  const tmpPath = path.join(TMP_DIR, `${filenameHint}.${ext}`);
  const buf = Buffer.from(await binRes.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);
  return { tmpPath, mimeType: mime };
}

/* ============ Helpers de sesión ============ */
function getSession(wa_id) {
  if (!sessions.has(wa_id)) sessions.set(wa_id, { flow: null, step: null, data: { uploaded: 0 } });
  return sessions.get(wa_id);
}

/* ============ Webhook Verify (GET) ============ */
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

/* ============ Webhook Events (POST) ============ */
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = change?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;
    const session = getSession(from);

    // === Imagen (flujo fotos) ===
    if (type === "image") {
      if (session.flow === "fotos" && session.step === "recibiendo_fotos" && session.data.folderId) {
        try {
          const mediaId = msg.image?.id;
          const { tmpPath, mimeType } = await downloadWhatsAppMedia(mediaId, `OP-${session.data.op}-${Date.now()}`);
          await uploadToDrive(tmpPath, path.basename(tmpPath), mimeType, session.data.folderId);
          fs.unlink(tmpPath, () => {});
          session.data.uploaded = (session.data.uploaded || 0) + 1;
          await sendText(from, `📷 Foto subida (${session.data.uploaded}). Enviá más o escribí *listo* (o *volver* para menú).`);
        } catch (e) {
          console.error("💥 Error subiendo imagen:", e);
          await sendText(from, "⚠️ No pude subir esa imagen. Probá de nuevo.");
        }
      } else {
        await sendText(from, "✅ Imagen recibida. Para *enviar fotos*, elegí esa opción en el menú.");
      }
      return res.sendStatus(200);
    }

    // === Botones ===
    if (type === "interactive") {
      const btn = msg?.interactive?.button_reply?.id;

      // Menu principal
      if (btn === "menu_rendir") {
        sessions.set(from, { flow: "rendir", step: "op", data: {} });
        await sendText(from, "📌 Por favor, indicá el número de operación (10 dígitos).");
        return res.sendStatus(200);
      }
      if (btn === "menu_fotos") {
        sessions.set(from, { flow: "fotos", step: "op", data: { uploaded: 0 } });
        await sendText(from, "📌 Indicá el número de operación (10 dígitos).");
        return res.sendStatus(200);
      }

      // Rendir: canal
      if (session.flow === "rendir" && ["canal_rojo","canal_naranja","canal_verde"].includes(btn)) {
        session.data.canal = canalFromId(btn);
        session.step = "confirm_rendir";
        await sendConfirmRendir(from, session.data);
        return res.sendStatus(200);
      }
      // Rendir: confirmar
      if (session.flow === "rendir" && session.step === "confirm_rendir") {
        if (btn === "rendir_si") {
          await recordRendir({
            wa_id: from,
            op: session.data.op,
            importe: session.data.importe,
            canal: session.data.canal,
            estado: "registrado",
          });
          await sendText(from, "✅ Operación registrada correctamente.");
          sessions.delete(from);
          await sendMenu(from);            // ⬅️ vuelve al menú
        } else {
          await sendText(from, "❌ Operación cancelada.");
          sessions.delete(from);
          await sendMenu(from);            // ⬅️ vuelve al menú
        }
        return res.sendStatus(200);
      }

      // Fotos: confirmar
      if (session.flow === "fotos" && session.step === "confirm_fotos") {
        if (btn === "fotos_si") {
          const folderName = `OP-${session.data.op}`;
          const folder = await createDriveFolder(folderName);
          session.data.folderId = folder.id;
          session.step = "recibiendo_fotos";
          await sendText(from, "Perfecto. 📷 Enviá las fotos. Cuando termines, escribí *listo* (o *volver* para menú).");
        } else {
          await sendText(from, "❌ Registro cancelado.");
          sessions.delete(from);
          await sendMenu(from);            // ⬅️ vuelve al menú
        }
        return res.sendStatus(200);
      }

      // Cualquier otro botón
      await sendMenu(from);
      return res.sendStatus(200);
    }

    // === Texto ===
    if (type === "text") {
      const body = (msg.text?.body || "").trim();

      // Comandos (ahora incluye “menú” con tilde y “volver”)
      if (["hola","menu","menú","inicio","volver"].includes(body.toLowerCase())) {
        sessions.delete(from);
        await sendMenu(from);
        return res.sendStatus(200);
      }

      // Flow: RENDIR
      if (session.flow === "rendir") {
        if (session.step === "op") {
          if (!isTenDigits(body)) {
            await sendText(from, "⚠️ El número debe tener exactamente 10 dígitos. Intentá de nuevo.");
          } else {
            session.data.op = body;
            session.step = "importe";
            await sendText(from, "💰 ¿Cuál fue el importe total de los gastos?");
          }
          return res.sendStatus(200);
        }
        if (session.step === "importe") {
          const n = parseImporte(body);
          if (n === null) {
            await sendText(from, "⚠️ Ingresá un importe válido (número positivo).");
          } else {
            session.data.importe = n;
            session.step = "canal";
            await sendCanales(from);
          }
          return res.sendStatus(200);
        }
        if (session.step === "confirm_rendir") {
          // Si escribe en vez de tocar botón, re-mostramos confirmación
          await sendConfirmRendir(from, session.data);
          return res.sendStatus(200);
        }
      }

      // Flow: FOTOS
      if (session.flow === "fotos") {
        if (session.step === "op") {
          if (!isTenDigits(body)) {
            await sendText(from, "⚠️ El número debe tener exactamente 10 dígitos. Intentá de nuevo.");
          } else {
            session.data.op = body;
            session.step = "precinto";
            await sendText(from, "🔐 ¿Cuál es el número de precinto?");
          }
          return res.sendStatus(200);
        }
        if (session.step === "precinto") {
          session.data.precinto = body;
          session.step = "contenedor";
          await sendText(from, "🚢 ¿Cuál es el número de contenedor?");
          return res.sendStatus(200);
        }
        if (session.step === "contenedor") {
          session.data.contenedor = body;
          session.step = "confirm_fotos";
          await sendConfirmFotos(from, session.data);
          return res.sendStatus(200);
        }
        if (session.step === "recibiendo_fotos") {
          if (body.toLowerCase() === "listo") {
            await recordFotos({
              wa_id: from,
              op: session.data.op,
              precinto: session.data.precinto,
              contenedor: session.data.contenedor,
              driveFolderId: session.data.folderId,
              count: session.data.uploaded || 0,
              estado: "registrado",
            });
            await sendText(from, "✅ Fotos registradas correctamente.");
            sessions.delete(from);
            await sendMenu(from);          // ⬅️ vuelve al menú
          } else {
            await sendText(from, "📷 Enviá imágenes, escribí *listo* para terminar, o *volver* para ir al menú.");
          }
          return res.sendStatus(200);
        }
      }

      // Desvíos
      await sendText(from, "Solo puedo ayudarte a *rendir una operación* o *enviar fotos de carga*. ¿Qué necesitás hacer?");
      await sendMenu(from);
      return res.sendStatus(200);
    }

    // Otros tipos no soportados
    await sendText(from, "ℹ️ Tipo de mensaje no soportado aún. Escribí *menu* para opciones.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("💥 Webhook error:", e);
    return res.sendStatus(200);
  }
});

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en http://localhost:${PORT}`);
  console.log("🔐 Token:", WHATSAPP_TOKEN ? WHATSAPP_TOKEN.slice(0, 10) + "..." : "(vacío)");
  console.log("📞 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "(vacío)");
});











