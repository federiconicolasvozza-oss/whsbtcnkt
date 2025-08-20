// whoami.cjs
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CLIENT_PATH = path.join(__dirname, "credentials", "oauth_client.json");
const TOKEN_PATH  = path.join(__dirname, "credentials", "oauth_token.json");

(async () => {
  const creds = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf8"));
  const web = creds.installed || creds.web;
  const oauth2 = new google.auth.OAuth2(web.client_id, web.client_secret, web.redirect_uris[0]);
  oauth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
  const drive = google.drive({ version: "v3", auth: oauth2 });
  const { data } = await drive.about.get({ fields: "user" });
  console.log(`Autenticado como: ${data.user.displayName} <${data.user.emailAddress}>`);
})();
