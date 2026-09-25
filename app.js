(() => {
  "use strict";

  const STORAGE_KEY = "qraft-qr-history";
  const MAX_LEGACY_IMPORT = 50;
  const MAX_LEGACY_ATTEMPTS = 3;
  const defaultLink = "https://qraft.example/hello";

  const state = {
    mode: "link",
    foreground: "#101b33",
    background: "#ffffff",
    currentQr: null,
    currentPayload: "",
    currentLabel: "",
    history: [],
    legacyHistory: [],
    user: null,
    csrfToken: null,
    currentRecordId: null,
    trackingUrl: null,
    contentDirty: false,
    isDirty: false,
    isSaving: false,
    activeStatsId: null,
    updateTimer: null,
    toastTimer: null,
    editRevision: 0,
    migrationPromise: null,
    migrationUserId: null,
    lastMigrationSkipped: 0,
    sessionEpoch: 0,
    authAttempt: 0,
    isLoggingOut: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function isCurrentSession(userId, epoch) {
    return Boolean(state.user && state.user.id === userId && state.sessionEpoch === epoch);
  }

  function describeMigration(migrated) {
    const parts = [];
    if (migrated > 0) {
      parts.push(`${migrated} QR code${migrated > 1 ? "s" : ""} local${migrated > 1 ? "aux" : ""} transféré${migrated > 1 ? "s" : ""}`);
    }
    if (state.lastMigrationSkipped > 0) {
      parts.push(`${state.lastMigrationSkipped} ignoré${state.lastMigrationSkipped > 1 ? "s" : ""} définitivement`);
    }
    return parts.length ? `${parts.join(" · ")}.` : "";
  }

  function markEditorDirty(contentDirty = false) {
    state.editRevision += 1;
    if (contentDirty) state.contentDirty = true;
    state.isDirty = true;
    updateSaveState();
  }

  const elements = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindEvents();
    renderHistory();
    updatePreview();
    try {
      await restoreSession();
    } catch (error) {
      if (error.status === 401) return;
      console.error("Session restore failed", error);
      showToast("Le serveur n’est pas disponible. Rechargez la page.");
    }
    window.addEventListener("load", () => {
      updatePreview();
      renderHistory();
    }, { once: true });
  }

  function cacheElements() {
    elements.linkInput = $("#linkInput");
    elements.linkValid = $("#linkValid");
    elements.linkContent = $("#linkContent");
    elements.contactContent = $("#contactContent");
    elements.qrNameInput = $("#qrNameInput");
    elements.foregroundColor = $("#foregroundColor");
    elements.backgroundColor = $("#backgroundColor");
    elements.foregroundValue = $("#foregroundValue");
    elements.backgroundValue = $("#backgroundValue");
    elements.colorCount = $("#colorCount");
    elements.previewTypeLabel = $("#previewTypeLabel");
    elements.previewLabel = $("#previewLabel");
    elements.qrCanvas = $("#qrCanvas");
    elements.historyGrid = $("#historyGrid");
    elements.historyCount = $("#historyCount");
    elements.libraryMetrics = $("#libraryMetrics");
    elements.metricQrCount = $("#metricQrCount");
    elements.metricScanCount = $("#metricScanCount");
    elements.metricWeekCount = $("#metricWeekCount");
    elements.saveButton = $("#saveButton");
    elements.trackingStatus = $("#trackingStatus");
    elements.guestActions = $("#guestActions");
    elements.userActions = $("#userActions");
    elements.userName = $("#userName");
    elements.userAvatar = $("#userAvatar");
    elements.authModal = $("#authModal");
    elements.authError = $("#authError");
    elements.loginForm = $("#loginForm");
    elements.registerForm = $("#registerForm");
    elements.statsModal = $("#statsModal");
    elements.toast = $("#toast");
    elements.toastMessage = $("#toastMessage");
    elements.copyLabel = $("#copyLabel");
  }

  function bindEvents() {
    $$(".mode-button").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });

    $$("[data-sample]").forEach((button) => {
      button.addEventListener("click", () => {
        elements.linkInput.value = button.dataset.sample;
        setMode("link");
        scheduleUpdate();
        showToast("Exemple chargé — votre aperçu est à jour.");
      });
    });

    $$("#createur input").forEach((input) => {
      input.addEventListener("input", () => {
        if (input.type === "color") {
          setColor(input.id === "foregroundColor" ? "foreground" : "background", input.value);
        } else if (input.id === "qrNameInput") {
          markEditorDirty(false);
        } else {
          markEditorDirty(true);
          scheduleUpdate();
        }
      });
    });

    $$(".preset").forEach((button) => {
      button.addEventListener("click", () => {
        state.foreground = button.dataset.fg;
        state.background = button.dataset.bg;
        markEditorDirty(false);
        syncColorInputs();
        $$(".preset").forEach((preset) => preset.classList.toggle("active", preset === button));
        updatePreview();
      });
    });

    $(".custom-color").addEventListener("click", () => elements.foregroundColor.focus());
    $("#resetButton").addEventListener("click", resetBuilder);
    elements.saveButton.addEventListener("click", saveCurrentQr);
    $("#downloadPng").addEventListener("click", downloadPng);
    $("#downloadSvg").addEventListener("click", downloadSvg);
    $("#copyContent").addEventListener("click", copyContent);

    elements.linkInput.addEventListener("blur", () => {
      const previousValue = elements.linkInput.value;
      const normalizedValue = normalizeUrl(previousValue);
      if (normalizedValue === previousValue) return;
      elements.linkInput.value = normalizedValue;
      markEditorDirty(true);
      scheduleUpdate();
    });

    $("#loginButton").addEventListener("click", () => openAuthModal("login"));
    $("#registerButton").addEventListener("click", () => openAuthModal("register"));
    $("#logoutButton").addEventListener("click", logout);
    $$("[data-auth-mode]").forEach((button) => {
      button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
    });
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.registerForm.addEventListener("submit", handleRegister);
    $$("[data-close-modal]").forEach((button) => {
      button.addEventListener("click", () => closeModal(button.dataset.closeModal));
    });
    $$(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) closeModal(backdrop.id);
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!elements.statsModal.hidden) closeModal("statsModal");
        else if (!elements.authModal.hidden) closeModal("authModal");
      }
    });

    elements.historyGrid.addEventListener("click", handleHistoryAction);
  }

  function setMode(mode, options = {}) {
    state.mode = mode === "contact" ? "contact" : "link";
    if (options.markDirty !== false) {
      markEditorDirty(true);
    }
    $$(".mode-button").forEach((button) => {
      const isActive = button.dataset.mode === state.mode;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    const isLink = state.mode === "link";
    elements.linkContent.classList.toggle("active", isLink);
    elements.linkContent.hidden = !isLink;
    elements.contactContent.classList.toggle("active", !isLink);
    elements.contactContent.hidden = isLink;
    updatePreview();
    updateSaveState();
  }

  function scheduleUpdate() {
    window.clearTimeout(state.updateTimer);
    state.updateTimer = window.setTimeout(updatePreview, 90);
  }

  function updatePreview() {
    const rawPayload = state.mode === "link" ? getLinkPayload() : getContactPayload();
    const useTrackedPayload = state.currentRecordId && state.trackingUrl && !state.contentDirty;
    const encodedPayload = useTrackedPayload ? state.trackingUrl : rawPayload;
    const label = getDisplayLabel(rawPayload);

    state.currentPayload = encodedPayload;
    state.currentLabel = label;

    if (state.mode === "link") {
      const isValid = rawPayload.length > 0 && isLikelyUrl(elements.linkInput.value);
      elements.linkInput.classList.toggle("invalid", !isValid);
      elements.linkValid.textContent = isValid ? "✓" : "!";
      elements.linkValid.style.color = isValid ? "#2f7655" : "#bd3c34";
    } else {
      elements.linkInput.classList.remove("invalid");
    }

    elements.previewTypeLabel.textContent = state.mode === "link" ? "LINK" : "VCARD";
    elements.previewLabel.textContent = label;

    state.currentQr = createQr(encodedPayload);
    if (state.currentQr) {
      drawQr(elements.qrCanvas, state.currentQr, 1024, state.foreground, state.background);
    } else {
      drawFallback(elements.qrCanvas, state.foreground, state.background);
    }

    updateColorLabels();
    updateSaveState();
  }

  function getLinkPayload() {
    return normalizeUrl(elements.linkInput.value) || defaultLink;
  }

  function getContactPayload() {
    const firstName = value("firstNameInput");
    const lastName = value("lastNameInput");
    const company = value("companyInput");
    const phone = value("phoneInput");
    const email = value("emailInput");
    const website = value("contactWebsiteInput");
    const address = value("addressInput");

    if (!firstName && !lastName && !company && !phone && !email && !website && !address) {
      return "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Votre carte de visite\r\nEND:VCARD";
    }

    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const lines = ["BEGIN:VCARD", "VERSION:3.0"];

    if (firstName || lastName) {
      lines.push(`N:${escapeVCard(lastName)};${escapeVCard(firstName)};;;`);
    }
    const fallbackName = company || phone || email || website || address || "Contact";
    if (fullName || fallbackName) lines.push(`FN:${escapeVCard(fullName || fallbackName)}`);
    if (company) lines.push(`ORG:${escapeVCard(company)}`);
    if (phone) lines.push(`TEL;TYPE=CELL:${escapeVCard(phone)}`);
    if (email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVCard(email)}`);
    if (website) lines.push(`URL:${escapeVCard(normalizeUrl(website))}`);

    if (address) {
      const addressParts = address.split(",").map((part) => part.trim()).filter(Boolean);
      const street = addressParts.shift() || "";
      const city = addressParts.shift() || "";
      const region = addressParts.shift() || "";
      const postalCode = addressParts.shift() || "";
      const country = addressParts.join(", ");
      lines.push(`ADR;TYPE=WORK:;;${escapeVCard(street)};${escapeVCard(city)};${escapeVCard(region)};${escapeVCard(postalCode)};${escapeVCard(country)}`);
    }

    lines.push("END:VCARD");
    return lines.join("\r\n");
  }

  function createQr(payload) {
    if (!payload || typeof window.qrcode !== "function") return null;
    try {
      if (typeof TextEncoder === "function" && !window.qrcode.__qraftUtf8) {
        window.qrcode.stringToBytes = (text) => Array.from(new TextEncoder().encode(text));
        window.qrcode.__qraftUtf8 = true;
      }
      const qr = window.qrcode(0, "M");
      qr.addData(payload);
      qr.make();
      return qr;
    } catch (error) {
      console.error("QR generation failed", error);
      return null;
    }
  }

  function drawQr(canvas, qr, size, foreground, background) {
    if (!canvas || !qr) return;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;

    const moduleCount = qr.getModuleCount();
    const quietZone = 4;
    const totalModules = moduleCount + quietZone * 2;
    const moduleSize = Math.max(1, Math.floor(size / totalModules));
    const contentSize = moduleSize * totalModules;
    const offset = Math.floor((size - contentSize) / 2);

    context.clearRect(0, 0, size, size);
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    context.fillStyle = foreground;

    for (let row = 0; row < moduleCount; row += 1) {
      for (let column = 0; column < moduleCount; column += 1) {
        if (qr.isDark(row, column)) {
          const x = offset + (column + quietZone) * moduleSize;
          const y = offset + (row + quietZone) * moduleSize;
          context.fillRect(x, y, moduleSize, moduleSize);
        }
      }
    }
  }

  function drawFallback(canvas, foreground, background) {
    if (!canvas) return;
    const context = canvas.getContext("2d");
    const size = canvas.width;
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    context.fillStyle = foreground;
    context.globalAlpha = 0.12;
    const block = size / 21;
    for (let y = 1; y < 20; y += 1) {
      for (let x = 1; x < 20; x += 1) {
        if ((x * 7 + y * 11) % 5 < 2) context.fillRect(x * block, y * block, block, block);
      }
    }
    context.globalAlpha = 1;
  }

  async function saveCurrentQr() {
    if (!state.user) {
      openAuthModal("login", "Connectez-vous pour enregistrer et suivre vos QR codes.");
      return;
    }

    updatePreview();
    if (state.mode === "link" && !isLikelyUrl(elements.linkInput.value)) {
      showToast("Ajoutez un lien valide avant d’enregistrer.");
      elements.linkInput.focus();
      return;
    }
    if (state.mode === "contact" && !Object.values(getContactData()).some(Boolean)) {
      showToast("Ajoutez au moins une coordonnée de contact.");
      return;
    }

    const isUpdate = Boolean(state.currentRecordId);
    const revisionAtStart = state.editRevision;
    const userId = state.user.id;
    const epoch = state.sessionEpoch;
    state.isSaving = true;
    elements.saveButton.disabled = true;
    elements.saveButton.innerHTML = `<span>${isUpdate ? "↻" : "＋"}</span> ${isUpdate ? "Mise à jour…" : "Enregistrement…"}`;

    try {
      const body = {
        name: value("qrNameInput"),
        mode: state.mode,
        foreground: state.foreground,
        background: state.background,
      };
      if (state.mode === "link") body.destination = elements.linkInput.value;
      else body.contactData = getContactData();

      const result = await api(isUpdate ? `/api/qrcodes/${state.currentRecordId}` : "/api/qrcodes", {
        method: isUpdate ? "PUT" : "POST",
        body,
      });
      if (!isCurrentSession(userId, epoch)) return;
      const changedWhileSaving = state.editRevision !== revisionAtStart;
      state.history = [result.qrcode, ...state.history.filter((item) => item.id !== result.qrcode.id)];
      renderHistory();
      if (changedWhileSaving) {
        showToast("QR code enregistré, mais vos dernières modifications restent à enregistrer.");
      } else {
        state.currentRecordId = result.qrcode.id;
        state.trackingUrl = result.qrcode.trackingUrl;
        state.contentDirty = false;
        state.isDirty = false;
        updatePreview();
        showToast(isUpdate ? "QR code mis à jour." : "QR code enregistré et suivi activé.");
      }
    } catch (error) {
      if (!isCurrentSession(userId, epoch)) return;
      if (error.status === 401) {
        clearSession();
        openAuthModal("login", "Votre session a expiré. Reconnectez-vous pour continuer.");
      } else {
        showToast(error.message || "Impossible d’enregistrer le QR code.");
      }
    } finally {
      if (state.sessionEpoch === epoch) {
        state.isSaving = false;
        elements.saveButton.disabled = false;
        updateSaveState();
      }
    }
  }

  function renderHistory() {
    const count = state.history.length;
    const totalScans = state.history.reduce((sum, item) => sum + Number(item.scanCount || 0), 0);
    const weeklyScans = state.history.reduce((sum, item) => sum + Number(item.scansWeek || 0), 0);
    elements.historyCount.textContent = String(count).padStart(2, "0");
    elements.libraryMetrics.hidden = !state.user;
    elements.metricQrCount.textContent = formatCompactNumber(count);
    elements.metricScanCount.textContent = formatCompactNumber(totalScans);
    elements.metricWeekCount.textContent = formatCompactNumber(weeklyScans);

    if (!count) {
      elements.historyGrid.innerHTML = state.user
        ? `
          <div class="empty-history">
            <span class="empty-icon">＋</span>
            <div><strong>Votre bibliothèque est encore vide.</strong><p>Enregistrez votre premier QR code pour activer ses statistiques.</p></div>
          </div>`
        : `
          <div class="empty-history auth-empty-history">
            <span class="empty-icon">↗</span>
            <div><strong>Votre bibliothèque vous attend.</strong><p>Connectez-vous ou créez un compte pour sauvegarder vos QR codes et consulter leurs statistiques.</p></div>
            <button class="button button-primary button-small" type="button" data-empty-login>Se connecter</button>
          </div>`;
      const emptyLogin = $("[data-empty-login]", elements.historyGrid);
      if (emptyLogin) emptyLogin.addEventListener("click", () => openAuthModal("login"));
      return;
    }

    elements.historyGrid.innerHTML = state.history.map((item) => `
      <article class="history-card" data-history-id="${escapeHtml(item.id)}">
        <div class="history-thumbnail"><canvas width="120" height="120" aria-hidden="true"></canvas></div>
        <div class="history-info">
          <span class="history-type">${item.mode === "contact" ? "Coordonnées" : "Lien"}</span>
          <strong class="history-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          <span class="history-date">${formatDate(item.createdAt)} · <b>${formatScanCount(item.scanCount)}</b></span>
        </div>
        <div class="history-actions">
          <button class="history-menu stats-action" type="button" data-history-action="stats" aria-label="Voir les statistiques" title="Statistiques">⌁</button>
          <button class="history-menu" type="button" data-history-action="load" aria-label="Charger ce QR code" title="Modifier">↗</button>
          <button class="history-menu delete-action" type="button" data-history-action="delete" aria-label="Supprimer ce QR code" title="Supprimer">×</button>
        </div>
      </article>
    `).join("");

    $$(".history-card", elements.historyGrid).forEach((card) => {
      const item = state.history.find((entry) => String(entry.id) === card.dataset.historyId);
      if (!item) return;
      const thumbnail = $("canvas", card);
      const qr = createQr(item.trackingUrl);
      if (qr) drawQr(thumbnail, qr, 120, item.foreground || "#101b33", item.background || "#ffffff");
    });
  }

  async function handleHistoryAction(event) {
    const button = event.target.closest("button[data-history-action]");
    const card = event.target.closest(".history-card");
    if (!button || !card) return;

    const item = state.history.find((entry) => String(entry.id) === card.dataset.historyId);
    if (!item) return;

    if (button.dataset.historyAction === "load") {
      loadHistoryItem(item);
      document.querySelector("#createur").scrollIntoView({ behavior: "smooth", block: "start" });
      showToast("QR code chargé dans l’éditeur.");
    }

    if (button.dataset.historyAction === "stats") {
      await openStats(item.id);
    }

    if (button.dataset.historyAction === "delete") {
      if (!window.confirm(`Supprimer « ${item.name} » et toutes ses statistiques ?`)) return;
      try {
        await api(`/api/qrcodes/${item.id}`, { method: "DELETE" });
        state.history = state.history.filter((entry) => entry.id !== item.id);
        if (state.currentRecordId === item.id) {
          state.currentRecordId = null;
          state.trackingUrl = null;
          markEditorDirty(true);
          updatePreview();
        }
        renderHistory();
        showToast("QR code supprimé de votre bibliothèque.");
      } catch (error) {
        showToast(error.message || "Impossible de supprimer ce QR code.");
      }
    }
  }

  function loadHistoryItem(item) {
    state.editRevision += 1;
    state.foreground = item.foreground || "#101b33";
    state.background = item.background || "#ffffff";
    state.currentRecordId = item.id;
    state.trackingUrl = item.trackingUrl;
    state.contentDirty = false;
    state.isDirty = false;
    setMode(item.mode || "link", { markDirty: false });

    if (item.mode === "contact" && item.contactData) {
      fillContactData(item.contactData);
    } else {
      elements.linkInput.value = item.destination || defaultLink;
      clearContactData();
    }
    elements.qrNameInput.value = item.name || "";

    syncColorInputs();
    syncPresetSelection();
    updatePreview();
    updateSaveState();
  }

  function getContactData() {
    return {
      firstName: value("firstNameInput"),
      lastName: value("lastNameInput"),
      company: value("companyInput"),
      phone: value("phoneInput"),
      email: value("emailInput"),
      website: value("contactWebsiteInput"),
      address: value("addressInput"),
    };
  }

  function fillContactData(data) {
    setValue("firstNameInput", data.firstName);
    setValue("lastNameInput", data.lastName);
    setValue("companyInput", data.company);
    setValue("phoneInput", data.phone);
    setValue("emailInput", data.email);
    setValue("contactWebsiteInput", data.website);
    setValue("addressInput", data.address);
  }

  function clearContactData() {
    fillContactData({});
  }

  function resetBuilder() {
    state.editRevision += 1;
    elements.linkInput.value = defaultLink;
    elements.qrNameInput.value = "";
    clearContactData();
    state.foreground = "#101b33";
    state.background = "#ffffff";
    state.currentRecordId = null;
    state.trackingUrl = null;
    state.contentDirty = false;
    state.isDirty = false;
    syncColorInputs();
    syncPresetSelection();
    setMode("link", { markDirty: false });
    updatePreview();
    showToast("L’éditeur a été réinitialisé.");
  }

  function downloadPng() {
    if (!state.currentRecordId) {
      showToast("Enregistrez d’abord le QR code pour activer le suivi des scans.");
      return;
    }
    if (state.isDirty) {
      showToast("Enregistrez vos modifications avant de télécharger le QR code.");
      return;
    }
    updatePreview();
    if (!state.currentQr) {
      showToast("Le moteur QR est encore en cours de chargement.");
      return;
    }
    const canvas = document.createElement("canvas");
    drawQr(canvas, state.currentQr, 1024, state.foreground, state.background);
    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `${fileName()}.png`);
      showToast("PNG 1024 px téléchargé.");
    }, "image/png");
  }

  function downloadSvg() {
    if (!state.currentRecordId) {
      showToast("Enregistrez d’abord le QR code pour activer le suivi des scans.");
      return;
    }
    if (state.isDirty) {
      showToast("Enregistrez vos modifications avant de télécharger le QR code.");
      return;
    }
    updatePreview();
    if (!state.currentQr) {
      showToast("Le moteur QR est encore en cours de chargement.");
      return;
    }

    const qr = state.currentQr;
    const moduleCount = qr.getModuleCount();
    const quietZone = 4;
    const totalModules = moduleCount + quietZone * 2;
    const shapes = [];

    for (let row = 0; row < moduleCount; row += 1) {
      for (let column = 0; column < moduleCount; column += 1) {
        if (qr.isDark(row, column)) {
          shapes.push(`<rect x="${column + quietZone}" y="${row + quietZone}" width="1" height="1"/>`);
        }
      }
    }

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalModules} ${totalModules}" role="img" aria-label="${escapeXml(state.currentLabel)}">`,
      `<title>${escapeXml(state.currentLabel)}</title>`,
      `<rect width="${totalModules}" height="${totalModules}" fill="${escapeXml(state.background)}"/>`,
      `<g fill="${escapeXml(state.foreground)}">${shapes.join("")}</g>`,
      `</svg>`,
    ].join("");

    downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${fileName()}.svg`);
    showToast("SVG vectoriel téléchargé.");
  }

  function copyContent() {
    updatePreview();
    const text = state.currentPayload;
    if (!text) return;

    const finish = () => {
      elements.copyLabel.textContent = "Copié !";
      showToast(state.mode === "contact" ? "Carte de visite copiée." : "Lien copié dans le presse-papiers.");
      window.setTimeout(() => { elements.copyLabel.textContent = "Ctrl C"; }, 1800);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(finish).catch(() => fallbackCopy(text, finish));
    } else {
      fallbackCopy(text, finish);
    }
  }

  function fallbackCopy(text, finish) {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand("copy");
      finish();
    } catch (error) {
      showToast("Sélectionnez le contenu manuellement.");
    }
    helper.remove();
  }

  function setColor(which, color) {
    if (which === "foreground") state.foreground = color;
    if (which === "background") state.background = color;
    markEditorDirty(false);
    $$(".preset").forEach((preset) => preset.classList.remove("active"));
    updatePreview();
  }

  function syncColorInputs() {
    elements.foregroundColor.value = state.foreground;
    elements.backgroundColor.value = state.background;
    updateColorLabels();
  }

  function syncPresetSelection() {
    $$(".preset").forEach((preset) => {
      const isMatch = preset.dataset.fg.toLowerCase() === state.foreground.toLowerCase() && preset.dataset.bg.toLowerCase() === state.background.toLowerCase();
      preset.classList.toggle("active", isMatch);
    });
  }

  function updateColorLabels() {
    elements.foregroundValue.textContent = state.foreground.toUpperCase();
    elements.backgroundValue.textContent = state.background.toUpperCase();
    elements.colorCount.textContent = "2 couleurs";
  }

  function normalizeUrl(rawValue) {
    const trimmed = String(rawValue || "").trim();
    if (!trimmed) return "";
    if (/^(https?:\/\/|mailto:|tel:|sms:|geo:)/i.test(trimmed)) return trimmed;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
  }

  function isLikelyUrl(rawValue) {
    const valueToCheck = normalizeUrl(rawValue);
    return /^https?:\/\//i.test(valueToCheck);
  }

  function getDisplayLabel(payload) {
    if (state.mode === "contact") {
      const contact = getContactData();
      const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
      return name || contact.company || "Carte de visite";
    }

    const raw = String(payload || defaultLink).replace(/^https?:\/\//i, "").replace(/\/$/, "");
    return raw.length > 42 ? `${raw.slice(0, 39)}…` : raw || "qraft.example/hello";
  }

  function value(id) {
    const input = document.getElementById(id);
    return input ? input.value.trim() : "";
  }

  function setValue(id, nextValue) {
    const input = document.getElementById(id);
    if (input) input.value = nextValue || "";
  }

  function escapeVCard(input) {
    return String(input).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
  }

  function escapeHtml(input) {
    return String(input)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeXml(input) {
    return escapeHtml(input);
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "Récemment";
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    if (sameDay) return "Aujourd’hui";
    return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(date);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const request = { ...options, headers, credentials: "same-origin" };
    if (options.body !== undefined && typeof options.body !== "string") {
      headers.set("Content-Type", "application/json");
      request.body = JSON.stringify(options.body);
    }
    if (options.method && !["GET", "HEAD", "OPTIONS"].includes(options.method.toUpperCase()) && state.csrfToken) {
      headers.set("X-CSRF-Token", state.csrfToken);
    }

    let response;
    try {
      response = await fetch(path, request);
    } catch {
      throw new Error("Le serveur est inaccessible.");
    }
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(data?.error?.message || "La requête n’a pas pu être traitée.");
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return data;
  }

  async function restoreSession() {
    const attempt = state.authAttempt;
    const result = await api("/api/auth/me");
    if (attempt !== state.authAttempt) return;
    if (!result.user) {
      clearSession();
      return;
    }
    applyAuthenticatedSession(result);
    const userId = result.user.id;
    const epoch = state.sessionEpoch;
    await loadLibrary();
    if (!isCurrentSession(userId, epoch)) return;
    const migrated = await migrateLegacyHistory();
    const summary = describeMigration(migrated);
    if (summary) showToast(summary);
  }

  function applyAuthenticatedSession(result) {
    state.sessionEpoch += 1;
    state.isSaving = false;
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    state.legacyHistory = loadLegacyHistoryForUser(result.user.id);
    renderAuthState();
  }

  function clearEditor() {
    state.editRevision += 1;
    elements.linkInput.value = defaultLink;
    elements.qrNameInput.value = "";
    clearContactData();
    state.foreground = "#101b33";
    state.background = "#ffffff";
    state.currentRecordId = null;
    state.trackingUrl = null;
    state.contentDirty = false;
    state.isDirty = false;
    syncColorInputs();
    syncPresetSelection();
    setMode("link", { markDirty: false });
    updatePreview();
  }

  function clearSession() {
    state.sessionEpoch += 1;
    state.authAttempt += 1;
    state.isSaving = false;
    state.user = null;
    state.csrfToken = null;
    state.history = [];
    state.legacyHistory = [];
    state.activeStatsId = null;
    window.clearTimeout(state.updateTimer);
    state.updateTimer = null;
    if (elements.saveButton) {
      elements.saveButton.disabled = false;
      elements.saveButton.innerHTML = "";
    }
    if (!elements.statsModal.hidden) closeModal("statsModal");
    if (!elements.authModal.hidden) closeModal("authModal");
    clearEditor();
    renderAuthState();
    renderHistory();
  }

  function renderAuthState() {
    const signedIn = Boolean(state.user);
    elements.guestActions.hidden = signedIn;
    elements.userActions.hidden = !signedIn;
    if (!signedIn) return;
    elements.userName.textContent = state.user.displayName;
    elements.userAvatar.textContent = Array.from(state.user.displayName.trim())[0]?.toUpperCase() || "Q";
  }

  async function loadLibrary() {
    const userId = state.user?.id;
    const epoch = state.sessionEpoch;
    if (userId === undefined || userId === null) {
      state.history = [];
      renderHistory();
      return;
    }
    try {
      const qrcodes = [];
      let offset = 0;
      let total = 0;
      do {
        const result = await api(`/api/qrcodes?limit=100&offset=${offset}`);
        if (!isCurrentSession(userId, epoch)) return;
        const page = Array.isArray(result.qrcodes) ? result.qrcodes : [];
        qrcodes.push(...page);
        total = Number.isInteger(result.total) ? result.total : qrcodes.length;
        offset += page.length;
        if (!page.length) break;
      } while (offset < total);
      if (!isCurrentSession(userId, epoch)) return;
      state.history = qrcodes;
      renderHistory();
    } catch (error) {
      if (isCurrentSession(userId, epoch)) {
        if (error.status === 401) clearSession();
        throw error;
      }
    }
  }

  function newLegacyMigrationKey() {
    if (window.crypto?.randomUUID) return `legacy-${window.crypto.randomUUID()}`;
    if (window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return `legacy-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
    return `legacy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function ensureLegacyMigrationKeys() {
    let changed = false;
    for (const item of state.legacyHistory) {
      if (item && typeof item === "object" && !/^[A-Za-z0-9_-]{16,128}$/.test(String(item._qraftMigrationKey || ""))) {
        item._qraftMigrationKey = newLegacyMigrationKey();
        changed = true;
      }
    }
    if (changed) persistLegacyHistory(state.legacyHistory);
  }

  function markLegacyAttempt(item) {
    if (!item || typeof item !== "object") {
      return { _qraftInvalidLegacyItem: true, _qraftMigrationAttempts: MAX_LEGACY_ATTEMPTS, value: item };
    }
    const attempts = Number(item._qraftMigrationAttempts || 0);
    return { ...item, _qraftMigrationAttempts: Math.min(MAX_LEGACY_ATTEMPTS, attempts + 1) };
  }

  async function migrateLegacyHistory() {
    const userId = state.user?.id;
    if (userId === undefined || userId === null) return 0;

    if (state.migrationPromise) {
      if (state.migrationUserId === userId) return state.migrationPromise;
      try { await state.migrationPromise; } catch { /* Une ancienne migration peut être abandonnée. */ }
      if (state.user?.id !== userId) return 0;
    }
    if (!state.legacyHistory.length) return 0;
    ensureLegacyMigrationKeys();

    const epoch = state.sessionEpoch;
    const migration = migrateLegacyHistoryInternal(userId, epoch);
    state.migrationPromise = migration;
    state.migrationUserId = userId;
    try {
      return await migration;
    } finally {
      if (state.migrationPromise === migration) {
        state.migrationPromise = null;
        state.migrationUserId = null;
      }
    }
  }

  function isRetryableMigrationError(error) {
    // Les erreurs de session, de réseau ou de serveur ne concernent pas l’élément :
    // elles ne doivent jamais consommer une tentative de migration.
    if (!error || !Number.isInteger(error.status)) return true;
    return error.status === 401 || error.status === 403 ||
      error.status === 408 || error.status === 429 || error.status >= 500;
  }

  async function migrateLegacyHistoryInternal(userId, epoch) {
    const pending = state.legacyHistory.slice(0, MAX_LEGACY_IMPORT);
    const remaining = state.legacyHistory.slice(MAX_LEGACY_IMPORT);
    const failed = [];
    const deferred = [];
    let migrated = 0;
    let skipped = 0;

    for (let index = 0; index < pending.length; index += 1) {
      if (!isCurrentSession(userId, epoch)) return migrated;
      const item = pending[index];
      if (item && typeof item === "object" && Number(item._qraftMigrationAttempts || 0) >= MAX_LEGACY_ATTEMPTS) {
        failed.push(item);
        skipped += 1;
        continue;
      }
      const body = legacyItemToPayload(item);
      if (!body) {
        failed.push(markLegacyAttempt(item));
        continue;
      }

      try {
        await api("/api/qrcodes", { method: "POST", body });
        migrated += 1;
      } catch (error) {
        if (isRetryableMigrationError(error)) {
          console.warn("Legacy QR code import interrompue, nouvel essai à la prochaine session", error);
          deferred.push(...pending.slice(index));
          if (isCurrentSession(userId, epoch) && (error.status === 401 || error.status === 403)) {
            clearSession();
          }
          break;
        }
        failed.push(markLegacyAttempt(item));
        console.warn("Legacy QR code import refusé", error);
      }
    }

    if (!isCurrentSession(userId, epoch)) return migrated;
    state.lastMigrationSkipped = skipped;
    state.legacyHistory = [...failed, ...deferred, ...remaining];
    persistLegacyHistory(state.legacyHistory);
    if (migrated > 0) await loadLibrary();
    return migrated;
  }

  function legacyItemToPayload(item) {
    if (!item || typeof item !== "object") return null;
    const rawPayload = typeof item.payload === "string" ? item.payload : "";
    let mode = item.mode || item.type;
    if (mode !== "link" && mode !== "contact") {
      mode = /^BEGIN:VCARD/i.test(rawPayload.trim()) ? "contact" : "link";
    }

    const body = {
      name: item.label || item.name || "",
      mode,
      foreground: item.foreground || "#101b33",
      background: item.background || "#ffffff",
    };
    if (/^[A-Za-z0-9_-]{16,128}$/.test(String(item._qraftMigrationKey || ""))) {
      body.legacyKey = item._qraftMigrationKey;
    }

    if (mode === "link") {
      const destination = item.destination || item.url || rawPayload;
      if (!/^https?:\/\//i.test(String(destination || "").trim())) return null;
      body.destination = destination;
      return body;
    }

    const contact = item.contactData || item.contact || parseLegacyVCard(rawPayload) || {
      firstName: item.firstName || item.first_name,
      lastName: item.lastName || item.last_name,
      company: item.company || item.organization,
      phone: item.phone || item.tel,
      email: item.email,
      website: item.website || item.url,
      address: item.address,
    };
    if (!contact || !Object.values(contact).some((value) => String(value || "").trim())) return null;
    body.contactData = contact;
    return body;
  }

  function parseLegacyVCard(rawPayload) {
    if (typeof rawPayload !== "string" || !/BEGIN:VCARD/i.test(rawPayload)) return null;
    const unfolded = rawPayload.replace(/\r?\n[ \t]/g, "");
    const contact = {};
    for (const line of unfolded.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      const property = line.slice(0, separator).split(";", 1)[0].trim().toUpperCase();
      const rawValue = line.slice(separator + 1);
      if (property === "N") {
        const parts = splitVCardValue(rawValue).map(unescapeVCard);
        contact.lastName = parts[0] || "";
        contact.firstName = parts[1] || "";
      } else if (property === "FN" && !contact.firstName && !contact.lastName) {
        const fullName = unescapeVCard(rawValue).trim();
        const parts = fullName.split(/\s+/);
        if (parts.length > 1) {
          contact.firstName = parts.shift();
          contact.lastName = parts.join(" ");
        } else {
          contact.company = fullName;
        }
      } else if (property === "ORG") {
        contact.company = unescapeVCard(rawValue);
      } else if (property === "TEL") {
        contact.phone = unescapeVCard(rawValue);
      } else if (property === "EMAIL") {
        contact.email = unescapeVCard(rawValue);
      } else if (property === "URL") {
        contact.website = unescapeVCard(rawValue);
      } else if (property === "ADR") {
        const parts = splitVCardValue(rawValue).map(unescapeVCard).filter(Boolean);
        contact.address = parts.join(", ");
      }
    }
    return contact;
  }

  function splitVCardValue(value) {
    const parts = [];
    let current = "";
    let escaped = false;
    for (const character of String(value || "")) {
      if (escaped) {
        current += `\\${character}`;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === ";") {
        parts.push(current);
        current = "";
      } else {
        current += character;
      }
    }
    if (escaped) current += "\\";
    parts.push(current);
    return parts;
  }

  function unescapeVCard(value) {
    return String(value || "").replace(/\\([\\,;nN])/g, (_, character) => character === "n" || character === "N" ? "\n" : character);
  }

  function persistLegacyHistory(items) {
    if (!state.user) return;
    const key = legacyStorageKey(state.user.id);
    try {
      if (items.length) window.localStorage.setItem(key, JSON.stringify(items));
      else window.localStorage.removeItem(key);
    } catch {
      // Le stockage local peut être indisponible.
    }
  }

  function openAuthModal(mode = "login", message = "") {
    setAuthMode(mode);
    elements.authError.textContent = message;
    elements.authError.hidden = !message;
    elements.authModal.hidden = false;
    document.body.classList.add("modal-open");
    window.setTimeout(() => {
      const firstInput = $(mode === "login" ? "#loginEmail" : "#registerName");
      firstInput?.focus();
    }, 0);
  }

  function setAuthMode(mode) {
    const isLogin = mode !== "register";
    $("#loginTab").classList.toggle("active", isLogin);
    $("#registerTab").classList.toggle("active", !isLogin);
    $("#loginTab").setAttribute("aria-selected", String(isLogin));
    $("#registerTab").setAttribute("aria-selected", String(!isLogin));
    elements.loginForm.hidden = !isLogin;
    elements.registerForm.hidden = isLogin;
    elements.authError.hidden = true;
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = true;
    if (id === "statsModal") state.activeStatsId = null;
    if (elements.authModal.hidden && elements.statsModal.hidden) document.body.classList.remove("modal-open");
  }

  function setFormBusy(form, busy, busyLabel) {
    const button = $("button[type='submit']", form);
    if (busy) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.textContent = busyLabel;
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const attempt = ++state.authAttempt;
    elements.authError.hidden = true;
    setFormBusy(elements.loginForm, true, "Connexion…");
    try {
      const formData = new FormData(elements.loginForm);
      const result = await api("/api/auth/login", {
        method: "POST",
        body: { email: formData.get("email"), password: formData.get("password") },
      });
      if (attempt !== state.authAttempt) return;
      applyAuthenticatedSession(result);
      const userId = result.user.id;
      const epoch = state.sessionEpoch;
      elements.loginForm.reset();
      closeModal("authModal");
      await loadLibrary();
      if (!isCurrentSession(userId, epoch)) return;
      const migrated = await migrateLegacyHistory();
      const summary = describeMigration(migrated);
      showToast(summary ? `Connexion réussie · ${summary}` : "Connexion réussie.");
    } catch (error) {
      if (attempt !== state.authAttempt) return;
      if (elements.authModal.hidden) showToast(error.message || "Connexion réussie, mais la bibliothèque n’a pas pu être chargée.");
      else {
        elements.authError.textContent = error.message;
        elements.authError.hidden = false;
      }
    } finally {
      setFormBusy(elements.loginForm, false);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    const attempt = ++state.authAttempt;
    elements.authError.hidden = true;
    setFormBusy(elements.registerForm, true, "Création…");
    try {
      const formData = new FormData(elements.registerForm);
      const result = await api("/api/auth/register", {
        method: "POST",
        body: {
          displayName: formData.get("displayName"),
          email: formData.get("email"),
          password: formData.get("password"),
        },
      });
      if (attempt !== state.authAttempt) return;
      applyAuthenticatedSession(result);
      const userId = result.user.id;
      const epoch = state.sessionEpoch;
      elements.registerForm.reset();
      closeModal("authModal");
      await loadLibrary();
      if (!isCurrentSession(userId, epoch)) return;
      const migrated = await migrateLegacyHistory();
      const summary = describeMigration(migrated);
      showToast(summary ? `Votre espace est prêt · ${summary}` : "Votre espace personnel est prêt.");
    } catch (error) {
      if (attempt !== state.authAttempt) return;
      if (elements.authModal.hidden) showToast(error.message || "Compte créé, mais la bibliothèque n’a pas pu être chargée.");
      else {
        elements.authError.textContent = error.message;
        elements.authError.hidden = false;
      }
    } finally {
      setFormBusy(elements.registerForm, false);
    }
  }

  async function logout() {
    if (state.isLoggingOut) return;
    state.isLoggingOut = true;
    try {
      // La migration est bornée dans le temps : la déconnexion reste prioritaire
      // et l_epoch de session empêche toute écriture tardive.
      if (state.migrationPromise) {
        await Promise.race([
          state.migrationPromise.catch(() => 0),
          new Promise((resolve) => window.setTimeout(resolve, 2_000)),
        ]);
      }
      await api("/api/auth/logout", { method: "POST", body: {} });
      clearSession();
      showToast("Vous êtes déconnecté.");
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        showToast("Votre session était déjà expirée.");
      } else {
        showToast(error.message || "La déconnexion a échoué.");
      }
    } finally {
      state.isLoggingOut = false;
    }
  }

  async function openStats(id) {
    const item = state.history.find((entry) => entry.id === id);
    if (!item) return;
    const userId = state.user?.id;
    const epoch = state.sessionEpoch;
    if (userId === undefined || userId === null) return;
    state.activeStatsId = id;
    $("#statsModalTitle").textContent = item.name;
    $("#statsQrLabel").textContent = item.trackingUrl;
    $("#statsTotal").textContent = "—";
    $("#statsPeriod").textContent = "—";
    $("#statsLastScan").textContent = "—";
    $("#statsChart").replaceChildren();
    $("#statsDevices").innerHTML = "<p>Chargement…</p>";
    $("#statsReferrers").innerHTML = "<p>Chargement…</p>";
    elements.statsModal.hidden = false;
    document.body.classList.add("modal-open");

    try {
      const result = await api(`/api/qrcodes/${id}/stats?days=30`);
      if (isCurrentSession(userId, epoch) && state.activeStatsId === id) renderStats(result.stats);
    } catch (error) {
      if (!isCurrentSession(userId, epoch) || state.activeStatsId !== id) return;
      if (error.status === 401) {
        closeModal("statsModal");
        clearSession();
        openAuthModal("login", "Votre session a expiré. Reconnectez-vous pour consulter vos statistiques.");
      } else {
        $("#statsDevices").innerHTML = "";
        $("#statsDevices").appendChild(Object.assign(document.createElement("p"), { textContent: error.message }));
      }
    }
  }

  function renderStats(stats) {
    $("#statsTotal").textContent = formatCompactNumber(stats.total);
    $("#statsPeriod").textContent = formatCompactNumber(stats.daily.reduce((sum, day) => sum + day.count, 0));
    $("#statsLastScan").textContent = stats.lastScanAt ? formatDateTime(stats.lastScanAt) : "Aucun scan";
    $("#statsRangeLabel").textContent = `${stats.periodDays} jours`;

    const chart = $("#statsChart");
    const fragment = document.createDocumentFragment();
    const maximum = Math.max(1, ...stats.daily.map((day) => day.count));
    for (const day of stats.daily) {
      const column = document.createElement("span");
      column.className = "chart-column";
      column.title = `${formatShortDate(day.date)} · ${formatScanCount(day.count)}`;
      column.setAttribute("aria-label", column.title);
      const bar = document.createElement("i");
      bar.style.setProperty("--bar-height", `${day.count ? Math.max(7, Math.round((day.count / maximum) * 100)) : 2}%`);
      column.appendChild(bar);
      fragment.appendChild(column);
    }
    chart.replaceChildren(fragment);

    const deviceLabels = { mobile: "Mobile", tablette: "Tablette", ordinateur: "Ordinateur" };
    renderStatsList($("#statsDevices"), stats.devices, (entry) => `${deviceLabels[entry.type] || entry.type} · ${formatScanCount(entry.count)}`);
    renderStatsList($("#statsReferrers"), stats.referrers, (entry) => `${entry.host === "(autre)" ? "Autres sources" : entry.host} · ${formatScanCount(entry.count)}`);
  }

  function renderStatsList(container, entries, formatter) {
    container.replaceChildren();
    if (!entries.length) {
      container.appendChild(Object.assign(document.createElement("p"), { textContent: "Aucune donnée" }));
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "stats-list-row";
      row.textContent = formatter(entry);
      container.appendChild(row);
    }
  }

  function updateSaveState() {
    if (!elements.saveButton || state.isSaving) return;
    const icon = state.currentRecordId ? "↻" : "＋";
    const label = state.currentRecordId ? "Mettre à jour ce QR code" : "Enregistrer ce QR code";
    elements.saveButton.innerHTML = `<span>${icon}</span> ${label}`;
    elements.trackingStatus.classList.toggle("active", Boolean(state.currentRecordId));
    if (state.currentRecordId) {
      elements.trackingStatus.innerHTML = state.isDirty
        ? "<span>↗</span> Suivi actif · vos modifications ne sont pas encore enregistrées."
        : "<span>✓</span> Suivi des scans actif sur ce QR code.";
    } else {
      elements.trackingStatus.innerHTML = "<span>↗</span> Enregistrez-le pour activer les statistiques de scan.";
    }
  }

  function formatCompactNumber(value) {
    return new Intl.NumberFormat("fr-FR", { notation: value >= 10_000 ? "compact" : "standard" }).format(Number(value) || 0);
  }

  function formatScanCount(value) {
    const count = Number(value) || 0;
    return `${formatCompactNumber(count)} scan${count > 1 ? "s" : ""}`;
  }

  function formatDateTime(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function formatShortDate(dateString) {
    const date = new Date(`${dateString}T00:00:00Z`);
    return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(date);
  }

  function fileName() {
    const base = state.currentLabel || (state.mode === "link" ? "qr-link" : "qr-contact");
    const slug = base
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34);
    return `qraft-${slug || "code"}`;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function legacyStorageKey(userId) {
    return `${STORAGE_KEY}:user:${userId}`;
  }

  function loadHistory(key = STORAGE_KEY) {
    try {
      const stored = window.localStorage.getItem(key);
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
    } catch (error) {
      return [];
    }
  }

  function loadLegacyHistoryForUser(userId) {
    const scopedKey = legacyStorageKey(userId);
    try {
      if (window.localStorage.getItem(scopedKey) !== null) return loadHistory(scopedKey);
      const legacyItems = loadHistory(STORAGE_KEY);
      if (legacyItems.length) {
        window.localStorage.setItem(scopedKey, JSON.stringify(legacyItems));
        window.localStorage.removeItem(STORAGE_KEY);
      }
      return legacyItems;
    } catch {
      return loadHistory(scopedKey);
    }
  }

  function showToast(message) {
    elements.toastMessage.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3000);
  }
})();
