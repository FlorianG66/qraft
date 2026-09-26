import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTITLED_STATUSES,
  GRACE_PERIOD_MS,
  buildCheckoutParams,
  computeGraceUntil,
  normalizeStripeStatus,
  readPeriodEnd,
  redactSecrets,
} from "../billing-rules.mjs";

test("règles de facturation : période lue sur l'abonnement et sur l'item", () => {
  // Ancienne forme : la période est portée par l'abonnement.
  assert.equal(readPeriodEnd({ current_period_end: 1_700_000_000 }), 1_700_000_000_000);
  // Forme actuelle depuis l'API 2025-03-31 : la période est portée par l'item.
  assert.equal(
    readPeriodEnd({ items: { data: [{ current_period_end: 1_700_000_000 }] } }),
    1_700_000_000_000
  );
  // Sans période exploitable, aucune date inventée.
  assert.equal(readPeriodEnd({ items: { data: [{}] } }), null);
  assert.equal(readPeriodEnd({}), null);
  assert.equal(readPeriodEnd(null), null);
});

test("règles de facturation : un statut inconnu n’accorde aucun droit", () => {
  for (const status of ["active", "trialing", "past_due", "canceled", "unpaid", "paused", "incomplete", "incomplete_expired"]) {
    assert.equal(normalizeStripeStatus(status), status, `${status} doit passer tel quel`);
  }
  // Le choix conservateur : ne jamais ouvrir un droit sur un statut non lu.
  for (const status of ["", null, undefined, "paused_by_stripe", "ACTIVE", 42, "future_status"]) {
    assert.equal(normalizeStripeStatus(status), "incomplete", `${status} ne doit rien ouvrir`);
  }
  assert.equal(ENTITLED_STATUSES.has("incomplete"), false);
  assert.equal(ENTITLED_STATUSES.has("active"), true);
  assert.equal(ENTITLED_STATUSES.has("past_due"), true);
});

test("règles de facturation : la grâce de 48 h ne court qu’après une perte d’accès", () => {
  const periodEnd = 1_700_000_000_000;
  const now = periodEnd + 5_000;

  // Résiliation en cours de période : l'accès n'a pas encore été perdu.
  assert.equal(computeGraceUntil("active", periodEnd, now), null);
  assert.equal(computeGraceUntil("trialing", periodEnd, now), null);
  assert.equal(computeGraceUntil("past_due", periodEnd, now), null);
  assert.equal(computeGraceUntil("unpaid", periodEnd, now), null);

  // Période finie il y a cinq secondes : la grâce court encore 47 h 59 min 55 s.
  assert.equal(computeGraceUntil("canceled", periodEnd, now), periodEnd + GRACE_PERIOD_MS);
  assert.equal(computeGraceUntil("paused", periodEnd, now), periodEnd + GRACE_PERIOD_MS);
  assert.ok(computeGraceUntil("canceled", periodEnd, now) > now, "la grâce vient de commencer");

  // 48 h pile après la fin de période : la grâce est éteinte, pas réarmée.
  assert.equal(
    computeGraceUntil("canceled", periodEnd, periodEnd + GRACE_PERIOD_MS),
    periodEnd + GRACE_PERIOD_MS
  );
  assert.equal(!(computeGraceUntil("canceled", periodEnd, periodEnd + GRACE_PERIOD_MS) > periodEnd + GRACE_PERIOD_MS), true);

  // Checkout abandonné : jamais de grâce, la grâce est vide.
  assert.equal(computeGraceUntil("incomplete", periodEnd, now), null);
  assert.equal(computeGraceUntil("incomplete_expired", periodEnd, now), null);

  // Sans période connue, la grâce est déjà expirée plutôt qu'infinie.
  assert.equal(computeGraceUntil("canceled", null, now), now);
});

test("règles de facturation : la session Checkout impose Tax et collecte la carte", () => {
  const params = buildCheckoutParams({
    userId: 42,
    plan: "pro",
    customerId: "cus_123",
    priceId: "price_123",
    publicOrigin: "https://qr.example.com",
  });

  assert.equal(params.mode, "subscription", "un seul Checkout récurrent, aucun paiement ponctuel");
  assert.deepEqual(params.automatic_tax, { enabled: true }, "Stripe Tax doit porter la TVA");
  assert.equal(params.billing_address_collection, "required", "Stripe a besoin de la localisation pour la TVA");
  assert.equal(params.payment_method_collection, "always", "la carte doit être enregistrée pour le renouvellement");
  assert.equal(params.customer, "cus_123");
  assert.equal(params.client_reference_id, "42");
  assert.deepEqual(params.line_items, [{ price: "price_123", quantity: 1 }]);
  assert.equal(params.customer_update.address, "auto", "l’adresse doit alimenter la fiscalité");
  assert.equal(params.subscription_update, undefined, "un abonnement déjà vivant ne doit jamais être réécrit");

  // L'offre voyage dans la métadonnée : c'est elle qui fait foi au webhook.
  assert.deepEqual(params.subscription_data.metadata, { plan: "pro", qraft_user_id: "42" });

  assert.equal(params.success_url, "https://qr.example.com/?billing=success&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(params.cancel_url, "https://qr.example.com/?billing=cancelled");

  // Le gabarit `{CHECKOUT_SESSION_ID}` doit rester intact : Stripe le remplace.
  assert.ok(params.success_url.includes("{CHECKOUT_SESSION_ID}"));
  // Aucune URL ne doit être construite sur une origine injectable par le client.
  assert.ok(!params.success_url.startsWith("http://localhost"));
});

test("règles de facturation : aucun secret ne survit au masquage", () => {
  // Forme brute, telle qu'elle apparaît dans un message d'erreur du SDK.
  const brut = "Invalid API Key provided: sk_live_51H8xQraCdefGHIjklMNOpq.7890";
  const masque = redactSecrets(brut);
  assert.ok(!masque.includes("51H8xQraCdefGHIjklMNOpq"), "la clé brute doit disparaître");
  assert.ok(!masque.includes("7890"), "la queue de la clé doit disparaître");
  // La famille reste lisible, c'est tout ce qu'il faut pour diagnostiquer.
  assert.ok(masque.startsWith("Invalid API Key provided: sk_[redacted]"));

  // Forme déjà partially masquée par Stripe : les étoiles sont le piège, un motif
  // trop strict laisse passer la fin de la clé.
  const starred = "Invalid API Key provided: sk_test_**************************7890";
  const masqueStar = redactSecrets(starred);
  assert.ok(!masqueStar.includes("7890"), "la forme étoilée doit être masquée aussi");
  assert.equal(masqueStar, "Invalid API Key provided: sk_[redacted]");

  // Secret de webhook et en-tête d'autorisation.
  assert.equal(redactSecrets("bad sig whsec_abcDEF123456"), "bad sig whsec_[redacted]");
  assert.equal(redactSecrets("Authorization: Bearer sk_test_zzz"), "Authorization: Bearer [redacted]");

  // Un identifiant public n'est pas un secret : le masquer serait illisible.
  const publicId = redactSecrets("Price price_1AbCdEfGhIjKlMnOpQrSt non lisible");
  assert.equal(publicId, "Price price_1AbCdEfGhIjKlMnOpQrSt non lisible");

  // Un jeton qui n'est pas de la famille Stripe reste visible.
  assert.equal(redactSecrets("price_sonde_pro"), "price_sonde_pro");

  assert.equal(redactSecrets(undefined), "");
  assert.equal(redactSecrets(null), "");
});
