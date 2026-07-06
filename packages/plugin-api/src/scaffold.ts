/**
 * Plugin scaffolding — materialises a complete, npm-shaped plugin package that
 * PASSES {@link validatePluginDir} the moment it is written. This is the single
 * source of truth for `terminull plugins scaffold <point> <name>` (the CLI wraps
 * {@link scaffoldPlugin}); the scaffold→validate loop is pinned by
 * `scaffold.test.ts` so every template stays green.
 *
 * NODE-ONLY (`node:fs`/`node:path`): exposed via the `./scaffold` subpath so the
 * pure schema entry point (`.`) stays web-bundle safe, exactly like `./validate`.
 *
 * Three points are FIRST-CLASS (bespoke, useful-out-of-the-box templates):
 * `themes`, `panels`, `locales` — see {@link FIRST_CLASS_POINTS}. The other five
 * points (`adapters`, `renderers`, `keymaps`, `harnessForms`, `commands`) share a
 * generic template: a valid manifest + a stub module the author fills in. Honest:
 * the docs say which three are first-class; all eight produce a validate-green dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTRIBUTION_POINTS,
  PLUGIN_API_VERSION,
  type ContributionPoint,
} from './manifest.js';

/** The contribution points shipped with bespoke, first-class templates. */
export const FIRST_CLASS_POINTS = ['themes', 'panels', 'locales'] as const;
export type FirstClassPoint = (typeof FIRST_CLASS_POINTS)[number];

/** Accept singular (`theme`) or plural (`themes`) point names from the CLI. */
const SINGULAR_ALIASES: Record<string, ContributionPoint> = {
  adapter: 'adapters',
  renderer: 'renderers',
  panel: 'panels',
  theme: 'themes',
  locale: 'locales',
  keymap: 'keymaps',
  harnessForm: 'harnessForms',
  command: 'commands',
};

/**
 * Normalise a user-supplied point name (singular or plural) to the canonical
 * {@link ContributionPoint}, or `null` when it names no contribution point.
 */
export function normalizeScaffoldPoint(input: string): ContributionPoint | null {
  const t = input.trim();
  if ((CONTRIBUTION_POINTS as readonly string[]).includes(t)) {
    return t as ContributionPoint;
  }
  return SINGULAR_ALIASES[t] ?? null;
}

/** Options for {@link scaffoldPlugin}. */
export interface ScaffoldOptions {
  /** Contribution point (plural canonical or singular alias). */
  point: ContributionPoint;
  /**
   * Plugin slug — lowercase letters, digits and hyphens. The package name
   * becomes `terminull-plugin-<name>` and the contribution id becomes `<name>`.
   */
  name: string;
  /** Parent directory; the package is created at `<targetDir>/terminull-plugin-<name>`. */
  targetDir: string;
}

/** Result of {@link scaffoldPlugin}. */
export interface ScaffoldResult {
  /** Absolute path of the created package directory. */
  dir: string;
  /** Package-relative paths of every file written, in write order. */
  files: string[];
  /** True when the requested point has a bespoke template (vs the generic one). */
  firstClass: boolean;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** MIT license body every scaffold ships (placeholder holder — author edits). */
function mitLicense(): string {
  return [
    'MIT License',
    '',
    'Copyright (c) 2026 <your name>',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '',
  ].join('\n');
}

/** Per-point template: the module file it writes + its manifest contribution. */
interface PointTemplate {
  moduleFile: string;
  moduleContent: (name: string) => string;
  /** The one contribution entry (already schema-shaped for this point). */
  contribution: (name: string, moduleRel: string) => Record<string, unknown>;
  /** One-line human summary for the generated README. */
  blurb: string;
}

const PRETTY = (name: string): string =>
  name
    .split('-')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');

const genericModule = (kind: string): string =>
  [
    `/**`,
    ` * ${kind} contribution module — the plugin runtime lazy-loads this file.`,
    ` * Replace the stub with your real implementation, then re-run`,
    ` * \`terminull plugins validate\` until it is green.`,
    ` */`,
    `export default {`,
    `  // TODO: implement this ${kind} contribution.`,
    `};`,
    ``,
  ].join('\n');

const genericJson = (): string => `${JSON.stringify({}, null, 2)}\n`;

const POINT_TEMPLATES: Record<ContributionPoint, PointTemplate> = {
  themes: {
    moduleFile: 'theme.json',
    moduleContent: () =>
      `${JSON.stringify(
        {
          // Token overrides map the web app's --tn-* CSS variables. Override only
          // what you want to change; anything omitted inherits the base theme.
          tokens: {
            '--tn-bg': '#101216',
            '--tn-fg': '#e8eaed',
            '--tn-accent': '#4593fc',
          },
        },
        null,
        2,
      )}\n`,
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      label: { en: PRETTY(name), ko: PRETTY(name) },
      kind: 'dark',
    }),
    blurb: 'a named light/dark theme (token overrides over the web app variables)',
  },
  panels: {
    moduleFile: 'panel.mjs',
    moduleContent: (name) =>
      [
        `/**`,
        ` * Panel contribution module — declarative metadata a future web host`,
        ` * mounts into the layout. Keep it a plain data module (no build step).`,
        ` */`,
        `export default {`,
        `  id: ${JSON.stringify(name)},`,
        `  // Where the panel is expected to mount (sidebar | main | statusbar).`,
        `  location: 'sidebar',`,
        `  // TODO: describe the panel's behaviour / render contract here.`,
        `};`,
        ``,
      ].join('\n'),
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      title: { en: PRETTY(name), ko: PRETTY(name) },
      location: 'sidebar',
    }),
    blurb: 'a UI panel surface (sidebar / main / statusbar)',
  },
  locales: {
    moduleFile: 'messages.json',
    moduleContent: () =>
      `${JSON.stringify(
        {
          app: { name: 'Terminull' },
          common: { close: '', cancel: '', confirm: '' },
        },
        null,
        2,
      )}\n`,
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      // A BCP-47 locale code, e.g. 'ja', 'fr', 'zh-Hans'. Change this!
      locale: 'xx',
      label: { en: PRETTY(name), ko: PRETTY(name) },
    }),
    blurb: 'message resources for one locale code (translate the web app keys)',
  },
  adapters: {
    moduleFile: 'adapter.mjs',
    moduleContent: () =>
      [
        `/**`,
        ` * Adapter contribution module — its default export is the ToolAdapter`,
        ` * FACTORY (a zero-arg function). The runtime invokes it lazily.`,
        ` */`,
        `export default function createAdapter() {`,
        `  // TODO: return a ToolAdapter (see @terminull/adapter-sdk).`,
        `  throw new Error('adapter not implemented');`,
        `}`,
        ``,
      ].join('\n'),
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      displayName: { en: PRETTY(name), ko: PRETTY(name) },
    }),
    blurb: 'a ToolAdapter factory (advanced — the only point with a live factory contract)',
  },
  renderers: {
    moduleFile: 'renderer.mjs',
    moduleContent: () => genericModule('renderer'),
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      displayName: { en: PRETTY(name), ko: PRETTY(name) },
    }),
    blurb: 'a transcript/output renderer for one or more mime types',
  },
  keymaps: {
    moduleFile: 'keymap.json',
    moduleContent: () => genericJson(),
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      label: { en: PRETTY(name), ko: PRETTY(name) },
    }),
    blurb: 'a named set of key bindings a driver can consume',
  },
  harnessForms: {
    moduleFile: 'form.json',
    moduleContent: () => genericJson(),
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      title: { en: PRETTY(name), ko: PRETTY(name) },
    }),
    blurb: "a declarative editor for an adapter's harness files",
  },
  commands: {
    moduleFile: 'command.mjs',
    moduleContent: () => genericModule('command'),
    contribution: (name, moduleRel) => ({
      id: name,
      module: moduleRel,
      title: { en: PRETTY(name), ko: PRETTY(name) },
    }),
    blurb: 'an invocable action surfaced in palettes / menus',
  },
};

function readme(point: ContributionPoint, pkgName: string, tpl: PointTemplate): string {
  return [
    `# ${pkgName}`,
    '',
    `A Terminull plugin scaffolded for the \`${point}\` contribution point:`,
    `${tpl.blurb}.`,
    '',
    '## Edit → validate loop',
    '',
    'The plugin contract is machine-checkable. After every edit, run the oracle',
    'and loop until it is green:',
    '',
    '```sh',
    'terminull plugins validate .',
    '```',
    '',
    'Never modify Terminull core — extend ONLY through the eight contribution',
    'points declared in `terminull.plugin.json`.',
    '',
    '## Files',
    '',
    '- `terminull.plugin.json` — the manifest (the source of truth `validate` reads).',
    `- \`${tpl.moduleFile}\` — the contribution module referenced by the manifest.`,
    '- `package.json` — npm packaging metadata.',
    '',
  ].join('\n');
}

/**
 * Scaffold a complete plugin package at `<targetDir>/terminull-plugin-<name>`.
 * The written directory passes {@link validatePluginDir} with zero errors.
 *
 * @throws Error when `name` is not a valid slug, `point` is unknown, or the
 * target package directory already exists (never clobbers).
 */
export function scaffoldPlugin(opts: ScaffoldOptions): ScaffoldResult {
  const { point, name, targetDir } = opts;
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid plugin name '${name}' — use lowercase letters, digits and hyphens (start with a letter)`,
    );
  }
  const tpl = POINT_TEMPLATES[point];
  if (!tpl) {
    throw new Error(
      `unknown contribution point '${point}' — one of: ${CONTRIBUTION_POINTS.join(', ')}`,
    );
  }

  const pkgName = `terminull-plugin-${name}`;
  const dir = path.join(targetDir, pkgName);
  if (fs.existsSync(dir)) {
    throw new Error(`refusing to overwrite existing directory: ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const moduleRel = `./${tpl.moduleFile}`;
  const manifest = {
    name: pkgName,
    version: '0.1.0',
    pluginApi: `^${PLUGIN_API_VERSION}`,
    displayName: { en: PRETTY(name), ko: PRETTY(name) },
    contributes: {
      [point]: [tpl.contribution(name, moduleRel)],
    },
  };
  const pkg = {
    name: pkgName,
    version: '0.1.0',
    description: `Terminull plugin — ${point} contribution`,
    type: 'module',
    license: 'MIT',
    keywords: ['terminull', 'terminull-plugin', point],
    files: [tpl.moduleFile, 'terminull.plugin.json', 'README.md', 'LICENSE'],
  };

  const write = (rel: string, content: string): string => {
    fs.writeFileSync(path.join(dir, rel), content);
    return rel;
  };
  const files = [
    write('package.json', `${JSON.stringify(pkg, null, 2)}\n`),
    write('terminull.plugin.json', `${JSON.stringify(manifest, null, 2)}\n`),
    write(tpl.moduleFile, tpl.moduleContent(name)),
    write('README.md', readme(point, pkgName, tpl)),
    write('LICENSE', mitLicense()),
  ];

  return {
    dir,
    files,
    firstClass: (FIRST_CLASS_POINTS as readonly string[]).includes(point),
  };
}
