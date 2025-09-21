// index.js
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import playwright from "playwright";

dotenv.config();
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ===== Config =====
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

const GMAIL_QUERY = process.env.GMAIL_QUERY || "label:inbox is:unread newer_than:7d";
const SENDER_FILTER = (process.env.SENDER_FILTER || "").trim();
const URL_DOMAIN_FILTER = (process.env.URL_DOMAIN_FILTER || "forms.google.com,docs.google.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 0);
const PROCESSED_LABEL_NAME = "processed-by-bot";

// ===== Auth =====
async function authorize() {
  // lee la app (client_id/secret/redirect_uris) de credentials.json
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const installed = creds.installed || creds.web;
  const client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris?.[0]
  );

  // intenta usar token.json si existe
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    client.setCredentials(token);
    return client;
  } catch {
    // primera vez: abre el flujo de consentimiento
    const authed = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
    // guarda los credenciales (access/refresh) para siguientes corridas
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(authed.credentials, null, 2));
    // copia los creds al cliente que sí tiene client_id/secret
    client.setCredentials(authed.credentials);
    return client;
  }
}


// ===== Helpers =====
function decodeBase64Url(data) {
  const buff = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buff.toString("utf-8");
}

function extractUrls(text, allowedDomains) {
  const urlRegex = /(https?:\/\/[^\s"'<>\)\]]+)/gi;
  const found = new Set();
  let m;
  while ((m = urlRegex.exec(text)) !== null) {
    try {
      const u = new URL(m[1]);
      if (allowedDomains.some((d) => u.hostname.toLowerCase().includes(d))) {
        found.add(u.toString());
      }
    } catch {}
  }
  return Array.from(found);
}

async function ensureLabel(gmail, name) {
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const match = (data.labels || []).find((l) => l.name === name);
  if (match) return match.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id;
}

async function markProcessed(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: ["UNREAD"], // opcional: marcar leído
    },
  });
}

// ===== Playwright action =====
async function automateUrl(url) {
  console.log(`➡️  Abriendo: ${url}`);
  const browser = await playwright.chromium.launch({ headless: false }); // true si no quieres ver la UI
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Intenta click en “Restablecer”
    const resetSelectors = [
      "text=Restablecer",
      "button:has-text('Restablecer')",
      "span:has-text('Restablecer')",
      "[role='button']:has-text('Restablecer')",
    ];
    for (const sel of resetSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        console.log("✅ Click en 'Restablecer'");
        break;
      }
    }

    // Si también quieres "Publicar", descomenta:
    // const publish = await page.$("text=Publicar");
    // if (publish) { await publish.click(); console.log("✅ Click en 'Publicar'"); }

    // espera corta para que se apliquen acciones
    await page.waitForTimeout(1500);
  } catch (e) {
    console.error("❌ Error Playwright:", e.message);
  } finally {
    await browser.close();
  }
}

// ===== Core =====
async function processOnce() {
  const auth = await authorize();
  const gmail = google.gmail({ version: "v1", auth });
  const processedLabelId = await ensureLabel(gmail, PROCESSED_LABEL_NAME);

  // Busca mensajes
  const list = await gmail.users.messages.list({ userId: "me", q: GMAIL_QUERY, maxResults: 10 });
  const msgs = list.data.messages || [];
  if (!msgs.length) {
    console.log("📭 Sin mensajes que coincidan.");
    return;
  }

  for (const { id } of msgs) {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });

    // Filtrar remitente si se especificó
    const headers = msg.data.payload?.headers || [];
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
    if (SENDER_FILTER && !from.toLowerCase().includes(SENDER_FILTER.toLowerCase())) {
      console.log(`↪️  Remitente no coincide (${from}). Saltando.`);
      continue;
    }

    // Obtener texto del correo (body)
    let bodyText = "";
    function dig(part) {
      if (!part) return;
      if (part.body?.data) bodyText += decodeBase64Url(part.body.data) + "\n";
      (part.parts || []).forEach(dig);
    }
    dig(msg.data.payload);

    // Extraer URLs
    const urls = extractUrls(bodyText, URL_DOMAIN_FILTER).slice(0, 2);
    if (!urls.length) {
      console.log("🔎 Sin URLs válidas en este correo.");
      await markProcessed(gmail, id, processedLabelId);
      continue;
    }

    // Automatizar por cada URL (hasta 2)
    for (const url of urls) {
      await automateUrl(url);
    }

    // Marcar procesado
    await markProcessed(gmail, id, processedLabelId);
    console.log(`🏷️  Marcado como procesado: ${id}`);
  }
}

async function main() {
  if (POLL_INTERVAL_MS > 0) {
    console.log(`⏳ Iniciando en bucle cada ${POLL_INTERVAL_MS} ms...`);
    // bucle
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { await processOnce(); } catch (e) { console.error(e); }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  } else {
    await processOnce(); // una sola pasada
  }
}

main().catch(console.error);
