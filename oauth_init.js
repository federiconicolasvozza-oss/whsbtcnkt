// oauth_init.js
const fs = require("fs");
const path = require("path");
const http = require("http");
const { exec } = require("child_process"); // Para abrir navegador en Windows
const { google } = require("googleapis");

// Rutas de archivos
const CLIENT_PATH = path.join(__dirname, "credentials", "oauth_client.json");
const TOKEN_PATH = path.join(__dirname, "credentials", "oauth_token.json");

// Scopes que vamos a pedir
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

// Función para abrir el navegador
function openInBrowser(url) {
  exec(`start "" "${url}"`); // Windows
}

// Carga el cliente OAuth desde el archivo descargado
function loadClient() {
  const raw = fs.readFileSync(CLIENT_PATH, "utf-8");
  const { installed } = JSON.parse(raw);
  if (!installed) throw new Error("oauth_client.json no es de tipo 'Desktop'.");
  return installed;
}

// Main
async function main() {
  const { client_id, client_secret, redirect_uris } = loadClient();
  const redirectUri = redirect_uris[0] || "http://127.0.0.1:5173";
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/")) return;
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get("code");

    if (!code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("Faltó el parámetro code.");
    }

    const { tokens } = await oauth2.getToken(code);
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>✅ Listo. Ya podés cerrar esta pestaña.</h2>");

    console.log("✅ Token guardado en:", TOKEN_PATH);
    server.close();
  });

  server.listen(0, () => {
    const { port } = server.address();
    const local = new URL(redirectUri);
    local.port = String(port);
    oauth2.redirectUri = local.toString();

    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
    });

    console.log("🌐 Abriendo navegador para autorizar…");
    console.log("Si no se abre solo, copiá y pegá esta URL en tu navegador:");
    console.log(authUrl);

    openInBrowser(authUrl);
  });
}

main().catch(console.error);
