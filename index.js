import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { chromium } from "playwright";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  let client;
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    client = new google.auth.OAuth2();
    client.setCredentials(token);
  } catch {
    client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(client.credentials, null, 2));
  }
  return client;
}

// ===== Gmail helpers =====
async function getOrCreateLabelId(gmail, labelName) {
  const res = await gmail.users.labels.list({ userId: "me" });
  const found = (res.data.labels || []).find((l) => l.name === labelName);
  if (found) return found.id;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return created.data.id;
}

function decodeBody(partBody) {
  const str = partBody.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(str, "base64").toString("utf-8");
}

function extractUrlsFromHtml(html) {
  const re = /https?:\/\/[^\s"'<>()]+/gi;
  const matches = html.match(re) || [];
  const filtered = matches.filter((u) => {
    try {
      const url = new URL(u);
      return (
        URL_DOMAIN_FILTER.length === 0 ||
        URL_DOMAIN_FILTER.includes(url.hostname.toLowerCase())
      );
    } catch {
      return false;
    }
  });
  return [...new Set(filtered)];
}

async function fetchMessageFull(gmail, id) {
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  return res.data;
}

function getSender(headers) {
  const h = headers.find((x) => x.name.toLowerCase() === "from");
  return h?.value || "";
}

function getHtmlFromPayload(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }
  if (payload.mimeType?.startsWith("multipart/") && payload.parts?.length) {
    for (const p of payload.parts) {
      const html = getHtmlFromPayload(p);
      if (html) return html;
    }
  }
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body.data); // fallback
  }
  return "";
}

// ===== Playwright (ajusta clics según tu caso) =====
async function processUrlInBrowser(url) {
  console.log(`➡️  Abriendo: ${url}`);
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Ejemplo 1: botón "Restablecer"
  try {
    const btn = page.getByText(/Restablecer/i);
    if (await btn.count()) {
      await btn.first().click();
      console.log("✅ Clic en 'Restablecer'");
    }
  } catch {}

  // Ejemplo 2: botón "Publicar"
  try {
    const btn = page.getByText(/^Publicar$/i);
    if (await btn.count()) {
      await btn.first().click();
      console.log("✅ Clic en 'Publicar'");
    }
  } catch {}

  await browser.close();
}

// ===== Lógica principal =====
async function runOnce() {
  const auth = await authorize();
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.list({
    userId: "me",
    q: GMAIL_QUERY,
    maxResults: 10,
  });
  const messages = res.data.messages || [];
  if (!messages.length) {
    console.log("No hay mensajes que coincidan con el filtro.");
    return;
  }

  const processedLabelId = await getOrCreateLabelId(gmail, PROCESSED_LABEL_NAME);

  for (const m of messages) {
    const full = await fetchMessageFull(gmail, m.id);
    const headers = full.payload.headers || [];
    const from = getSender(headers);

    if (SENDER_FILTER && !from.toLowerCase().includes(SENDER_FILTER.toLowerCase())) {
      console.log(`↷ Saltando ${m.id} (remitente ${from} no coincide).`);
      continue;
    }

    const html = getHtmlFromPayload(full.payload);
    const urls = extractUrlsFromHtml(html).slice(0, 2); // solo 2
    if (!urls.length) {
      console.log(`↷ Mensaje ${m.id} sin URLs válidas.`);
    } else {
      console.log(`📎 Mensaje ${m.id} → URLs:`, urls);
      for (const u of urls) {
        await processUrlInBrowser(u);
      }
    }

    await gmail.users.messages.modify({
      userId: "me",
      id: m.id,
      requestBody: {
        addLabelIds: [processedLabelId],
        removeLabelIds: ["UNREAD"],
      },
    });
    console.log(`✅ Mensaje ${m.id} marcado como leído + etiquetado.`);
  }
}

async function main() {
  if (POLL_INTERVAL_MS > 0) {
    console.log(`⏱️  Polling cada ${POLL_INTERVAL_MS} ms...`);
    while (true) {
      try {
        await runOnce();
      } catch (e) {
        console.error("Error en ciclo:", e?.message || e);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  } else {
    await runOnce();
  }
}

main().catch((e) => console.error(e));

