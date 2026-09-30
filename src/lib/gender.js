/**
 * Customer gender — one canonical vocabulary for the whole backend.
 *
 * Four values, and the distinction between the last two matters:
 *
 *  - MALE / FEMALE  — the customer told us.
 *  - OTHER          — the customer told us, and picked neither.
 *  - UNSPECIFIED    — nobody ever asked. Legacy rows, and walk-in accounts
 *                     created before reception fills the field in.
 *
 * Collapsing "never asked" into OTHER is what let men see women's reward
 * cards: anything that isn't MALE/FEMALE used to fall through to "show every
 * card", and because signup pre-selected Other, that was effectively everyone.
 * Keeping UNSPECIFIED separate means callers can tell "no answer" from "an
 * answer of Other" and prompt for the former instead of guessing.
 */
export const GENDER_MALE = "MALE"
export const GENDER_FEMALE = "FEMALE"
export const GENDER_OTHER = "OTHER"
export const GENDER_UNSPECIFIED = "UNSPECIFIED"

/** Everything the `users.gender` CHECK constraint permits. */
export const CUSTOMER_GENDERS = [GENDER_MALE, GENDER_FEMALE, GENDER_OTHER, GENDER_UNSPECIFIED]

/** What a human is allowed to pick in a form. UNSPECIFIED is a system state, never an option. */
export const SELECTABLE_GENDERS = [GENDER_MALE, GENDER_FEMALE, GENDER_OTHER]

/**
 * Validates a gender supplied by a user (signup form, reception walk-in form).
 * Returns null for anything that isn't a real choice, so callers can reject the
 * request rather than store a guess.
 *
 * @param {unknown} value
 * @returns {"MALE" | "FEMALE" | "OTHER" | null}
 */
export function parseSelectableGender(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase()
  return SELECTABLE_GENDERS.includes(normalized) ? normalized : null
}

/**
 * Coerces a stored/incoming value to a column-safe gender. Anything unrecognized
 * becomes UNSPECIFIED — never MALE/FEMALE/OTHER — so a bad value can't silently
 * masquerade as an answer the customer gave.
 *
 * @param {unknown} value
 * @returns {"MALE" | "FEMALE" | "OTHER" | "UNSPECIFIED"}
 */
export function normalizeCustomerGender(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase()
  return CUSTOMER_GENDERS.includes(normalized) ? normalized : GENDER_UNSPECIFIED
}

/**
 * True when the customer has actually answered — i.e. anything gender-aware
 * (reward-card eligibility, stylist segments) can trust the value.
 *
 * @param {unknown} value
 */
export function hasStatedGender(value) {
  return normalizeCustomerGender(value) !== GENDER_UNSPECIFIED
}
