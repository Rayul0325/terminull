/**
 * Harness-editor render tests (M9 W2, oracle b UI half). Honesty-critical
 * renders: manifest rows show the KOREAN label + risk badge (+ honest
 * missing/directory chips), the '내 커스텀' group is read-only-badged with its
 * detected items, a 422 outcome shows the parser message VERBATIM, a 409
 * outcome opens the conflict sheet with the reload action, danger files wear
 * the warning chrome, and the toml lint depth is reported as lint — never
 * dressed up as a full parse. Static markup; harness store hook re-pointed at
 * live getState() per the established pattern.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HarnessFileDto, HarnessReadDto } from '@terminull/shared';
import i18n from '../i18n';
import ko from '../i18n/locales/ko.json';
import { useHarnessStore, type HarnessFileEditState } from '../stores/harness';
import { CustomGroupCard, FileRow, HarnessFileEditor, SaveOutcomeNote } from './HarnessSection';

vi.mock('../stores/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/harness')>();
  const real = actual.useHarnessStore;
  const live = Object.assign(
    (selector?: (s: ReturnType<typeof real.getState>) => unknown) =>
      selector ? selector(real.getState()) : real.getState(),
    real,
  ) as unknown as typeof real;
  return { ...actual, useHarnessStore: live };
});

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  useHarnessStore.setState({
    groups: [],
    loaded: false,
    errorCode: null,
    custom: null,
    customErrorCode: null,
    files: {},
  });
});

const SHA_A = 'a'.repeat(64);

function spec(overrides: Partial<HarnessFileDto> = {}): HarnessFileDto {
  return {
    id: 'claude.settings',
    toolId: 'claude',
    label: { en: 'Settings', ko: '설정 파일' },
    description: { en: 'Hook/permission settings', ko: '훅·권한 설정' },
    format: 'json',
    scope: 'user',
    riskLevel: 'high',
    path: '/fake/home/.claude/settings.json',
    exists: true,
    ...overrides,
  };
}

function fileState(overrides: Partial<HarnessFileEditState> = {}): HarnessFileEditState {
  const read: HarnessReadDto = {
    fileId: 'claude.settings',
    toolId: 'claude',
    path: '/fake/home/.claude/settings.json',
    exists: true,
    content: '{}',
    sha: SHA_A,
    size: 2,
    mtime: 1,
  };
  return {
    fileId: 'claude.settings',
    read,
    draft: '{}',
    loading: false,
    readErrorCode: null,
    saving: false,
    outcome: null,
    backups: null,
    backupsErrorCode: null,
    ...overrides,
  };
}

describe('manifest rows', () => {
  it('renders the Korean label, risk badge, and honest missing chip', () => {
    const html = renderToStaticMarkup(
      <FileRow
        spec={spec({ exists: false, riskLevel: 'high' })}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('설정 파일');
    expect(html).toContain(ko.settings.agent.risk.high);
    expect(html).toContain(ko.harness.missing);
  });

  it('directory specs are listed but marked not editable', () => {
    const html = renderToStaticMarkup(
      <FileRow
        spec={spec({ id: 'claude.skills', directory: true, format: 'other', riskLevel: 'low' })}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain(ko.harness.directory);
    expect(html).toContain('disabled');
  });
});

describe('내 커스텀 group', () => {
  it('renders the read-only badge, detected items, and honest truncation', () => {
    const html = renderToStaticMarkup(
      <CustomGroupCard
        group={{
          id: 'custom',
          scannedAt: 1000,
          truncated: true,
          items: [
            {
              kind: 'hook',
              toolId: 'claude',
              path: '/fake/home/.claude/settings.json',
              label: 'Stop',
              detail: 'format-batch.sh',
            },
            { kind: 'skill', toolId: 'claude', path: '/fake/home/.claude/skills/x', label: 'x' },
          ],
        }}
      />,
    );
    expect(html).toContain(ko.harness.customGroup);
    expect(html).toContain(ko.harness.customReadOnly);
    expect(html).toContain(ko.harness.customTruncated);
    expect(html).toContain(ko.harness.kind.hook);
    expect(html).toContain('format-batch.sh');
    expect(html).toContain(ko.harness.kind.skill);
  });

  it('an empty scan renders the honest empty note', () => {
    const html = renderToStaticMarkup(
      <CustomGroupCard group={{ id: 'custom', scannedAt: 1, truncated: false, items: [] }} />,
    );
    expect(html).toContain(ko.harness.customEmpty);
  });
});

describe('save outcomes', () => {
  it('422 renders the parser message VERBATIM with format and line', () => {
    const html = renderToStaticMarkup(
      <SaveOutcomeNote
        outcome={{
          kind: 'parse_invalid',
          format: 'json',
          detail: "Expected '}' but found end of input at position 11",
          line: 3,
        }}
      />,
    );
    expect(html).toContain(i18n.t('harness.parseError', { format: 'json' }));
    expect(html).toContain(i18n.t('harness.parseErrorLine', { line: 3 }));
    expect(html).toContain('Expected &#x27;}&#x27; but found end of input at position 11');
  });

  it('a lint-level save says lint — never dressed up as a full parse', () => {
    const html = renderToStaticMarkup(
      <SaveOutcomeNote outcome={{ kind: 'saved', validation: 'lint', sha: SHA_A }} />,
    );
    expect(html).toContain(ko.harness.validation.lint);
    expect(html).not.toContain(ko.harness.validation.full);
  });
});

describe('editor chrome', () => {
  it('a 409 conflict opens the conflict sheet with the reload action', () => {
    useHarnessStore.setState({
      files: {
        'claude.settings': fileState({
          draft: '{"mine":1}',
          outcome: { kind: 'conflict', currentSha: 'b'.repeat(64) },
        }),
      },
    });
    const html = renderToStaticMarkup(<HarnessFileEditor spec={spec()} />);
    expect(html).toContain(ko.harness.conflict.title);
    expect(html).toContain(ko.harness.conflict.body);
    expect(html).toContain(ko.harness.conflict.reload);
  });

  it('danger files wear the warning chrome; low-risk files do not', () => {
    useHarnessStore.setState({ files: { 'claude.settings': fileState() } });
    const danger = renderToStaticMarkup(<HarnessFileEditor spec={spec()} />);
    expect(danger).toContain(ko.harness.editor.dangerNote);

    useHarnessStore.setState({
      files: { 'claude.md.global': fileState({ fileId: 'claude.md.global' }) },
    });
    const low = renderToStaticMarkup(
      <HarnessFileEditor
        spec={spec({ id: 'claude.md.global', riskLevel: 'low', format: 'markdown' })}
      />,
    );
    expect(low).not.toContain(ko.harness.editor.dangerNote);
  });

  it('no guided form is specced in v1 → no guided/raw toggle renders', () => {
    useHarnessStore.setState({ files: { 'claude.settings': fileState() } });
    const html = renderToStaticMarkup(<HarnessFileEditor spec={spec()} />);
    expect(html).not.toContain(ko.harness.editor.guided);
  });
});
