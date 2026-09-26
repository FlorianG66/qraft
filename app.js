(() => {
  "use strict";

  const STORAGE_KEY = "qraft-qr-history";
  const MAX_LEGACY_IMPORT = 50;
  const MAX_LEGACY_ATTEMPTS = 3;
  const defaultLink = "https://qraft.example/hello";
  const MAX_MARGIN = 8;
  const LOGO_MAX_EDGE = 256;
  const LOGO_MAX_DATA_LENGTH = 220_000;
  const LOGO_SIZE_MIN_PCT = 18;
  const LOGO_SIZE_MAX_PCT = 30;
  const LOGO_SIZE_DEFAULT_PCT = 22;
  const LOGO_MIN_SPAN = 5;
  const LOGO_ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
  const defaultStyle = Object.freeze({
    moduleShape: "square",
    eyeShape: "square",
    margin: 4,
    logoSizePct: LOGO_SIZE_DEFAULT_PCT,
    gradient: null,
  });

  const state = {
    mode: "link",
    foreground: "#101b33",
    background: "#ffffff",
    style: { ...defaultStyle },
    logo: null,
    logoName: "",
    currentQr: null,
    currentPayload: "",
    currentLabel: "",
    history: [],
    legacyHistory: [],
    user: null,
    csrfToken: null,
    entitlement: null,
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
    elements.marginRange = $("#marginRange");
    elements.marginValue = $("#marginValue");
    elements.marginHint = $("#marginHint");
    elements.gradientToggle = $("#gradientToggle");
    elements.gradientControls = $("#gradientControls");
    elements.gradientFrom = $("#gradientFrom");
    elements.gradientTo = $("#gradientTo");
    elements.gradientFromValue = $("#gradientFromValue");
    elements.gradientToValue = $("#gradientToValue");
    elements.gradientAngle = $("#gradientAngle");
    elements.gradientAngleValue = $("#gradientAngleValue");
    elements.logoInput = $("#logoInput");
    elements.logoDrop = $("#logoDrop");
    elements.logoPreview = $("#logoPreview");
    elements.logoThumb = $("#logoThumb");
    elements.logoName = $("#logoName");
    elements.logoRemove = $("#logoRemove");
    elements.logoSize = $("#logoSize");
    elements.logoSizeValue = $("#logoSizeValue");
    elements.logoSizeHint = $("#logoSizeHint");
    elements.styleWarning = $("#styleWarning");
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
    elements.planBadge = $("#planBadge");
    elements.quotaBanner = $("#quotaBanner");
    elements.quotaBannerTitle = $("#quotaBannerTitle");
    elements.quotaBannerDetail = $("#quotaBannerDetail");
    elements.quotaBannerTrim = $("#quotaBannerTrim");
    elements.quotaMeters = $("#quotaMeters");
    elements.quotaStoredMeter = $("#quotaStoredMeter");
    elements.quotaStoredValue = $("#quotaStoredValue");
    elements.quotaStoredBar = $("#quotaStoredBar");
    elements.quotaActiveMeter = $("#quotaActiveMeter");
    elements.quotaActiveValue = $("#quotaActiveValue");
    elements.quotaActiveBar = $("#quotaActiveBar");
    elements.quotaModal = $("#quotaModal");
    elements.quotaModalIntro = $("#quotaModalIntro");
    elements.quotaModalList = $("#quotaModalList");
    elements.quotaModalConfirm = $("#quotaModalConfirm");
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
    $("#resetStyle").addEventListener("click", resetStyle);

    $$("[data-module-shape]").forEach((button) => {
      button.addEventListener("click", () => {
        state.style = { ...state.style, moduleShape: button.dataset.moduleShape };
        markEditorDirty(false);
        syncStyleControls();
        updatePreview();
      });
    });

    $$("[data-eye-shape]").forEach((button) => {
      button.addEventListener("click", () => {
        state.style = { ...state.style, eyeShape: button.dataset.eyeShape };
        markEditorDirty(false);
        syncStyleControls();
        updatePreview();
      });
    });

    elements.marginRange.addEventListener("input", () => {
      state.style = { ...state.style, margin: Number(elements.marginRange.value) };
      markEditorDirty(false);
      syncStyleControls();
      updatePreview();
    });

    elements.logoSize.addEventListener("input", () => {
      state.style = { ...state.style, logoSizePct: Number(elements.logoSize.value) };
      markEditorDirty(false);
      syncStyleControls();
      updatePreview();
    });

    elements.gradientToggle.addEventListener("change", () => {
      state.style = {
        ...state.style,
        gradient: elements.gradientToggle.checked ? {
          from: elements.gradientFrom.value,
          to: elements.gradientTo.value,
          angle: Number(elements.gradientAngle.value),
        } : null,
      };
      markEditorDirty(false);
      syncStyleControls();
      updatePreview();
    });

    [elements.gradientFrom, elements.gradientTo].forEach((input) => {
      input.addEventListener("input", () => {
        state.style = {
          ...state.style,
          gradient: {
            from: elements.gradientFrom.value,
            to: elements.gradientTo.value,
            angle: state.style.gradient ? state.style.gradient.angle : Number(elements.gradientAngle.value),
          },
        };
        markEditorDirty(false);
        syncStyleControls();
        updatePreview();
      });
    });

    elements.gradientAngle.addEventListener("input", () => {
      state.style = {
        ...state.style,
        gradient: {
          from: state.style.gradient ? state.style.gradient.from : elements.gradientFrom.value,
          to: state.style.gradient ? state.style.gradient.to : elements.gradientTo.value,
          angle: Number(elements.gradientAngle.value),
        },
      };
      markEditorDirty(false);
      syncStyleControls();
      updatePreview();
    });

    elements.logoDrop.addEventListener("click", () => elements.logoInput.click());
    elements.logoInput.addEventListener("change", handleLogoSelection);
    elements.logoRemove.addEventListener("click", () => {
      clearLogo();
      markEditorDirty(false);
      syncStyleControls();
      updatePreview();
    });

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
    elements.planBadge.addEventListener("click", openQuotaModal);
    elements.quotaBannerTrim.addEventListener("click", openQuotaModal);
    elements.quotaModalConfirm.addEventListener("click", confirmTrimActiveQrcodes);
    elements.quotaModalList.addEventListener("change", () => syncQuotaModalConfirm());
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
        else if (!elements.quotaModal.hidden) closeModal("quotaModal");
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
    const useTrackedPayload = Boolean(
      state.currentRecordId &&
      state.trackingUrl &&
      !state.contentDirty &&
      isTrackingUrlReachable(state.trackingUrl)
    );
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

    state.currentQr = createQr(encodedPayload, { errorCorrectionLevel: state.logo ? "H" : "M" });
    if (state.currentQr) {
      drawQr(elements.qrCanvas, state.currentQr, 1024, currentRenderOptions());
    } else {
      drawFallback(elements.qrCanvas, state.foreground, state.background);
    }

    updateColorLabels();
    syncStyleControls();
    updateSaveState();
  }

  function currentRenderOptions() {
    return {
      style: state.style,
      foreground: state.foreground,
      background: state.background,
      logo: state.logo,
    };
  }

  function clearLogo() {
    state.logo = null;
    state.logoName = "";
    elements.logoInput.value = "";
  }

  function resetStyle() {
    state.style = { ...defaultStyle };
    clearLogo();
    markEditorDirty(false);
    syncStyleControls();
    updatePreview();
    showToast("Forme, marge et logo ont ǸtǸ rǸinitialisǸs.");
  }

  function syncStyleControls() {
    const style = normalizeStyle(state.style);

    $$("[data-module-shape]").forEach((button) => {
      button.classList.toggle("active", button.dataset.moduleShape === style.moduleShape);
    });
    $$("[data-eye-shape]").forEach((button) => {
      button.classList.toggle("active", button.dataset.eyeShape === style.eyeShape);
    });

    elements.marginRange.value = String(style.margin);
    elements.marginValue.textContent = String(style.margin);
    const marginCopy = style.margin === 0
      ? "0 module — le code risque de ne pas être détecté."
      : style.margin < 2
        ? `${style.margin} module — en dessous de 2, la détection devient aléatoire.`
        : style.margin >= 4
          ? `${style.margin} modules — marge recommandée pour un scan fiable.`
          : `${style.margin} modules — acceptable, 4 reste plus sûr.`;
    elements.marginHint.textContent = marginCopy;
    elements.marginHint.classList.toggle("is-alert", style.margin < 2);

    const hasGradient = Boolean(style.gradient);
    elements.gradientToggle.checked = hasGradient;
    elements.gradientControls.hidden = !hasGradient;
    if (hasGradient) {
      elements.gradientFrom.value = style.gradient.from;
      elements.gradientTo.value = style.gradient.to;
      elements.gradientAngle.value = String(style.gradient.angle);
      elements.gradientFromValue.textContent = style.gradient.from.toUpperCase();
      elements.gradientToValue.textContent = style.gradient.to.toUpperCase();
      elements.gradientAngleValue.textContent = `${style.gradient.angle}°`;
    }

    elements.logoPreview.hidden = !state.logo;
    elements.logoDrop.hidden = Boolean(state.logo);
    if (state.logo) {
      elements.logoThumb.src = state.logo;
      elements.logoName.textContent = state.logoName || "logo";
    } else {
      elements.logoThumb.removeAttribute("src");
      elements.logoName.textContent = "";
    }

    const moduleCount = state.currentQr ? state.currentQr.getModuleCount() : 0;
    const span = moduleCount ? logoSpanFor(moduleCount, style.logoSizePct) : 0;
    elements.logoSize.value = String(style.logoSizePct);
    elements.logoSize.disabled = !state.logo;
    elements.logoSizeValue.textContent = state.logo && span ? `${style.logoSizePct} % · ${span} modules` : `${style.logoSizePct} %`;
    elements.logoSizeHint.textContent = !state.logo || !span
      ? "Ajoutez un logo pour régler sa taille."
      : style.logoSizePct >= 28
        ? `${span} modules sur ${moduleCount} : au-delà, la lecture peut devenir aléatoire.`
        : `${span} modules sur ${moduleCount} — agrandissez si le logo reste lisible.`;
    elements.logoSizeHint.classList.toggle("is-alert", Boolean(state.logo && span) && style.logoSizePct >= 28);

    const warnings = [];
    if (state.logo && style.margin < 2) {
      warnings.push("Un logo avec moins de 2 modules de marge : augmentez la marge pour éviter les échecs de scan.");
    }
    if (state.logo && style.moduleShape === "dot") {
      warnings.push("Logo + modules en point : préférez des modules carrés ou arrondis pour une lecture plus fiable.");
    }
    if (state.logo && style.logoSizePct >= 28) {
      warnings.push("Logo très agrandi : la zone blanche au centre dégrade la détection, restez sur un scan de test.");
    }
    if (hasGradient) {
      warnings.push("Un dégradé reste moins robuste qu'une couleur pleine en cas d'impression à l'encre.");
    }
    elements.styleWarning.hidden = warnings.length === 0;
    elements.styleWarning.textContent = warnings.join(" ");
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")));
      reader.addEventListener("error", () => reject(new Error("read_failed")));
      reader.readAsDataURL(file);
    });
  }

  function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => resolve(image));
      image.addEventListener("error", () => reject(new Error("decode_failed")));
      image.src = dataUrl;
    });
  }

  async function handleLogoSelection() {
    const file = elements.logoInput.files && elements.logoInput.files[0];
    if (!file) return;
    if (!LOGO_ACCEPTED_TYPES.includes(file.type)) {
      elements.logoInput.value = "";
      showToast("Format non pris en charge — utilisez PNG, JPG, WEBP ou SVG.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      elements.logoInput.value = "";
      showToast("Image trop lourde — 4 Mo maximum.");
      return;
    }

    let dataUrl;
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      elements.logoInput.value = "";
      showToast("Impossible de lire cette image.");
      return;
    }

    let image;
    try {
      image = await loadImageElement(dataUrl);
    } catch {
      elements.logoInput.value = "";
      showToast("Image invalide ou corrompue.");
      return;
    }

    const ratio = Math.min(LOGO_MAX_EDGE / image.naturalWidth, LOGO_MAX_EDGE / image.naturalHeight, 1);
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    let encoded = canvas.toDataURL("image/png");
    if (encoded.length > LOGO_MAX_DATA_LENGTH) {
      const smaller = Math.max(24, Math.round(LOGO_MAX_EDGE * 0.5));
      const reduced = Math.min(smaller / width, smaller / height, 1);
      canvas.width = Math.max(1, Math.round(width * reduced));
      canvas.height = Math.max(1, Math.round(height * reduced));
      const reducedContext = canvas.getContext("2d");
      reducedContext.imageSmoothingQuality = "high";
      reducedContext.drawImage(image, 0, 0, canvas.width, canvas.height);
      encoded = canvas.toDataURL("image/png");
    }
    if (encoded.length > LOGO_MAX_DATA_LENGTH) {
      elements.logoInput.value = "";
      showToast("Logo trop détaillé — il alourdirait trop l’enregistrement.");
      return;
    }

    state.logo = encoded;
    state.logoName = file.name || "logo";
    markEditorDirty(false);
    syncStyleControls();
    updatePreview();
    showToast("Logo ajouté — le niveau de correction est passé en H.");
  }

  function getLinkPayload() {
    return normalizeUrl(elements.linkInput.value) || defaultLink;
  }

  function getContactPayload() {
    return buildContactPayload(getContactData());
  }

  function buildContactPayload(contactData) {
    const contact = contactData && typeof contactData === "object" ? contactData : {};
    const firstName = String(contact.firstName || "").trim();
    const lastName = String(contact.lastName || "").trim();
    const company = String(contact.company || "").trim();
    const phone = String(contact.phone || "").trim();
    const email = String(contact.email || "").trim();
    const website = String(contact.website || "").trim();
    const address = String(contact.address || "").trim();

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

  function createQr(payload, options = {}) {
    if (!payload || typeof window.qrcode !== "function") return null;
    try {
      if (typeof TextEncoder === "function" && !window.qrcode.__qraftUtf8) {
        window.qrcode.stringToBytes = (text) => Array.from(new TextEncoder().encode(text));
        window.qrcode.__qraftUtf8 = true;
      }
      const qr = window.qrcode(0, options.errorCorrectionLevel || "M");
      qr.addData(payload);
      qr.make();
      return qr;
    } catch (error) {
      console.error("QR generation failed", error);
      return null;
    }
  }

  function normalizeStyle(rawStyle) {
    const source = rawStyle && typeof rawStyle === "object" ? rawStyle : {};
    const gradientSource = source.gradient && typeof source.gradient === "object" ? source.gradient : null;
    const angle = Number(gradientSource && gradientSource.angle);
    const isHexColor = (candidate) => /^#[0-9a-f]{6}$/i.test(String(candidate || ""));
    return {
      moduleShape: ["square", "rounded", "dot"].includes(source.moduleShape)
        ? source.moduleShape
        : defaultStyle.moduleShape,
      eyeShape: ["square", "rounded", "leaf"].includes(source.eyeShape)
        ? source.eyeShape
        : defaultStyle.eyeShape,
      margin: Number.isInteger(source.margin)
        ? Math.min(Math.max(source.margin, 0), MAX_MARGIN)
        : defaultStyle.margin,
      logoSizePct: Number.isFinite(Number(source.logoSizePct))
        ? Math.min(Math.max(Math.round(Number(source.logoSizePct)), LOGO_SIZE_MIN_PCT), LOGO_SIZE_MAX_PCT)
        : defaultStyle.logoSizePct,
      gradient: gradientSource && isHexColor(gradientSource.from) && isHexColor(gradientSource.to) ? {
        from: String(gradientSource.from).toLowerCase(),
        to: String(gradientSource.to).toLowerCase(),
        angle: Number.isFinite(angle) ? ((Math.round(angle) % 360) + 360) % 360 : 135,
      } : null,
    };
  }

  const logoImages = new Map();
  const MAX_LOGO_IMAGE_CACHE = 40;

  function getLogoImage(dataUrl) {
    if (!dataUrl) return null;
    const cached = logoImages.get(dataUrl);
    if (cached) return cached.ready ? cached.image : null;

    const entry = { ready: false, image: null };
    logoImages.set(dataUrl, entry);
    while (logoImages.size > MAX_LOGO_IMAGE_CACHE) {
      const oldest = logoImages.keys().next().value;
      if (oldest === dataUrl) break;
      logoImages.delete(oldest);
    }

    const image = new Image();
    image.addEventListener("load", () => {
      entry.image = image;
      entry.ready = true;
      updatePreview();
      renderHistory();
    });
    image.src = dataUrl;
    return null;
  }

  function logoSpanFor(moduleCount, percent) {
    const ratio = Math.min(Math.max(Number(percent) || LOGO_SIZE_DEFAULT_PCT, LOGO_SIZE_MIN_PCT), LOGO_SIZE_MAX_PCT) / 100;
    const target = Math.floor(moduleCount * ratio);
    const odd = target % 2 === 0 ? target - 1 : target;
    const ceiling = moduleCount - 16;
    return Math.min(Math.max(odd, LOGO_MIN_SPAN), Math.max(ceiling, LOGO_MIN_SPAN));
  }

  function buildQrPlan(qr, style, hasLogo) {
    const moduleCount = qr.getModuleCount();
    const margin = style.margin;
    const eyes = [
      { row: 0, column: 0 },
      { row: 0, column: moduleCount - 7 },
      { row: moduleCount - 7, column: 0 },
    ];

    let logoBox = null;
    if (hasLogo) {
      const span = logoSpanFor(moduleCount, style.logoSizePct);
      const start = Math.floor((moduleCount - span) / 2);
      logoBox = { row: start, column: start, span };
    }

    const isInLogo = (row, column) => Boolean(
      logoBox &&
      row >= logoBox.row && row < logoBox.row + logoBox.span &&
      column >= logoBox.column && column < logoBox.column + logoBox.span,
    );
    const isInEye = (row, column) => eyes.some((eye) =>
      row >= eye.row && row < eye.row + 7 && column >= eye.column && column < eye.column + 7);

    const cells = [];
    for (let row = 0; row < moduleCount; row += 1) {
      for (let column = 0; column < moduleCount; column += 1) {
        if (isInEye(row, column) || isInLogo(row, column)) continue;
        if (qr.isDark(row, column)) cells.push([row, column]);
      }
    }

    return { moduleCount, margin, totalModules: moduleCount + margin * 2, eyes, cells, logoBox };
  }

  function squarePath(x, y, size) {
    return `M${x} ${y}h${size}v${size}h${-size}z`;
  }

  function roundedPath(x, y, size, radius) {
    const r = Math.max(0, Math.min(radius, size / 2));
    if (r <= 0) return squarePath(x, y, size);
    const side = size - 2 * r;
    return `M${x + r} ${y}h${side}a${r} ${r} 0 0 1 ${r} ${r}v${side}` +
      `a${r} ${r} 0 0 1 ${-r} ${r}h${-side}a${r} ${r} 0 0 1 ${-r} ${-r}v${-side}` +
      `a${r} ${r} 0 0 1 ${r} ${-r}z`;
  }

  function circlePath(x, y, size) {
    const radius = size * 0.46;
    const centerX = x + size / 2;
    const centerY = y + size / 2;
    return `M${centerX - radius} ${centerY}a${radius} ${radius} 0 1 0 ${2 * radius} 0` +
      `a${radius} ${radius} 0 1 0 ${-2 * radius} 0z`;
  }

  function modulePath(x, y, size, shape) {
    if (shape === "dot") return circlePath(x, y, size);
    if (shape === "rounded") return roundedPath(x, y, size, size * 0.32);
    return squarePath(x, y, size);
  }

  function eyePaths(plan, style, toPixel, unit) {
    const outer = [];
    const background = [];
    const inner = [];
    const outerRadius = style.eyeShape === "leaf" ? 2.4 : 1.5;
    const innerRadius = style.eyeShape === "leaf" ? 1.1 : 0.7;

    for (const eye of plan.eyes) {
      const x = eye.column + plan.margin;
      const y = eye.row + plan.margin;
      if (style.eyeShape === "square") {
        outer.push(squarePath(toPixel(x), toPixel(y), 7 * unit));
        background.push(squarePath(toPixel(x + 1), toPixel(y + 1), 5 * unit));
        inner.push(squarePath(toPixel(x + 2), toPixel(y + 2), 3 * unit));
        continue;
      }
      outer.push(roundedPath(toPixel(x), toPixel(y), 7 * unit, outerRadius * unit));
      background.push(roundedPath(toPixel(x + 1), toPixel(y + 1), 5 * unit, outerRadius * 0.8 * unit));
      inner.push(roundedPath(toPixel(x + 2), toPixel(y + 2), 3 * unit, innerRadius * unit));
    }
    return { outer, background, inner };
  }

  function logoGeometry(plan) {
    if (!plan.logoBox) return null;
    return {
      x: plan.logoBox.column + plan.margin,
      y: plan.logoBox.row + plan.margin,
      size: plan.logoBox.span,
    };
  }

  function gradientLine(angle, total) {
    const radians = (angle * Math.PI) / 180;
    const dx = (Math.cos(radians) * total) / 2;
    const dy = (Math.sin(radians) * total) / 2;
    return {
      x1: (total / 2 - dx).toFixed(3),
      y1: (total / 2 - dy).toFixed(3),
      x2: (total / 2 + dx).toFixed(3),
      y2: (total / 2 + dy).toFixed(3),
    };
  }

  function fillPaths(context, paths) {
    for (const path of paths) {
      context.fill(new Path2D(path));
    }
  }

  function drawQr(canvas, qr, size, options = {}) {
    if (!canvas || !qr) return;
    const style = normalizeStyle(options.style);
    const foreground = options.foreground || "#101b33";
    const background = options.background || "#ffffff";
    const plan = buildQrPlan(qr, style, Boolean(options.logo));

    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;

    const unit = Math.max(1, Math.floor(size / plan.totalModules));
    const origin = Math.floor((size - unit * plan.totalModules) / 2);
    const toPixel = (value) => origin + value * unit;

    context.clearRect(0, 0, size, size);
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);

    const eyes = eyePaths(plan, style, toPixel, unit);
    const dataPaths = [];
    for (const [row, column] of plan.cells) {
      dataPaths.push(modulePath(toPixel(column + plan.margin), toPixel(row + plan.margin), unit, style.moduleShape));
    }

    let paint = foreground;
    if (style.gradient) {
      const line = gradientLine(style.gradient.angle, plan.totalModules);
      const gradient = context.createLinearGradient(
        origin + Number(line.x1) * unit,
        origin + Number(line.y1) * unit,
        origin + Number(line.x2) * unit,
        origin + Number(line.y2) * unit,
      );
      gradient.addColorStop(0, style.gradient.from);
      gradient.addColorStop(1, style.gradient.to);
      paint = gradient;
    }

    context.fillStyle = paint;
    fillPaths(context, dataPaths);
    fillPaths(context, eyes.outer);
    context.fillStyle = background;
    fillPaths(context, eyes.background);
    context.fillStyle = paint;
    fillPaths(context, eyes.inner);

    const logo = logoGeometry(plan);
    const image = options.logo ? getLogoImage(options.logo) : null;
    if (logo) {
      const boxX = toPixel(logo.x);
      const boxY = toPixel(logo.y);
      const boxSize = logo.size * unit;
      context.fillStyle = background;
      context.fill(new Path2D(roundedPath(boxX, boxY, boxSize, unit * 0.9)));
      if (image) {
        const inset = boxSize * 0.12;
        const maxEdge = boxSize - inset * 2;
        const scale = Math.min(maxEdge / image.naturalWidth, maxEdge / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, boxX + (boxSize - width) / 2, boxY + (boxSize - height) / 2, width, height);
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
        style: normalizeStyle(state.style),
        logo: state.logo,
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
        const trackingAvailable = isTrackingUrlReachable(result.qrcode.trackingUrl);
        showToast(
          isUpdate
            ? (trackingAvailable ? "QR code mis à jour." : "QR code mis à jour en mode direct local.")
            : (trackingAvailable ? "QR code enregistré et suivi activé." : "QR code enregistré en mode direct local.")
        );
      }
    } catch (error) {
      if (!isCurrentSession(userId, epoch)) return;
      if (error.status === 401) {
        clearSession();
        openAuthModal("login", "Votre session a expiré. Reconnectez-vous pour continuer.");
        return;
      }
      if (error.status === 402 || error.status === 409) {
        showToast(error.message || "Votre offre ne permet pas cette action.");
        if (error.status === 402) openQuotaModal();
        await loadLibrary();
        renderHistory();
        return;
      }
      showToast(error.message || "Impossible d’enregistrer le QR code.");
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
    const activeCount = state.history.filter((item) => item.isActive !== false).length;
    const totalScans = state.history.reduce((sum, item) => sum + Number(item.scanCount || 0), 0);
    const weeklyScans = state.history.reduce((sum, item) => sum + Number(item.scansWeek || 0), 0);
    elements.historyCount.textContent = String(count).padStart(2, "0");
    elements.libraryMetrics.hidden = !state.user;
    elements.metricQrCount.textContent = formatCompactNumber(count);
    elements.metricScanCount.textContent = formatCompactNumber(totalScans);
    elements.metricWeekCount.textContent = formatCompactNumber(weeklyScans);
    renderEntitlement();

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

    elements.historyGrid.innerHTML = state.history.map((item) => {
      const isActive = item.isActive !== false;
      return `
      <article class="history-card${isActive ? "" : " is-inactive"}" data-history-id="${escapeHtml(item.id)}">
        <div class="history-thumbnail"><canvas width="120" height="120" aria-hidden="true"></canvas></div>
        <div class="history-info">
          <span class="history-type">${item.mode === "contact" ? "Coordonnées" : "Lien"}${isActive ? "" : `<span class="history-state">Désactivé</span>`}</span>
          <strong class="history-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          <span class="history-date">${formatDate(item.createdAt)} · <b>${formatScanCount(item.scanCount)}</b></span>
        </div>
        <div class="history-actions">
          <button class="history-menu stats-action" type="button" data-history-action="stats" aria-label="Voir les statistiques" title="Statistiques">⌁</button>
          <button class="history-menu" type="button" data-history-action="load" aria-label="Charger ce QR code" title="Modifier">↗</button>
          <button class="history-menu ${isActive ? "deactivate-action" : "activate-action"}" type="button" data-history-action="toggle" aria-label="${isActive ? "Désactiver" : "Réactiver"} ce QR code" title="${isActive ? "Désactiver" : "Réactiver"}">${isActive ? "⏸" : "▶"}</button>
          <button class="history-menu delete-action" type="button" data-history-action="delete" aria-label="Supprimer ce QR code" title="Supprimer">×</button>
        </div>
      </article>
    `;
    }).join("");

    $$(".history-card", elements.historyGrid).forEach((card) => {
      const item = state.history.find((entry) => String(entry.id) === card.dataset.historyId);
      if (!item) return;
      const thumbnail = $("canvas", card);
      const qr = createQr(getHistoryPayload(item), { errorCorrectionLevel: item.logo ? "H" : "M" });
      if (qr) {
        drawQr(thumbnail, qr, 120, {
          style: item.style,
          foreground: item.foreground || "#101b33",
          background: item.background || "#ffffff",
          logo: item.logo || null,
        });
      }
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

    if (button.dataset.historyAction === "toggle") {
      const willActivate = item.isActive === false;
      button.disabled = true;
      try {
        const updated = await setQrcodeActive(item.id, willActivate);
        state.history = state.history.map((entry) => (entry.id === updated.id ? updated : entry));
        renderHistory();
        showToast(willActivate ? "QR code réactivé." : "QR code désactivé — il affiche désormais une page d’explication.");
      } catch (error) {
        if (error.status === 402) {
          showToast(error.message || "Votre offre ne permet pas d’activer plus de QR codes.");
          await loadLibrary();
        } else {
          showToast(error.message || "Impossible de modifier ce QR code.");
        }
      } finally {
        button.disabled = false;
      }
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

  async function setQrcodeActive(id, isActive) {
    const result = await api(`/api/qrcodes/${id}/status`, { method: "POST", body: { isActive } });
    return result.qrcode;
  }

  function planLabel() {
    const entitlement = state.entitlement;
    if (!entitlement) return "";
    return entitlement.label || String(entitlement.plan || "").replace(/^./, (letter) => letter.toUpperCase());
  }

  function quotaLimitLabel(limit) {
    return limit === null || limit === undefined ? "Illimité" : formatCompactNumber(limit);
  }

  function renderEntitlement() {
    const entitlement = state.entitlement;
    const signedIn = Boolean(state.user);
    elements.planBadge.hidden = !signedIn;
    elements.quotaMeters.hidden = !signedIn || !entitlement;
    elements.quotaBanner.hidden = !signedIn || !entitlement || !entitlement.overQuota;
    if (!signedIn || !entitlement) return;

    elements.planBadge.textContent = planLabel();
    elements.planBadge.dataset.plan = entitlement.plan;

    setQuotaMeter(
      elements.quotaStoredMeter,
      elements.quotaStoredValue,
      elements.quotaStoredBar,
      entitlement.used,
      entitlement.maxQrcodes
    );
    setQuotaMeter(
      elements.quotaActiveMeter,
      elements.quotaActiveValue,
      elements.quotaActiveBar,
      entitlement.usedActive,
      entitlement.maxActive
    );

    if (entitlement.overQuota) {
      const plan = planLabel();
      const overStored = entitlement.maxQrcodes !== null && entitlement.used > entitlement.maxQrcodes;
      const overActive = entitlement.maxActive !== null && entitlement.usedActive > entitlement.maxActive;
      const details = [];
      if (overStored) {
        details.push(
          `${entitlement.used} QR codes enregistrés pour ${quotaLimitLabel(entitlement.maxQrcodes)} autorisés`
        );
      }
      if (overActive) {
        details.push(
          `${entitlement.usedActive} QR codes actifs pour ${quotaLimitLabel(entitlement.maxActive)} autorisés`
        );
      }
      elements.quotaBannerTitle.textContent = `Votre compte dépasse l’offre ${plan}`;
      elements.quotaBannerDetail.textContent = details.length
        ? `${details.join(" · ")}. Tout continue de fonctionner : choisissez ce que vous désactivez.`
        : "Tout continue de fonctionner.";
      elements.quotaBannerTrim.hidden = !overActive;
    }
  }

  function setQuotaMeter(meter, valueNode, barNode, used, max) {
    const unlimited = max === null || max === undefined;
    meter.classList.toggle("is-unlimited", unlimited);
    meter.classList.toggle("is-over", !unlimited && used > max);
    valueNode.textContent = unlimited ? `${formatCompactNumber(used)} · Illimité` : `${used} / ${formatCompactNumber(max)}`;
    const ratio = unlimited ? 1 : Math.min(1, max > 0 ? used / max : 1);
    barNode.style.width = `${Math.max(0.02, ratio) * 100}%`;
  }

  function openQuotaModal() {
    if (!state.user) {
      openAuthModal("login", "Connectez-vous pour gérer vos QR codes actifs.");
      return;
    }
    const active = state.history.filter((item) => item.isActive !== false);
    const inactive = state.history.filter((item) => item.isActive === false);
    const maxActive = state.entitlement?.maxActive ?? null;
    const headroom = maxActive === null ? active.length : Math.max(0, maxActive - active.length);

    elements.quotaModalIntro.textContent = maxActive === null
      ? `Votre offre autorise un nombre illimité de QR codes actifs. ${inactive.length} sont désactivés, dans un ordre que vous seul choisissez.`
      : `Votre offre ${planLabel()} autorise ${quotaLimitLabel(maxActive)} QR code${maxActive > 1 ? "s" : ""} actif${maxActive > 1 ? "s" : ""} en même temps. ` +
        `Vous pouvez en réactiver ${quotaLimitLabel(headroom)} sans changer d’offre.`;

    elements.quotaModalList.innerHTML = active.map((item) => {
      const lastScan = Number(item.scanCount || 0);
      return `
        <label class="quota-option" data-history-id="${escapeHtml(item.id)}">
          <canvas width="44" height="44" aria-hidden="true"></canvas>
          <span class="quota-option-info">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${lastScan > 0 ? formatScanCount(lastScan) : "Aucun scan"}</span>
          </span>
          <input class="quota-switch" type="checkbox" data-history-id="${escapeHtml(item.id)}" aria-label="Désactiver ${escapeHtml(item.name)}" />
        </label>
      `;
    }).join("");

    $$("canvas", elements.quotaModalList).forEach((canvas) => {
      const option = canvas.closest("[data-history-id]");
      const item = state.history.find((entry) => String(entry.id) === option.dataset.historyId);
      if (!item) return;
      const qr = createQr(getHistoryPayload(item), { errorCorrectionLevel: item.logo ? "H" : "M" });
      if (qr) {
        drawQr(canvas, qr, 44, {
          style: item.style,
          foreground: item.foreground || "#101b33",
          background: item.background || "#ffffff",
          logo: item.logo || null,
        });
      }
    });

    syncQuotaModalConfirm();
    elements.quotaModal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function syncQuotaModalConfirm() {
    const selected = $$(".quota-switch:checked", elements.quotaModalList).length;
    const button = elements.quotaModalConfirm;
    button.disabled = selected === 0;
    button.textContent = selected > 1
      ? `Désactiver ${selected} QR codes`
      : (selected === 1 ? "Désactiver ce QR code" : "Désactiver le surplus");
  }

  async function confirmTrimActiveQrcodes() {
    const targets = $$(".quota-switch:checked", elements.quotaModalList).map((input) => input.dataset.historyId);
    if (!targets.length) return;
    elements.quotaModalConfirm.disabled = true;
    elements.quotaModalConfirm.textContent = "Désactivation…";
    let failed = 0;
    try {
      for (const id of targets) {
        try {
          const updated = await setQrcodeActive(id, false);
          state.history = state.history.map((entry) => (entry.id === updated.id ? updated : entry));
        } catch (error) {
          failed += 1;
          if (error.status !== 402 && error.status !== 404) {
            showToast(error.message || "Impossible de désactiver ce QR code.");
          }
        }
      }
      closeModal("quotaModal");
      await loadLibrary();
      showToast(
        failed
          ? `${targets.length - failed} QR code(s) désactivé(s), ${failed} en échec.`
          : `${targets.length} QR code${targets.length > 1 ? "s" : ""} désactivé${targets.length > 1 ? "s" : ""}.`
      );
    } finally {
      syncQuotaModalConfirm();
    }
  }

  function loadHistoryItem(item) {
    state.editRevision += 1;
    state.foreground = item.foreground || "#101b33";
    state.background = item.background || "#ffffff";
    state.style = normalizeStyle(item.style);
    state.logo = item.logo || null;
    state.logoName = "";
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
    state.style = { ...defaultStyle };
    clearLogo();
    state.currentRecordId = null;
    state.trackingUrl = null;
    state.contentDirty = false;
    state.isDirty = false;
    syncColorInputs();
    syncPresetSelection();
    syncStyleControls();
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
    drawQr(canvas, state.currentQr, 1024, currentRenderOptions());
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
    const style = normalizeStyle(state.style);
    const plan = buildQrPlan(qr, style, Boolean(state.logo));
    const eyes = eyePaths(plan, style, (value) => value, 1);
    const dataPaths = [];
    for (const [row, column] of plan.cells) {
      dataPaths.push(`<path d="${modulePath(column + plan.margin, row + plan.margin, 1, style.moduleShape)}"/>`);
    }

    const definitions = [];
    let foregroundFill = escapeXml(state.foreground);
    if (style.gradient) {
      const line = gradientLine(style.gradient.angle, plan.totalModules);
      definitions.push(
        `<linearGradient id="qraftGradient" gradientUnits="userSpaceOnUse"` +
        ` x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}">` +
        `<stop offset="0" stop-color="${escapeXml(style.gradient.from)}"/>` +
        `<stop offset="1" stop-color="${escapeXml(style.gradient.to)}"/>` +
        `</linearGradient>`,
      );
      foregroundFill = "url(#qraftGradient)";
    }

    const eyeMarkup = [
      `<g fill="${foregroundFill}">${eyes.outer.map((path) => `<path d="${path}"/>`).join("")}</g>`,
      `<g fill="${escapeXml(state.background)}">${eyes.background.map((path) => `<path d="${path}"/>`).join("")}</g>`,
      `<g fill="${foregroundFill}">${eyes.inner.map((path) => `<path d="${path}"/>`).join("")}</g>`,
    ].join("");
    const moduleGroup = `<g fill="${foregroundFill}">${dataPaths.join("")}</g>`;

    const logo = logoGeometry(plan);
    const logoMarkup = logo
      ? `<rect x="${logo.x}" y="${logo.y}" width="${logo.size}" height="${logo.size}"` +
        ` rx="0.9" fill="${escapeXml(state.background)}"/>` +
        (state.logo
          ? `<image href="${escapeXml(state.logo)}" x="${(logo.x + logo.size * 0.12).toFixed(3)}"` +
            ` y="${(logo.y + logo.size * 0.12).toFixed(3)}"` +
            ` width="${(logo.size * 0.76).toFixed(3)}" height="${(logo.size * 0.76).toFixed(3)}"` +
            ` preserveAspectRatio="xMidYMid meet"/>`
          : "")
      : "";

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plan.totalModules} ${plan.totalModules}" role="img" aria-label="${escapeXml(state.currentLabel)}">`,
      `<title>${escapeXml(state.currentLabel)}</title>`,
      definitions.length ? `<defs>${definitions.join("")}</defs>` : "",
      `<rect width="${plan.totalModules}" height="${plan.totalModules}" fill="${escapeXml(state.background)}"/>`,
      moduleGroup,
      eyeMarkup,
      logoMarkup,
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

  function isTrackingUrlReachable(rawUrl) {
    if (!rawUrl) return false;
    try {
      const hostname = new URL(rawUrl).hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "");
      const normalizedHostname = hostname.replace(/^::ffff:/, "");
      if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) return false;
      if (hostname === "0.0.0.0" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return false;
      if (/^127(?:\.\d{1,3}){3}$/.test(normalizedHostname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function getHistoryPayload(item) {
    if (isTrackingUrlReachable(item.trackingUrl)) return item.trackingUrl;
    if (item.mode === "link") return item.destination || defaultLink;
    return buildContactPayload(item.contactData || {});
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
    state.entitlement = result.entitlement || null;
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
    state.style = { ...defaultStyle };
    clearLogo();
    state.currentRecordId = null;
    state.trackingUrl = null;
    state.contentDirty = false;
    state.isDirty = false;
    syncColorInputs();
    syncPresetSelection();
    syncStyleControls();
    setMode("link", { markDirty: false });
    updatePreview();
  }

  function clearSession() {
    state.sessionEpoch += 1;
    state.authAttempt += 1;
    state.isSaving = false;
    state.user = null;
    state.csrfToken = null;
    state.entitlement = null;
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
    if (!elements.quotaModal.hidden) closeModal("quotaModal");
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
        if (result.entitlement) state.entitlement = result.entitlement;
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
    if (elements.authModal.hidden && elements.statsModal.hidden && elements.quotaModal.hidden) {
      document.body.classList.remove("modal-open");
    }
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
    const trackingAvailable = Boolean(state.currentRecordId && isTrackingUrlReachable(state.trackingUrl));
    elements.saveButton.innerHTML = `<span>${icon}</span> ${label}`;
    elements.trackingStatus.classList.toggle("active", trackingAvailable);
    if (state.currentRecordId && !trackingAvailable) {
      elements.trackingStatus.innerHTML = "<span>↗</span> Mode direct local · configurez une origine publique pour activer le suivi.";
    } else if (state.currentRecordId) {
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
