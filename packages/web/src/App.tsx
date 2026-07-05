import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

export function App(): ReactElement {
  const { t } = useTranslation();

  // i18n guard demo: the ESLint rule `i18next/no-literal-string` (scoped to
  // packages/web/src) would REJECT hardcoded JSX text like the following,
  // because the string must be routed through a translation key instead:
  //
  //   return <h1>Terminull 대시보드</h1>;
  //
  // The correct form uses the translation function, as below.
  return <h1>{t('app.title')}</h1>;
}
