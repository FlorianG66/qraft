// Règles de facturation pures : ni base de données, ni réseau, ni configuration.
// Elles sont séparées du serveur pour être vérifiées directement, car une
// erreur ici décide silencieusement qui a le droit d'utiliser quoi.

/** Fenêtre de grâce après `current_period_end`, en millisecondes. */
export const GRACE_PERIOD_MS = 48 * 60 * 60 * 1_000;

/** Statuts Stripe qui ouvrent un droit, sans condition de date. */
export const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

/** Statuts Stripe connus : tout le reste est traité comme `incomplete`. */
export const KNOWN_STATUSES = new Set([
  "active", "trialing", "past_due", "canceled", "unpaid", "paused", "incomplete", "incomplete_expired",
]);

/** Un statut jamais vu ne doit surtout pas ouvrir de droit. */
export function normalizeStripeStatus(value) {
  const status = String(value ?? "").trim().slice(0, 32);
  return KNOWN_STATUSES.has(status) ? status : "incomplete";
}

/**
 * Fin de période de facturation en millisecondes.
 *
 * Depuis l'API Stripe 2025-03-31, la période vit sur l'item d'abonnement et
 * non plus sur l'abonnement. Les deux lectures sont conservées pour que le
 * serveur ne dépende pas du pin de version du SDK.
 */
export function readPeriodEnd(subscription) {
  if (typeof subscription?.current_period_end === "number") return subscription.current_period_end * 1_000;
  const item = subscription?.items?.data?.[0];
  if (item && typeof item.current_period_end === "number") return item.current_period_end * 1_000;
  return null;
}

/**
 * Échéance de la grâce, ou `null` si l'abonnement reste couvert.
 *
 * La grâce ne court qu'après une perte d'accès volontaire : une résiliation
 * demandée en cours de période n'ouvre aucune fenêtre.
 */
export function computeGraceUntil(status, periodEnd, timestamp) {
  if (status !== "canceled" && status !== "paused") return null;
  if (periodEnd === null) return timestamp;
  return periodEnd + GRACE_PERIOD_MS;
}

/**
 * Paramètres de la session Stripe Checkout.
 *
 * `automatic_tax` porte la TVA, `billing_address_collection` fournit à Stripe
 * la localisation du client nécessaire pour la calculer, et
 * `subscription_data.metadata` porte l'offre : c'est cette métadonnée, et non
 * le Price, qui fait foi à la lecture du webhook.
 */
export function buildCheckoutParams({ userId, plan, customerId, priceId, publicOrigin }) {
  return {
    mode: "subscription",
    customer: customerId,
    client_reference_id: String(userId),
    line_items: [{ price: priceId, quantity: 1 }],
    automatic_tax: { enabled: true },
    payment_method_collection: "always",
    billing_address_collection: "required",
    customer_update: { address: "auto", name: "auto" },
    allow_promotion_codes: true,
    subscription_data: { metadata: { plan, qraft_user_id: String(userId) } },
    success_url: `${publicOrigin}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicOrigin}/?billing=cancelled`,
  };
}

// Aucun secret ne doit atteindre le journal du serveur, y compris quand il est
// embarqué dans le message d'une erreur du SDK Stripe. La famille du secret est
// conservée : elle suffit à diagnostiquer une variable mal configurée, sans
// jamais divulguer la clé.
const SECRET_FAMILIES = [
  // L'en-tête d'autorisation est traité en premier : c'est lui qui porte la clé,
  // et son masquage doit précéder celui du seul préfixe.
  /\bBearer\s+[^\s"'(),;]+/gi,
  // Forme brute (`sk_live_51H…`) et forme déjà partiellement masquée par Stripe
  // (`sk_live_****…` ou `sk_live_…7890`). Les étoiles et les points sont le piège :
  // un motif trop strict laisse passer la fin de la clé. On consomme donc tout ce
  // qui n'est pas séparateur, quitte à absorber une ponctuation — un défaut qui
  // fait disparaître le secret plutôt que de le laisser fuir.
  /\b(sk|rk|pk)_(?:live|test)_[^\s"'(),;]+/g,
  /\bwhsec_[^\s"'(),;]+/g,
];

export function redactSecrets(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const pattern of SECRET_FAMILIES) {
    text = text.replace(pattern, (match) => {
      if (/^bearer/i.test(match)) return "Bearer [redacted]";
      const family = /^whsec_/i.test(match) ? "whsec" : match.split("_")[0];
      return `${family}_[redacted]`;
    });
  }
  return text;
}
