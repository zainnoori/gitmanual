// Links into the Stripe dashboard for the admin pages, where refunds and plan changes are done. Safe in the browser:
// only ids, no keys. Test-mode checkouts (cs_test_) open the test dashboard.
const BASE = "https://dashboard.stripe.com";

export const stripePurchaseUrl = (session: string) => `${BASE}${session.startsWith("cs_test_") ? "/test" : ""}/search?query=${encodeURIComponent(session)}`;
export const stripeSubscriptionUrl = (subscription: string) => `${BASE}/subscriptions/${encodeURIComponent(subscription)}`;
export const stripeCustomerUrl = (customer: string) => `${BASE}/customers/${encodeURIComponent(customer)}`;
