/ index.js - Bot de Cotizaciones de Fletes (adaptado del original)
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
          { type: "reply", reply: { id: "menu_cotizar", title: "💰 Cotizar" } },
          { type: "reply", reply: { id: "menu_consultar", title: "📋 Consultar" } },
        ],
      },
    },
  });
}





