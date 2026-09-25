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

test("comptes, isolation des QR codes et statistiques", async () => {
  PORT = await getFreePort();
  ORIGIN = `http://localhost:${PORT}`;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "qraft-test-"));
  const logSink = { value: "" };
  const serverLog = () => logSink.value;
  const server = await startServer(buildChildEnvironment({
    QRAFT_DB_PATH: path.join(temporaryDirectory, "test.sqlite"),
  }), logSink);

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
      body: "x".repeat(70_000),
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
