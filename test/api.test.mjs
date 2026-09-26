import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let PORT;
let ORIGIN;

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function sessionCookie(response) {
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "";
  return setCookie.split(";", 1)[0];
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(url.startsWith("http") ? url : `${ORIGIN}${url}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
}

// Le webhook Stripe est vérifié sur les octets bruts : il faut pouvoir envoyer
// un corps non re-sérialisé, ce que `request` ne permet pas.
async function rawRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  return fetch(url.startsWith("http") ? url : `${ORIGIN}${url}`, {
    ...options,
    headers,
    redirect: "manual",
  });
}

async function waitForServer(process) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) throw new Error("Le serveur de test s’est arrêté avant son démarrage.");
    try {
      const response = await request("/api/health");
      if (response.ok) return;
    } catch {
      // Le socket n’est pas encore prêt.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Délai de démarrage du serveur de test dépassé.");
}

function buildChildEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("QRAFT_")) delete environment[key];
  }
  return Object.assign(environment, {
    QRAFT_PORT: String(PORT),
    QRAFT_HOST: "127.0.0.1",
    QRAFT_PUBLIC_ORIGIN: ORIGIN,
    QRAFT_IDLE_TIMEOUT_MINUTES: "5",
    NODE_ENV: "test",
  }, overrides);
}

async function startServer(environment, logSink) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logSink.value += chunk; });
  child.stderr.on("data", (chunk) => { logSink.value += chunk; });
  await waitForServer(child);
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
}

// Attribue une offre en écrivant directement en base, sur le modèle des
// `scan_events` injectés par le test des agrégats. Le module ne résout pas l'offre
// en cache, donc le changement est visible dès la requête suivante.
function grantPlan(databasePath, email, plan, overrides = {}) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email);
    assert.ok(user, `le compte ${email} doit exister avant d’attribuer l’offre ${plan}`);
    // Le serveur stocke tous ses horodatages en millisecondes.
    const timestamp = Date.now();
    database.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, status, stripe_customer_id, stripe_subscription_id, stripe_price_id,
        current_period_end, cancel_at_period_end, grace_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      plan,
      overrides.status || "active",
      overrides.stripeCustomerId || `cus_test_${user.id}`,
      overrides.stripeSubscriptionId || `sub_test_${user.id}`,
      overrides.stripePriceId || `price_test_${plan}`,
      overrides.currentPeriodEnd === undefined ? timestamp + 30 * 24 * 3_600 * 1_000 : overrides.currentPeriodEnd,
      overrides.cancelAtPeriodEnd ? 1 : 0,
      overrides.graceUntil === undefined ? null : overrides.graceUntil,
      timestamp,
      timestamp,
    );
    return user.id;
  } finally {
    database.close();
  }
}

function setQrcodeActive(databasePath, qrcodeId, isActive) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    database.prepare("UPDATE qrcodes SET is_active = ? WHERE id = ?").run(isActive ? 1 : 0, qrcodeId);
  } finally {
    database.close();
  }
}

function readQrcodeRow(databasePath, qrcodeId) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare("SELECT id, is_active, inactive_scans, public_token, destination FROM qrcodes WHERE id = ?").get(qrcodeId);
  } finally {
    database.close();
  }
}

// Repli brutal sur Découverte : on simule un compte qui a beaucoup de QR codes
// publiés avant l'existence des offres, en les inscrivant directement en base.
function seedQrcodes(databasePath, email, count) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(email);
    assert.ok(user, `le compte ${email} doit exister avant l’injection de QR codes`);
    const timestamp = Date.now();
    const insert = database.prepare(`
      INSERT INTO qrcodes (
        user_id, public_token, name, mode, destination, foreground, background,
        created_at, updated_at, is_active, inactive_scans
      ) VALUES (?, ?, ?, 'link', ?, '#101b33', '#ffffff', ?, ?, 1, 0)
    `);
    const tokens = [];
    for (let index = 0; index < count; index += 1) {
      const token = String(index).padStart(16, "0");
      insert.run(user.id, token, `QR existant ${index}`, `https://example.test/regression/${index}`, timestamp, timestamp);
      tokens.push(token);
    }
    return tokens;
  } finally {
    database.close();
  }
}

async function registerUser(email, password = "MotDePassePlan789", ip = null) {
  const headers = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
  if (ip) headers["X-Forwarded-For"] = ip;
  const response = await request("/api/auth/register", {
    method: "POST",
    headers,
    body: { displayName: "Compte Plan", email, password },
  });
  assert.equal(response.status, 201, `l’inscription de ${email} doit aboutir`);
  const body = await response.json();
  return {
    cookie: sessionCookie(response),
    csrf: body.csrfToken,
    headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
  };
}

test("comptes, isolation des QR codes et statistiques", async () => {
  PORT = await getFreePort();
  ORIGIN = `http://localhost:${PORT}`;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "qraft-test-"));
  const logSink = { value: "" };
  const serverLog = () => logSink.value;
  const databasePath = path.join(temporaryDirectory, "test.sqlite");
  const server = await startServer(buildChildEnvironment({ QRAFT_DB_PATH: databasePath }), logSink);

  try {

    const page = await request("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

    const register = await request("/api/auth/register", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { displayName: "Camille Martin", email: "camille@example.test", password: "MotDePasse123" },
    });
    assert.equal(register.status, 201, serverLog);
    const firstSession = await register.json();
    const firstCookie = sessionCookie(register);
    assert.ok(firstCookie.startsWith("qraft_session="));
    assert.match(register.headers.get("set-cookie"), /HttpOnly/);
    assert.match(register.headers.get("set-cookie"), /SameSite=Strict/);
    assert.ok(firstSession.csrfToken);

    // Ce test porte sur l'isolation des comptes, pas sur les quotas : le compte
    // passe sur Ultra pour que ses QR codes restent sans limite.
    grantPlan(databasePath, "camille@example.test", "ultra");

    const created = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: {
        name: "Menu du vendredi",
        mode: "link",
        destination: "https://example.test/menu",
        foreground: "#101b33",
        background: "#ffffff",
      },
    });
    assert.equal(created.status, 201, serverLog);
    const createdBody = await created.json();
    assert.match(createdBody.qrcode.trackingUrl, /\/r\/[A-Za-z0-9_-]{16}$/);
    const qrcodeId = createdBody.qrcode.id;

    const invalid = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { name: "Insecure", mode: "link", destination: "javascript:alert(1)" },
    });
    assert.equal(invalid.status, 400);

    const malformed = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: null,
    });
    assert.equal(malformed.status, 400);

    const oversized = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: "x".repeat(400_000),
    });
    assert.equal(oversized.status, 413, serverLog);

    const privateDestination = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { name: "Réseau privé", mode: "link", destination: "http://127.0.0.1/admin" },
    });
    assert.equal(privateDestination.status, 400);

    for (const destination of ["http://[::ffff:127.0.0.1]/admin", "http://[0:0:0:0:0:ffff:127.0.0.1]/admin"]) {
      const mappedPrivateDestination = await request("/api/qrcodes", {
        method: "POST",
        cookie: firstCookie,
        csrf: firstSession.csrfToken,
        headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
        body: { name: "IPv6 privé", mode: "link", destination },
      });
      assert.equal(mappedPrivateDestination.status, 400, `Destination acceptée à tort : ${destination}`);
    }

    const lowContrast = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { name: "Contraste insuffisant", mode: "link", destination: "https://example.test/contrast", foreground: "#808080", background: "#808080" },
    });
    assert.equal(lowContrast.status, 400);

    const crossOrigin = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      body: { name: "Cross-site", mode: "link", destination: "https://example.test/cross" },
    });
    assert.equal(crossOrigin.status, 403);

    const publicHostStartingWithPrivatePrefix = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { name: "Domaine public", mode: "link", destination: "https://fcorp.example.test/path" },
    });
    assert.equal(publicHostStartingWithPrivatePrefix.status, 201, serverLog);
    const temporaryQrcode = await publicHostStartingWithPrivatePrefix.json();
    const temporaryDelete = await request(`/api/qrcodes/${temporaryQrcode.qrcode.id}`, {
      method: "DELETE",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(temporaryDelete.status, 200);

    const noCsrf = await request(`/api/qrcodes/${qrcodeId}`, {
      method: "DELETE",
      cookie: firstCookie,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(noCsrf.status, 403);

    const headVisit = await request(createdBody.qrcode.trackingUrl, {
      method: "HEAD",
      headers: { "User-Agent": "qraft-integration-test" },
    });
    assert.equal(headVisit.status, 302);

    const trackedVisit = await request(createdBody.qrcode.trackingUrl, {
      headers: { "User-Agent": "qraft-integration-test" },
    });
    assert.equal(trackedVisit.status, 302);
    assert.equal(trackedVisit.headers.get("location"), "https://example.test/menu");

    const botVisit = await request(createdBody.qrcode.trackingUrl, {
      headers: { "User-Agent": "Googlebot/2.1" },
    });
    assert.equal(botVisit.status, 302);

    const duplicateVisit = await request(createdBody.qrcode.trackingUrl, {
      headers: { "User-Agent": "qraft-integration-test" },
    });
    assert.equal(duplicateVisit.status, 302);

    const stats = await request(`/api/qrcodes/${qrcodeId}/stats?days=30`, {
      cookie: firstCookie,
    });
    assert.equal(stats.status, 200);
    const statsBody = await stats.json();
    assert.equal(statsBody.stats.total, 1);
    assert.equal(statsBody.stats.daily.at(-1).count, 1);

    const updated = await request(`/api/qrcodes/${qrcodeId}`, {
      method: "PUT",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { name: "Menu mis à jour", mode: "link", destination: "https://example.test/menu", foreground: "#186a5a", background: "#e8f7ee" },
    });
    assert.equal(updated.status, 200, serverLog);
    assert.equal((await updated.json()).qrcode.name, "Menu mis à jour");

    const secondRegister = await request("/api/auth/register", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { displayName: "Alex Martin", email: "alex@example.test", password: "AutreMotDePasse456" },
    });
    assert.equal(secondRegister.status, 201, serverLog);
    const secondSession = await secondRegister.json();
    const secondCookie = sessionCookie(secondRegister);
    grantPlan(databasePath, "alex@example.test", "ultra");

    const forbiddenStats = await request(`/api/qrcodes/${qrcodeId}/stats`, {
      cookie: secondCookie,
    });
    assert.equal(forbiddenStats.status, 404);

    const oversizedIdStats = await request(`/api/qrcodes/${"9".repeat(400)}/stats`, {
      cookie: firstCookie,
    });
    assert.equal(oversizedIdStats.status, 404);

    const forbiddenUpdate = await request(`/api/qrcodes/${qrcodeId}`, {
      method: "PUT",
      cookie: secondCookie,
      csrf: secondSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { name: "Tentative", mode: "link", destination: "https://example.test/other" },
    });
    assert.equal(forbiddenUpdate.status, 404);
    const secondLibrary = await request("/api/qrcodes", { cookie: secondCookie });
    assert.deepEqual((await secondLibrary.json()).qrcodes, []);

    const contact = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: {
        name: "Carte Camille",
        mode: "contact",
        contactData: { firstName: "Camille", lastName: "Martin", email: "camille@example.test", address: "Rue de la République, 75001 Paris, France ".repeat(5) },
      },
    });
    assert.equal(contact.status, 201, serverLog);
    const contactBody = await contact.json();
    const contactPage = await request(contactBody.qrcode.trackingUrl, {
      headers: { "User-Agent": "qraft-integration-test" },
    });
    assert.equal(contactPage.status, 200);
    assert.equal(contactPage.headers.get("referrer-policy"), "no-referrer");
    assert.match(await contactPage.text(), /Carte Camille/);
    const vcard = await request(`${contactBody.qrcode.trackingUrl}/vcard`);
    assert.equal(vcard.status, 200);
    assert.match(vcard.headers.get("content-type"), /text\/vcard/);
    const vcardText = await vcard.text();
    assert.match(vcardText, /BEGIN:VCARD/);
    assert.ok(vcardText.split("\r\n").every((line) => Buffer.byteLength(line, "utf8") <= 75));

    const legacyPayload = {
      name: "Migration idempotente",
      mode: "link",
      destination: "https://example.test/legacy",
      legacyKey: "legacy-integration-test-20260925",
    };
    const firstLegacyImport = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: legacyPayload,
    });
    assert.equal(firstLegacyImport.status, 201, serverLog);
    const firstLegacyBody = await firstLegacyImport.json();
    const repeatedLegacyImport = await request("/api/qrcodes", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: legacyPayload,
    });
    assert.equal(repeatedLegacyImport.status, 200);
    assert.equal((await repeatedLegacyImport.json()).qrcode.id, firstLegacyBody.qrcode.id);

    // La même clé d'import reste strictement scoped au compte : le second
    // utilisateur crée son propre QR code au lieu de recevoir celui du premier.
    const otherUserLegacyImport = await request("/api/qrcodes", {
      method: "POST",
      cookie: secondCookie,
      csrf: secondSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: legacyPayload,
    });
    assert.equal(otherUserLegacyImport.status, 201, serverLog);
    const otherUserLegacyBody = await otherUserLegacyImport.json();
    assert.notEqual(otherUserLegacyBody.qrcode.id, firstLegacyBody.qrcode.id);
    assert.notEqual(otherUserLegacyBody.qrcode.trackingUrl, firstLegacyBody.qrcode.trackingUrl);
    assert.match(otherUserLegacyBody.qrcode.trackingUrl, /\/r\/[A-Za-z0-9_-]{16}$/);
    const otherUserLibrary = await request("/api/qrcodes", { cookie: secondCookie });
    const otherUserLibraryBody = await otherUserLibrary.json();
    assert.equal(otherUserLibraryBody.total, 1);
    assert.equal(otherUserLibraryBody.qrcodes[0].id, otherUserLegacyBody.qrcode.id);

    const list = await request("/api/qrcodes", { cookie: firstCookie });
    const listBody = await list.json();
    assert.equal(listBody.total, 3);
    assert.equal(listBody.qrcodes.length, 3);
    assert.equal(listBody.qrcodes.reduce((sum, item) => sum + item.scanCount, 0), 2);

    const logout = await request("/api/auth/logout", {
      method: "POST",
      cookie: firstCookie,
      csrf: firstSession.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: {},
    });
    assert.equal(logout.status, 200);
    const repeatedLogout = await request("/api/auth/logout", {
      method: "POST",
      cookie: firstCookie,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: {},
    });
    assert.equal(repeatedLogout.status, 200);
    assert.match(repeatedLogout.headers.get("set-cookie") || "", /qraft_session=;/);
    const afterLogout = await request("/api/auth/me", { cookie: firstCookie });
    assert.deepEqual(await afterLogout.json(), { user: null, csrfToken: null });

    const unauthenticatedLibrary = await request("/api/qrcodes");
    assert.equal(unauthenticatedLibrary.status, 401);

    const loginAgain = await request("/api/auth/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { email: "camille@example.test", password: "MotDePasse123" },
    });
    assert.equal(loginAgain.status, 200, serverLog);
    const reloginBody = await loginAgain.json();
    const reloginCookie = sessionCookie(loginAgain);
    const reloginLibrary = await request("/api/qrcodes", { cookie: reloginCookie });
    assert.equal((await reloginLibrary.json()).qrcodes.length, 3);

    const logoutWithoutCsrf = await request("/api/auth/logout", {
      method: "POST",
      cookie: reloginCookie,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: {},
    });
    assert.equal(logoutWithoutCsrf.status, 403);
    const sessionAfterCsrfFailure = await request("/api/auth/me", { cookie: reloginCookie });
    assert.equal((await sessionAfterCsrfFailure.json()).user.email, "camille@example.test");

    const logoutWithCsrf = await request("/api/auth/logout", {
      method: "POST",
      cookie: reloginCookie,
      csrf: reloginBody.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: {},
    });
    assert.equal(logoutWithCsrf.status, 200);
  } finally {
    await stopServer(server);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("agrégats de scans, rétention et absence d’adresse IP", async () => {
  PORT = await getFreePort();
  ORIGIN = `http://localhost:${PORT}`;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "qraft-rollup-"));
  const databasePath = path.join(temporaryDirectory, "rollup.sqlite");
  const logSink = { value: "" };
  const environment = buildChildEnvironment({
    QRAFT_DB_PATH: databasePath,
    QRAFT_TRUST_PROXY: "true",
  });
  let server = await startServer(environment, logSink);

  try {
    const register = await request("/api/auth/register", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { displayName: "Sofia Bernard", email: "sofia@example.test", password: "MotDePasseComplet789" },
    });
    assert.equal(register.status, 201, logSink.value);
    const session = await register.json();
    const cookie = sessionCookie(register);

    const created = await request("/api/qrcodes", {
      method: "POST",
      cookie,
      csrf: session.csrfToken,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { name: "Suivi boutique", mode: "link", destination: "https://example.test/suivi" },
    });
    assert.equal(created.status, 201, logSink.value);
    const { qrcode } = await created.json();

    // Trois sources distinctes, dont un Referer qui est une adresse IP privée :
    // cette dernière ne doit jamais apparaître dans les statistiques.
    const visits = [
      { referer: "https://news.example/article", forwarded: "203.0.113.10" },
      { referer: "http://192.168.1.5/box", forwarded: "203.0.113.11" },
      { referer: "https://blog.example/post", forwarded: "203.0.113.12" },
    ];
    for (const visit of visits) {
      const response = await request(qrcode.trackingUrl, {
        headers: {
          "User-Agent": "qraft-integration-test",
          "X-Forwarded-For": visit.forwarded,
          Referer: visit.referer,
        },
      });
      assert.equal(response.status, 302, logSink.value);
    }

    const stats = await request(`/api/qrcodes/${qrcode.id}/stats`, { cookie });
    const statsBody = await stats.json();
    assert.equal(statsBody.stats.total, 3);
    assert.deepEqual(
      statsBody.stats.referrers.map((entry) => entry.host).sort(),
      ["blog.example", "news.example"],
    );

    // Injection d’événements bruts non agrégés (simule une reprise ou une
    // base partiellement migrée), puis redémarrage du serveur.
    await stopServer(server);
    const injection = new DatabaseSync(databasePath);
    const insert = injection.prepare(`
      INSERT INTO scan_events (qrcode_id, scanned_at, device_type, referrer_host)
      VALUES (?, ?, ?, ?)
    `);
    insert.run(qrcode.id, Date.now() - 400 * 24 * 60 * 60 * 1_000, "mobile", "archive.example");
    insert.run(qrcode.id, Date.now() - 60 * 1_000, "mobile", "recent.example");
    injection.close();

    server = await startServer(environment, logSink);
    const statsAfterRestart = await request(`/api/qrcodes/${qrcode.id}/stats`, { cookie });
    const reconciled = await statsAfterRestart.json();
    assert.equal(reconciled.stats.total, 5, "les événements bruts absents des agrégats doivent être réconciliés");

    await stopServer(server);
    const inspection = new DatabaseSync(databasePath);
    const rawEvents = inspection.prepare("SELECT COUNT(*) AS count FROM scan_events").get().count;
    assert.equal(rawEvents, 4, "les événements bruts de plus de 365 jours doivent être purgés");
    const hosts = inspection.prepare("SELECT DISTINCT referrer_host AS host FROM scan_rollups").all().map((row) => row.host);
    assert.ok(
      !hosts.some((host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host))),
      `aucune adresse IP ne doit être conservée : ${JSON.stringify(hosts)}`,
    );
    inspection.close();

    // Un second démarrage ne doit pas compter deux fois les mêmes événements.
    server = await startServer(environment, logSink);
    const statsAfterSecondRestart = await request(`/api/qrcodes/${qrcode.id}/stats`, { cookie });
    const stable = await statsAfterSecondRestart.json();
    assert.equal(stable.stats.total, 5, "la réconciliation des agrégats doit être idempotente");
  } finally {
    await stopServer(server);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("personnalisation du QR code : style, dégradé et logo", async () => {
  PORT = await getFreePort();
  ORIGIN = `http://127.0.0.1:${PORT}`;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "qraft-style-"));
  const databasePath = path.join(temporaryDirectory, "style.sqlite");
  const environment = buildChildEnvironment({ QRAFT_DB_PATH: databasePath });
  const logSink = { value: "" };
  const logo = `data:image/png;base64,${Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64")}`;
  let server;

  try {
    server = await startServer(environment, logSink);

    const registered = await request("/api/auth/register", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { displayName: "Style Test", email: "style@example.test", password: "MotDePasseStyle789" },
    });
    assert.equal(registered.status, 201, logSink.value);
    const session = await registered.json();
    const cookie = sessionCookie(registered);
    const auth = { cookie, csrf: session.csrfToken, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } };

    // Les formes, le dégradé et le logo sont des options Ultra : ce test les
    // vérifie donc sur un compte Ultra. Le refus côté Découverte est couvert par
    // le test des offres.
    grantPlan(databasePath, "style@example.test", "ultra");


    const created = await request("/api/qrcodes", {
      method: "POST",
      ...auth,
      body: {
        name: "QR stylé",
        mode: "link",
        destination: "https://example.test/stylé",
        foreground: "#101b33",
        background: "#ffffff",
        style: { moduleShape: "dot", eyeShape: "leaf", margin: 2, logoSizePct: 28, gradient: { from: "#101b33", to: "#bd3c34", angle: 45 } },
        logo,
      },
    });
    assert.equal(created.status, 201, logSink.value);
    const createdBody = await created.json();
    assert.deepEqual(createdBody.qrcode.style, {
      moduleShape: "dot",
      eyeShape: "leaf",
      margin: 2,
      logoSizePct: 28,
      gradient: { from: "#101b33", to: "#bd3c34", angle: 45 },
    });
    assert.equal(createdBody.qrcode.logo, logo);

    const library = await request("/api/qrcodes", { cookie });
    const stored = (await library.json()).qrcodes.find((entry) => entry.id === createdBody.qrcode.id);
    assert.deepEqual(stored.style, createdBody.qrcode.style, "le style doit être relu depuis la base");
    assert.equal(stored.logo, logo, "le logo doit être relu depuis la base");

    const updated = await request(`/api/qrcodes/${createdBody.qrcode.id}`, {
      method: "PUT",
      ...auth,
      body: {
        name: "QR stylé",
        mode: "link",
        destination: "https://example.test/stylé",
        foreground: "#101b33",
        background: "#ffffff",
        style: { moduleShape: "rounded", eyeShape: "rounded", margin: 6, logoSizePct: 99, gradient: null },
        logo: null,
      },
    });
    assert.equal(updated.status, 200, logSink.value);
    const updatedBody = await updated.json();
    assert.deepEqual(
      updatedBody.qrcode.style,
      { moduleShape: "rounded", eyeShape: "rounded", margin: 6, logoSizePct: 30, gradient: null },
      "une taille de logo hors bornes doit etre ramenee a 30 %",
    );
    assert.equal(updatedBody.qrcode.logo, null);

    const defaults = await request("/api/qrcodes", {
      method: "POST",
      ...auth,
      body: { name: "QR par défaut", mode: "link", destination: "https://example.test/defauts" },
    });
    assert.equal(defaults.status, 201, logSink.value);
    assert.deepEqual(
      (await defaults.json()).qrcode.style,
      { moduleShape: "square", eyeShape: "square", margin: 4, logoSizePct: 22, gradient: null },
      "un style absent doit retomber sur les valeurs par défaut",
    );

    const clamped = await request("/api/qrcodes", {
      method: "POST",
      ...auth,
      body: {
        name: "Marge aberrante",
        mode: "link",
        destination: "https://example.test/marge",
        style: { moduleShape: "inconnu", eyeShape: "inconnu", margin: 99, logoSizePct: 4 },
      },
    });
    assert.equal(clamped.status, 201, logSink.value);
    assert.deepEqual(
      (await clamped.json()).qrcode.style,
    { moduleShape: "square", eyeShape: "square", margin: 8, logoSizePct: 18, gradient: null },
    "les valeurs hors bornes doivent être normalisées",
    );

    const fractionalMargin = await request("/api/qrcodes", {
      method: "POST",
      ...auth,
      body: {
        name: "Marge fractionnaire",
        mode: "link",
        destination: "https://example.test/marge-fractionnaire",
        style: { margin: 2.5 },
      },
    });
    assert.equal(fractionalMargin.status, 201, logSink.value);
    assert.equal(
      (await fractionalMargin.json()).qrcode.style.margin,
      4,
      "une marge non entière doit retomber sur la valeur par défaut",
    );

    const rejections = [
      ["dégradé mal formé", { gradient: { from: "rouge", to: "#bd3c34", angle: 0 } }, 400],
      ["dégradé sans contraste", { gradient: { from: "#fdfdfd", to: "#fefefe", angle: 0 } }, 400],
    ];
    for (const [label, style, expected] of rejections) {
      const response = await request("/api/qrcodes", {
        method: "POST",
        ...auth,
        body: { name: `Rejet ${label}`, mode: "link", destination: "https://example.test/rejet", style },
      });
      assert.equal(response.status, expected, `${label} : ${logSink.value}`);
    }

    const foreignLogo = await request("/api/qrcodes", {
      method: "POST",
      ...auth,
      body: {
        name: "Logo douteux",
        mode: "link",
        destination: "https://example.test/logo",
        logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      },
    });
    assert.equal(foreignLogo.status, 400, "un logo SVG doit être refusé : il est rasterisé côté client");

    const remoteLogo = await request("/api/qrcodes", {
      method: "POST",
      ...auth,
      body: {
        name: "Logo distant",
        mode: "link",
        destination: "https://example.test/logo",
        logo: "https://exemple.test/logo.png",
      },
    });
    assert.equal(remoteLogo.status, 400, "un logo distant doit être refusé");

    const heavyLogo = await request("/api/qrcodes", {
      method: "POST",
      ...auth,
      body: {
        name: "Logo lourd",
        mode: "link",
        destination: "https://example.test/logo",
        logo: `data:image/png;base64,${"A".repeat(240_000)}`,
      },
    });
    assert.equal(heavyLogo.status, 413, "un logo trop volumineux doit être refusé");

    const stillLocal = await request("/api/qrcodes", { cookie });
    assert.equal(
      (await stillLocal.json()).qrcodes.filter((entry) => entry.name.startsWith("Rejet") || entry.name.startsWith("Logo")).length,
      0,
      "aucun QR code ne doit être créé quand la personnalisation est refusée",
    );
  } finally {
    await stopServer(server);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("offres : quotas, QR codes inactifs, régression et grâce de 48 h", async () => {
  PORT = await getFreePort();
  ORIGIN = `http://127.0.0.1:${PORT}`;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "qraft-plan-"));
  const databasePath = path.join(temporaryDirectory, "plan.sqlite");
  const logSink = { value: "" };
  // `QRAFT_TRUST_PROXY` permet de faire varier l’adresse client pour éprouver la
  // déduplication des scans sans dépendre d’un vrai second appareil.
  const environment = buildChildEnvironment({
    QRAFT_DB_PATH: databasePath,
    QRAFT_TRUST_PROXY: "true",
  });
  let server;

  const asClient = (ip) => ({ "User-Agent": "qraft-plan-test", "X-Forwarded-For": ip });

  try {
    server = await startServer(environment, logSink);

    // ── L'offre Découverte est l'état par défaut ──────────────────────────────
    const free = await registerUser("decouverte@example.test", undefined, "10.9.0.1");

    const me = await request("/api/auth/me", { cookie: free.cookie });
    const meBody = await me.json();
    assert.equal(meBody.entitlement.plan, "decouverte");
    assert.equal(meBody.entitlement.maxQrcodes, 5);
    assert.equal(meBody.entitlement.maxActive, 1);
    assert.equal(meBody.entitlement.statsDays, 30);
    assert.equal(meBody.entitlement.canCreate, true);
    assert.equal(meBody.entitlement.canActivate, true);
    assert.equal(meBody.entitlement.overQuota, false);

    const firstCreate = await request("/api/qrcodes", {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { name: "Premier", mode: "link", destination: "https://example.test/premier" },
    });
    assert.equal(firstCreate.status, 201, logSink.value);
    const firstQrcode = (await firstCreate.json()).qrcode;
    assert.equal(firstQrcode.isActive, true);
    assert.equal(firstQrcode.statsDays, 30);

    // Le quota d'actifs prime : un seul QR code actif à la fois.
    const secondCreate = await request("/api/qrcodes", {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { name: "Second", mode: "link", destination: "https://example.test/second" },
    });
    assert.equal(secondCreate.status, 402, logSink.value);
    assert.equal((await secondCreate.json()).error.code, "active_limit_reached");

    // ── La route de statut exige un booléen explicite ─────────────────────────
    const ambiguousStatus = await request(`/api/qrcodes/${firstQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: {},
    });
    assert.equal(ambiguousStatus.status, 400, "un corps vide ne doit jamais basculer un QR code");
    assert.equal(readQrcodeRow(databasePath, firstQrcode.id).is_active, 1);

    const wrongType = await request(`/api/qrcodes/${firstQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { active: 1 },
    });
    assert.equal(wrongType.status, 400, "un entier n’est pas un booléen");

    const statusWithoutCsrf = await request(`/api/qrcodes/${firstQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      headers: free.headers,
      body: { active: false },
    });
    assert.equal(statusWithoutCsrf.status, 403);

    // ── Un QR code désactivé renvoie 410 sur les trois routes publiques ───────
    const deactivated = await request(`/api/qrcodes/${firstQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { active: false },
    });
    assert.equal(deactivated.status, 200, logSink.value);
    assert.equal((await deactivated.json()).qrcode.isActive, false);

    const inactiveVisit = await request(firstQrcode.trackingUrl, { headers: asClient("10.1.0.1") });
    assert.equal(inactiveVisit.status, 410, "un QR code désactivé doit répondre 410, pas rediriger");
    assert.match(inactiveVisit.headers.get("cache-control") || "", /no-store/);
    assert.match(
      inactiveVisit.headers.get("cache-control") || "",
      /must-revalidate/,
      "un 410 mis en cache deviendrait un mur définitif après réactivation",
    );
    assert.match(await inactiveVisit.text(), /désactivé/i);

    // La redirection est coupée mais les agrégats ne sont pas touchés par la visite.
    const statsAfterInactive = await request(`/api/qrcodes/${firstQrcode.id}/stats`, { cookie: free.cookie });
    assert.equal((await statsAfterInactive.json()).stats.total, 0, "une visite sur un QR inactif ne doit pas être mesurée");

    const repeatInactiveVisit = await request(firstQrcode.trackingUrl, { headers: asClient("10.1.0.1") });
    assert.equal(repeatInactiveVisit.status, 410);
    assert.equal(
      readQrcodeRow(databasePath, firstQrcode.id).inactive_scans,
      1,
      "deux scans rapprochés depuis le même client ne comptent qu’une fois",
    );

    await request(firstQrcode.trackingUrl, { headers: asClient("10.1.0.2") });
    assert.equal(
      readQrcodeRow(databasePath, firstQrcode.id).inactive_scans,
      2,
      "un second client doit être compté : c’est la preuve chiffrée du manque à gagner",
    );

    // ── Réactivation : même jeton, même destination, historiques intacts ───────
    const retryCreate = await request("/api/qrcodes", {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { name: "Second", mode: "link", destination: "https://example.test/second" },
    });
    assert.equal(retryCreate.status, 201, logSink.value);
    const secondQrcode = (await retryCreate.json()).qrcode;

    const reactivateWhileFull = await request(`/api/qrcodes/${firstQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { active: true },
    });
    assert.equal(reactivateWhileFull.status, 402, "la place active est déjà prise");
    assert.equal(readQrcodeRow(databasePath, firstQrcode.id).is_active, 0, "un refus ne doit pas modifier l’état");

    await request(`/api/qrcodes/${secondQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { active: false },
    });

    const reactivated = await request(`/api/qrcodes/${firstQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { active: true },
    });
    assert.equal(reactivated.status, 200, logSink.value);
    assert.equal((await reactivated.json()).qrcode.isActive, true);

    const rowAfterReactivation = readQrcodeRow(databasePath, firstQrcode.id);
    assert.equal(
      rowAfterReactivation.public_token,
      firstQrcode.trackingUrl.split("/").pop(),
      "la réactivation ne doit jamais changer le jeton public : un QR imprimé resterait valide",
    );
    assert.equal(rowAfterReactivation.destination, "https://example.test/premier");
    assert.equal(
      rowAfterReactivation.inactive_scans,
      2,
      "le compteur de scans perdus est conservé, pas remis à zéro",
    );

    const backToWork = await request(firstQrcode.trackingUrl, { headers: asClient("10.1.0.3") });
    assert.equal(backToWork.status, 302, "la redirection doit revenir à l’identique");
    assert.equal(backToWork.headers.get("location"), "https://example.test/premier");
    const statsAfterReactivation = await request(`/api/qrcodes/${firstQrcode.id}/stats`, { cookie: free.cookie });
    assert.equal((await statsAfterReactivation.json()).stats.total, 1);

    // ── Un QR de contact désactivé perd aussi sa vCard ───────────────────────
    await request(`/api/qrcodes/${firstQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { active: false },
    });
    const contactCreate = await request("/api/qrcodes", {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: {
        name: "Carte",
        mode: "contact",
        contactData: { firstName: "Alex", lastName: "Durand", email: "alex@example.test" },
      },
    });
    assert.equal(contactCreate.status, 201, logSink.value);
    const contactQrcode = (await contactCreate.json()).qrcode;
    await request(`/api/qrcodes/${contactQrcode.id}/status`, {
      method: "POST",
      cookie: free.cookie,
      csrf: free.csrf,
      headers: free.headers,
      body: { active: false },
    });
    assert.equal((await request(contactQrcode.trackingUrl, { headers: asClient("10.1.0.4") })).status, 410);
    assert.equal((await request(`${contactQrcode.trackingUrl}/vcard`, { headers: asClient("10.1.0.5") })).status, 410);

    // ── Le quota de stockage se compte séparément du quota d’actifs ────────────
    const regression = await registerUser("regression@example.test", undefined, "10.9.0.2");
    seedQrcodes(databasePath, "regression@example.test", 12);
    const regressionLibrary = await request("/api/qrcodes", { cookie: regression.cookie });
    const regressionBody = await regressionLibrary.json();
    assert.equal(regressionBody.entitlement.used, 12);
    assert.equal(regressionBody.entitlement.usedActive, 12);
    assert.equal(regressionBody.entitlement.overQuota, true, "12 QR codes sous un quota de 5 doit être signalé");

    // Rien n’est bloqué, rien n’est supprimé, rien n’est désactivé d’office.
    const firstSeeded = regressionBody.qrcodes[0];
    assert.equal(
      (await request(firstSeeded.trackingUrl, { headers: asClient("10.2.0.1") })).status,
      302,
      "un QR code existant doit continuer à fonctionner hors quota",
    );
    assert.equal((await request(`/api/qrcodes/${firstSeeded.id}/stats`, { cookie: regression.cookie })).status, 200);
    const stillEditable = await request(`/api/qrcodes/${firstSeeded.id}`, {
      method: "PUT",
      cookie: regression.cookie,
      csrf: regression.csrf,
      headers: regression.headers,
      body: { name: "Renommé", mode: "link", destination: "https://example.test/renomme" },
    });
    assert.equal(stillEditable.status, 200, "l’édition ne doit jamais être bloquée par un quota");
    const stillDeletable = await request(`/api/qrcodes/${firstSeeded.id}`, {
      method: "DELETE",
      cookie: regression.cookie,
      csrf: regression.csrf,
      headers: regression.headers,
    });
    assert.equal(stillDeletable.status, 200);

    const createWhileOverQuota = await request("/api/qrcodes", {
      method: "POST",
      cookie: regression.cookie,
      csrf: regression.csrf,
      headers: regression.headers,
      body: { name: "Refusé", mode: "link", destination: "https://example.test/refuse" },
    });
    assert.equal(createWhileOverQuota.status, 409, "un compte hors quota ne peut plus créer");
    assert.equal((await createWhileOverQuota.json()).error.code, "qrcode_limit_reached");

    const activateWhileOverQuota = await request(`/api/qrcodes/${regressionBody.qrcodes[1].id}/status`, {
      method: "POST",
      cookie: regression.cookie,
      csrf: regression.csrf,
      headers: regression.headers,
      body: { active: true },
    });
    assert.equal(activateWhileOverQuota.status, 200, "activer un QR déjà actif est idempotent");

    const database2 = new DatabaseSync(databasePath);
    const activeCount = database2
      .prepare("SELECT COUNT(*) AS count FROM qrcodes WHERE user_id = (SELECT id FROM users WHERE email = 'regression@example.test') AND is_active = 1")
      .get().count;
    database2.close();
    assert.equal(activeCount, 11, "aucune désactivation automatique ne doit suivre un retour sur Découverte");

    // ── Le quota de 5 QR codes stockés bloque la création ─────────────────────
    const stored = await registerUser("stocke@example.test", undefined, "10.9.0.3");
    const createStored = async (index) => {
      const response = await request("/api/qrcodes", {
        method: "POST",
        cookie: stored.cookie,
        csrf: stored.csrf,
        headers: stored.headers,
        body: { name: `Stocké ${index}`, mode: "link", destination: `https://example.test/stocke/${index}` },
      });
      return response;
    };
    for (let index = 0; index < 5; index += 1) {
      const response = await createStored(index);
      assert.equal(response.status, 201, `le QR code ${index + 1}/5 doit passer : ${logSink.value}`);
      const created = (await response.json()).qrcode;
      await request(`/api/qrcodes/${created.id}/status`, {
        method: "POST",
        cookie: stored.cookie,
        csrf: stored.csrf,
        headers: stored.headers,
        body: { active: false },
      });
    }
    const sixth = await createStored(5);
    assert.equal(sixth.status, 409, "le sixième QR code stocké doit être refusé");
    assert.equal((await sixth.json()).error.code, "qrcode_limit_reached");

    // ── La personnalisation payante est refusée en 402, sans rien créer ────────
    const logo = `data:image/png;base64,${Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ).toString("base64")}`;
    const premiumAttempts = [
      ["forme dot", { style: { moduleShape: "dot" } }],
      ["œil leaf", { style: { eyeShape: "leaf" } }],
      ["dégradé", { style: { gradient: { from: "#101b33", to: "#bd3c34", angle: 45 } } }],
      ["logo", { logo }],
    ];
    for (const [label, extra] of premiumAttempts) {
      const response = await request("/api/qrcodes", {
        method: "POST",
        cookie: regression.cookie,
        csrf: regression.csrf,
        headers: regression.headers,
        body: { name: `Premium ${label}`, mode: "link", destination: "https://example.test/premium", ...extra },
      });
      assert.equal(response.status, 402, `${label} doit être refusé en 402 : ${logSink.value}`);
      assert.equal((await response.json()).error.code, "plan_upgrade_required");
    }
    const regressionAfterAttempts = await request("/api/qrcodes", { cookie: regression.cookie });
    assert.equal(
      (await regressionAfterAttempts.json()).qrcodes.filter((entry) => entry.name.startsWith("Premium")).length,
      0,
      "un refus de personnalisation ne doit créer aucun QR code",
    );

    // ── Une personnalisation déjà enregistrée reste modifiable ────────────────
    const upgraded = await registerUser("reconstitue@example.test", undefined, "10.9.0.4");
    grantPlan(databasePath, "reconstitue@example.test", "ultra");
    const premiumCreate = await request("/api/qrcodes", {
      method: "POST",
      cookie: upgraded.cookie,
      csrf: upgraded.csrf,
      headers: upgraded.headers,
      body: {
        name: "Ultra",
        mode: "link",
        destination: "https://example.test/ultra",
        style: { moduleShape: "dot", eyeShape: "leaf", gradient: { from: "#101b33", to: "#bd3c34", angle: 45 } },
        logo,
      },
    });
    assert.equal(premiumCreate.status, 201, logSink.value);
    const premiumQrcode = (await premiumCreate.json()).qrcode;

    const database3 = new DatabaseSync(databasePath);
    database3.prepare("DELETE FROM subscriptions WHERE user_id = (SELECT id FROM users WHERE email = 'reconstitue@example.test')").run();
    database3.close();

    const editAfterDowngrade = await request(`/api/qrcodes/${premiumQrcode.id}`, {
      method: "PUT",
      cookie: upgraded.cookie,
      csrf: upgraded.csrf,
      headers: upgraded.headers,
      body: {
        name: "Ultra renommé",
        mode: "link",
        destination: "https://example.test/ultra-renomme",
        style: { moduleShape: "dot", eyeShape: "leaf", gradient: { from: "#101b33", to: "#bd3c34", angle: 45 } },
        logo,
      },
    });
    assert.equal(
      editAfterDowngrade.status,
      200,
      "après un retour sur Découverte, un QR code déjà personnalisé doit rester modifiable : ${logSink.value}",
    );

    const stricterAfterDowngrade = await request(`/api/qrcodes/${premiumQrcode.id}`, {
      method: "PUT",
      cookie: upgraded.cookie,
      csrf: upgraded.csrf,
      headers: upgraded.headers,
      body: {
        name: "Ultra",
        mode: "link",
        destination: "https://example.test/ultra",
        style: { moduleShape: "dot", eyeShape: "leaf", margin: 6, gradient: null },
        logo,
      },
    });
    assert.equal(
      stricterAfterDowngrade.status,
      402,
      "retirer une option payante doit rester autorisé",
    );

    // ── La rétention des statistiques suit l’offre ───────────────────────────
    const freeStats = await request(`/api/qrcodes/${firstQrcode.id}/stats?days=365`, { cookie: free.cookie });
    const freeStatsBody = await freeStats.json();
    assert.equal(freeStatsBody.maxStatsDays, 30);
    assert.equal(freeStatsBody.stats.periodDays, 30, "Découverte est plafonné à 30 jours");

    const ultraUser = await registerUser("ultra@example.test", undefined, "10.9.0.5");
    grantPlan(databasePath, "ultra@example.test", "ultra");
    const ultraCreate = await request("/api/qrcodes", {
      method: "POST",
      cookie: ultraUser.cookie,
      csrf: ultraUser.csrf,
      headers: ultraUser.headers,
      body: { name: "Longue période", mode: "link", destination: "https://example.test/longue" },
    });
    const ultraQrcode = (await ultraCreate.json()).qrcode;
    const ultraStats = await request(`/api/qrcodes/${ultraQrcode.id}/stats?days=365`, { cookie: ultraUser.cookie });
    const ultraStatsBody = await ultraStats.json();
    assert.equal(ultraStatsBody.maxStatsDays, 730);
    assert.equal(ultraStatsBody.stats.periodDays, 365);

    const ultraQuota = await request("/api/qrcodes", { cookie: ultraUser.cookie });
    const ultraEntitlement = (await ultraQuota.json()).entitlement;
    assert.equal(ultraEntitlement.maxQrcodes, null, "null signifie illimité");
    assert.equal(ultraEntitlement.maxActive, null);
    assert.equal(ultraEntitlement.canCreate, true);
    assert.equal(ultraEntitlement.canActivate, true);
    assert.equal(ultraEntitlement.statsDays, 730);

    // ── La grâce de 48 h ─────────────────────────────────────────────────────
    const graced = await registerUser("grace@example.test", undefined, "10.9.0.6");
    const graceMs = 48 * 3_600 * 1_000;
    const periodEnd = Date.now() + 24 * 3_600 * 1_000;
    grantPlan(databasePath, "grace@example.test", "pro", {
      status: "canceled",
      currentPeriodEnd: periodEnd,
      graceUntil: periodEnd + graceMs,
    });
    const duringGrace = await request("/api/qrcodes", { cookie: graced.cookie });
    assert.equal(
      (await duringGrace.json()).entitlement.plan,
      "pro",
      "les droits sont conservés pendant la grâce de 48 h après la fin de période",
    );

    const database4 = new DatabaseSync(databasePath);
    database4
      .prepare("UPDATE subscriptions SET grace_until = ? WHERE user_id = (SELECT id FROM users WHERE email = 'grace@example.test')")
      .run(Date.now() - 1);
    database4.close();
    const afterGrace = await request("/api/qrcodes", { cookie: graced.cookie });
    assert.equal(
      (await afterGrace.json()).entitlement.plan,
      "decouverte",
      "la grâce est de 48 h pile, puis le compte revient sur Découverte",
    );

    // Un Checkout abandonné n’accorde aucun droit.
    const incomplete = await registerUser("incomplete@example.test", undefined, "10.9.0.7");
    grantPlan(databasePath, "incomplete@example.test", "ultra", { status: "incomplete" });
    const incompleteLibrary = await request("/api/qrcodes", { cookie: incomplete.cookie });
    assert.equal((await incompleteLibrary.json()).entitlement.plan, "decouverte");

    // Un impayé en cours de relance ne doit pas retirer l’accès.
    const pastDue = await registerUser("impaye@example.test", undefined, "10.9.0.8");
    grantPlan(databasePath, "impaye@example.test", "pro", { status: "past_due", graceUntil: null });
    const pastDueLibrary = await request("/api/qrcodes", { cookie: pastDue.cookie });
    assert.equal((await pastDueLibrary.json()).entitlement.plan, "pro", "past_due reste couvert");
  } finally {
    await stopServer(server);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("facturation : offres refusées sans configuration, devis Entreprise et webhooks signés", async () => {
  PORT = await getFreePort();
  ORIGIN = `http://127.0.0.1:${PORT}`;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "qraft-billing-"));
  const databasePath = path.join(temporaryDirectory, "billing.sqlite");
  const logSink = { value: "" };
  let server;

  const readLeads = () => {
    const database = new DatabaseSync(databasePath);
    try {
      return database.prepare("SELECT * FROM enterprise_leads ORDER BY id").all();
    } finally {
      database.close();
    }
  };

  try {
    // ── Serveur sans aucune variable Stripe ───────────────────────────────
    server = await startServer(buildChildEnvironment({ QRAFT_DB_PATH: databasePath }), logSink);
    const user = await registerUser("facture@example.test", undefined, "10.9.1.1");

    const offers = await request("/api/billing/offers");
    assert.equal(offers.status, 200, "la page des offres reste lisible sans Stripe");
    const offersBody = await offers.json();
    assert.equal(offersBody.enabled, false);
    assert.equal(offersBody.configured, false);
    assert.equal(offersBody.webhooks, false);
    assert.equal(offersBody.taxEnabled, true, "Stripe Tax reste le mode de facturation annoncé");
    assert.deepEqual(
      Object.keys(offersBody.offers),
      ["decouverte", "pro", "ultra", "entreprise"],
      "les quatre offres sont publiées même sans configuration",
    );
    assert.equal(offersBody.offers.entreprise.quote, true);
    assert.equal(offersBody.offers.pro.price, null, "aucun prix ne doit être inventé");
    assert.ok(offersBody.offers.ultra.features.includes("Logo au centre"));

    const anonymousCheckout = await request("/api/billing/checkout", {
      method: "POST",
      headers: user.headers,
      body: { plan: "pro" },
    });
    assert.equal(anonymousCheckout.status, 401, "le paiement exige une session");

    const withoutCsrf = await request("/api/billing/checkout", {
      method: "POST",
      cookie: user.cookie,
      headers: user.headers,
      body: { plan: "pro" },
    });
    assert.equal(withoutCsrf.status, 403, "le jeton CSRF est exigé");

    const unconfigured = await request("/api/billing/checkout", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      headers: user.headers,
      body: { plan: "pro" },
    });
    assert.equal(unconfigured.status, 503, logSink.value);
    assert.equal((await unconfigured.json()).error.code, "billing_not_configured");

    const portal = await request("/api/billing/portal", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      headers: user.headers,
    });
    assert.equal(portal.status, 503, "le portail suit la même règle");

    const webhook = await rawRequest("/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evt_sans_config", type: "invoice.paid" }),
    });
    assert.equal(webhook.status, 503, "aucun webhook sans secret configuré");
    assert.equal((await webhook.json()).error.code, "webhooks_not_configured");

    // Découverte et Entreprise ne sont pas achetables en ligne.
    for (const plan of ["decouverte", "entreprise"]) {
      const refused = await request("/api/billing/checkout", {
        method: "POST",
        cookie: user.cookie,
        csrf: user.csrf,
        headers: user.headers,
        body: { plan },
      });
      assert.equal(refused.status, 400, `l’offre ${plan} ne doit pas être achetable`);
      assert.equal((await refused.json()).error.code, "plan_not_purchasable");
    }

    const badSession = await request("/api/billing/confirm", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      headers: user.headers,
      body: { sessionId: "pas-une-session" },
    });
    assert.equal(badSession.status, 400, "une référence de session mal formée est rejetée");

    // ── Demande de devis Entreprise ───────────────────────────────────────
    const shortMessage = await request("/api/billing/enterprise", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "10.9.1.1" },
      body: { company: "Mairie de Test", email: "achats@example.test", message: "vite" },
    });
    assert.equal(shortMessage.status, 400, "une demande vide de contexte est refusée");

    const badEmail = await request("/api/billing/enterprise", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "10.9.1.1" },
      body: { company: "Mairie de Test", email: "pas-un-email", message: "Nous déployons 4 000 QR codes." },
    });
    assert.equal(badEmail.status, 400, "l’adresse e-mail est validée");

    const lead = await request("/api/billing/enterprise", {
      method: "POST",
      cookie: user.cookie,
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "10.9.1.1" },
      body: {
        company: "Mairie de Test",
        contactName: "Camille Dupont",
        email: "achats@example.test",
        phone: "+33 1 00 00 00 00",
        volume: "4 000",
        message: "Nous déployons 4 000 QR codes sur les agents de la mairie.",
      },
    });
    assert.equal(lead.status, 201, logSink.value);
    assert.deepEqual(await lead.json(), { received: true }, "la réponse ne reprend aucun champ saisi");

    const leads = readLeads();
    assert.equal(leads.length, 1);
    assert.equal(leads[0].company, "Mairie de Test");
    assert.equal(leads[0].email, "achats@example.test");
    assert.ok(leads[0].user_id, "le compte connecté est rattaché à la demande");

    // Un visiteur non connecté peut aussi demander un devis.
    const guestLead = await request("/api/billing/enterprise", {
      method: "POST",
      headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "10.9.1.2" },
      body: { company: "Groupe Invite", email: "contact@invite.test", message: "Besoin d’une offre illimitée." },
    });
    assert.equal(guestLead.status, 201);
    assert.equal(readLeads()[1].user_id, null, "une demande anonyme reste anonyme");

    // Le quota par IP arrête le remplissage automatique.
    let limited = 0;
    for (let index = 0; index < 6; index += 1) {
      const attempt = await request("/api/billing/enterprise", {
        method: "POST",
        headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "10.9.1.9" },
        body: { company: "Remplissage", email: "spam@example.test", message: "Message de remplissage automatique." },
      });
      if (attempt.status === 429) limited += 1;
    }
    assert.ok(limited > 0, "le quota de demandes par IP doit finir par s’appliquer");

    await stopServer(server);

    // ── Serveur configuré (clé factice, aucun appel réseau atteint) ───────
    const stripe = (await import("stripe")).default;
    const webhookSecret = "whsec_test_qraft";
    const SECRET_KEY = "sk_test_qraft_SONDE_1234567890";
    server = await startServer(
      buildChildEnvironment({
        QRAFT_DB_PATH: databasePath,
        QRAFT_STRIPE_SECRET_KEY: SECRET_KEY,
        QRAFT_STRIPE_WEBHOOK_SECRET: webhookSecret,
        QRAFT_STRIPE_PRICE_PRO: "price_test_pro",
        QRAFT_STRIPE_PRICE_ULTRA: "price_test_ultra",
      }),
      logSink,
    );

    // Le double abonnement est refusé avant tout appel à Stripe.
    grantPlan(databasePath, "facture@example.test", "pro", { status: "active" });
    const alreadySubscribed = await request("/api/billing/checkout", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      headers: user.headers,
      body: { plan: "ultra" },
    });
    assert.equal(alreadySubscribed.status, 409, logSink.value);
    assert.equal((await alreadySubscribed.json()).error.code, "subscription_already_active");

    // ── Webhooks : signature obligatoire, idempotence ─────────────────────
    const payload = JSON.stringify({
      id: "evt_test_signature",
      type: "invoice.paid",
      data: { object: { id: "in_test" } },
    });

    const noSignature = await rawRequest("/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    assert.equal(noSignature.status, 400, "un événement non signé est rejeté");
    assert.equal((await noSignature.json()).error.code, "invalid_webhook_signature");

    const wrongSecret = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_secret_du_mauvais_cote",
    });
    const forged = await rawRequest("/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": wrongSecret },
      body: payload,
    });
    assert.equal(forged.status, 400, "une signature forgée est rejetée");

    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    const accepted = await rawRequest("/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
      body: payload,
    });
    assert.equal(accepted.status, 200, logSink.value);
    assert.deepEqual(await accepted.json(), { received: true });

    const replayed = await rawRequest("/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
      body: payload,
    });
    assert.equal(replayed.status, 200, "une redelivraison ne doit pas échouer");
    assert.deepEqual(
      await replayed.json(),
      { received: true, duplicate: true },
      "le même event_id n’est traité qu’une fois",
    );

    const tampered = await rawRequest("/api/billing/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
      body: payload.replace("invoice.paid", "customer.subscription.deleted"),
    });
    assert.equal(tampered.status, 400, "un corps modifié invalide la signature");

    // ── Aucune clé ne doit jamais atteindre le journal ──────────────────────
    logSink.value = "";
    const leakedKey = await request("/api/billing/portal", {
      method: "POST",
      cookie: user.cookie,
      csrf: user.csrf,
      headers: user.headers,
    });
    assert.ok(leakedKey.status >= 400, "une clé Stripe factice doit faire échouer l’appel");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      logSink.value.includes(SECRET_KEY),
      false,
      "la clé secrète ne doit jamais être écrite dans le journal",
    );
    assert.equal(
      logSink.value.includes(webhookSecret),
      false,
      "le secret de webhook ne doit jamais être écrit dans le journal",
    );
    assert.ok(!JSON.stringify(await leakedKey.json()).includes("sk_"), "la réponse au client ne doit rien divulguer");
  } finally {
    await stopServer(server);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
