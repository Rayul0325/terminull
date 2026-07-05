/**
 * The canonical list of translation keys the app relies on. Every locale that
 * ships (currently ko and en) MUST define each of these keys; the i18n test
 * enforces parity so a missing translation fails CI rather than the UI.
 */
export const I18N_KEYS = ['app.title'] as const;

export type I18nKey = (typeof I18N_KEYS)[number];
