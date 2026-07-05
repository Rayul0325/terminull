import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

/** Bundled, always-available locales. */
const resources = {
  ko: { translation: ko },
  en: { translation: en },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'ko',
  fallbackLng: 'en',
  interpolation: {
    // React already escapes rendered values.
    escapeValue: false,
  },
});

// Japanese currently ships as an empty scaffold. Register it only once it has
// content so an empty locale is never exposed to users. This demonstrates the
// conditional-load path additional locales will use.
if (Object.keys(ja).length > 0) {
  i18n.addResourceBundle('ja', 'translation', ja, true, true);
}

export default i18n;
