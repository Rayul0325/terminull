/**
 * Plugin API — the semver-versioned contract every Terminull plugin declares.
 *
 * A plugin is an npm package (`terminull-plugin-*`) or a built-in, described by
 * a declarative {@link PluginManifest} with lazily-loaded modules. Everything
 * shipped in-tree is itself a plugin (dogfooding), so third-party plugins are
 * structurally equal to first-party ones.
 *
 * This module is PURE: zod schemas + inferred types, zero runtime behaviour.
 * The plugin runtime (semver gate, dedup, error isolation, lazy loading) lives
 * in `@terminull/adapter-sdk`; the adapter/renderer/panel factories those
 * contributions point at are consumed by the SDK, server and web layers.
 *
 * Source of truth moved from `@terminull/shared` in M10 so plugin authors can
 * depend on the PUBLIC `@terminull/plugin-api` package without the private
 * monorepo; `@terminull/shared` re-exports everything here unchanged.
 *
 * i18n rule: every user-facing label ships BOTH `en` and `ko` (see
 * {@link LocalizedText}). The schemas enforce it — a label missing either
 * locale fails validation.
 */
import { z } from 'zod';

/**
 * Current major version of the plugin API. A manifest declares a semver RANGE
 * (`pluginApi`) over this integer; the runtime disables — honestly, with a
 * reason — any plugin whose range does not admit this version.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * A user-facing string in every supported UI locale. `en` and `ko` are
 * mandatory (the two baseline locales); further locales may be added freely.
 */
export interface LocalizedText {
  en: string;
  ko: string;
  [locale: string]: string;
}

/**
 * Schema for {@link LocalizedText}. `en`/`ko` are required and non-empty; any
 * extra key must also be a non-empty-typed string (catchall). This is the
 * single machine-checkable expression of the i18n en+ko rule.
 */
export const LocalizedTextSchema = z
  .object({ en: z.string().min(1), ko: z.string().min(1) })
  .catchall(z.string());

/** The eight contribution points a plugin may extend. */
export const CONTRIBUTION_POINTS = [
  'adapters',
  'renderers',
  'panels',
  'themes',
  'locales',
  'keymaps',
  'harnessForms',
  'commands',
] as const;
export type ContributionPoint = (typeof CONTRIBUTION_POINTS)[number];

// ---------------------------------------------------------------------------
// Contribution schemas
//
// Every contribution carries an `id` (unique per point across all plugins),
// declarative metadata, and a `module` — a plugin-relative import path where
// the factory/data lives, loaded lazily by the runtime. Only AdapterContribution
// has a factory contract exercised now; the other seven are validated metadata
// stored for later web/server consumers.
// ---------------------------------------------------------------------------

/** Adapter: contributes a {@link ToolAdapter} factory (default export of `module`). */
export const AdapterContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    displayName: LocalizedTextSchema,
  })
  .strict();
export type AdapterContribution = z.infer<typeof AdapterContributionSchema>;

/** Renderer: renders transcript items / session output for one or more mime types. */
export const RendererContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    displayName: LocalizedTextSchema,
    mimeTypes: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type RendererContribution = z.infer<typeof RendererContributionSchema>;

/** Panel: a UI surface (sidebar/main/statusbar). */
export const PanelContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    title: LocalizedTextSchema,
    location: z.enum(['sidebar', 'main', 'statusbar']).optional(),
  })
  .strict();
export type PanelContribution = z.infer<typeof PanelContributionSchema>;

/** Theme: a named light/dark visual theme. */
export const ThemeContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    label: LocalizedTextSchema,
    kind: z.enum(['light', 'dark']),
  })
  .strict();
export type ThemeContribution = z.infer<typeof ThemeContributionSchema>;

/** Locale: adds message resources for one locale code. */
export const LocaleContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    locale: z.string().min(1),
    label: LocalizedTextSchema,
  })
  .strict();
export type LocaleContribution = z.infer<typeof LocaleContributionSchema>;

/** Keymap: a named set of key bindings a driver can consume. */
export const KeymapContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    label: LocalizedTextSchema,
  })
  .strict();
export type KeymapContribution = z.infer<typeof KeymapContributionSchema>;

/** Harness form: a declarative editor for an adapter's harness files. */
export const HarnessFormContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    title: LocalizedTextSchema,
    targets: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type HarnessFormContribution = z.infer<typeof HarnessFormContributionSchema>;

/** Command: an invocable action surfaced in palettes/menus. */
export const CommandContributionSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    title: LocalizedTextSchema,
  })
  .strict();
export type CommandContribution = z.infer<typeof CommandContributionSchema>;

/** The `contributes` block: every point optional, unknown keys rejected. */
export const ContributesSchema = z
  .object({
    adapters: z.array(AdapterContributionSchema).optional(),
    renderers: z.array(RendererContributionSchema).optional(),
    panels: z.array(PanelContributionSchema).optional(),
    themes: z.array(ThemeContributionSchema).optional(),
    locales: z.array(LocaleContributionSchema).optional(),
    keymaps: z.array(KeymapContributionSchema).optional(),
    harnessForms: z.array(HarnessFormContributionSchema).optional(),
    commands: z.array(CommandContributionSchema).optional(),
  })
  .strict();
export type Contributes = z.infer<typeof ContributesSchema>;

/**
 * A plugin manifest. `pluginApi` is a semver range over {@link PLUGIN_API_VERSION}
 * (e.g. `'^1'`, `'>=1 <2'`, `'1'`). The runtime disables — never half-loads —
 * a plugin whose range does not admit the running API version.
 */
export const PluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    pluginApi: z.string().min(1),
    displayName: LocalizedTextSchema.optional(),
    contributes: ContributesSchema,
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
