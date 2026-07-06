/**
 * `/api/tools/*` — per-tool adapter surfaces: registry listing, usage gauges,
 * account info, profile switching and harness install/preview.
 *
 * Error contract (capability honesty, per the M7 contract):
 *  - unknown `:toolId` → 404 `not_found`;
 *  - known tool but missing surface, or a typed `AdapterUnsupportedError` →
 *    422 `{code:'adapter_unsupported', operation, reason?}` — the LocalizedText
 *    `reason` appears ONLY when the adapter supplied one (the server never
 *    authors prose).
 */
import fs from 'node:fs';
import type http from 'node:http';
import { z } from 'zod';
import type {
  HarnessContext,
  HarnessInjector,
  HarnessStatus,
  ToolAdapter,
  UsageInfo,
} from '@terminull/adapter-sdk';
import type { EventStore } from '@terminull/core';
import type {
  Actor,
  LocalizedText,
  UsageFreshness,
  UsageGaugeDto,
  UsageWindowDto,
} from '@terminull/shared';
import type { GateResult } from './confirmations.js';
import { Router, fail, json, readJsonBody } from './http-util.js';

const SwitchProfileSchema = z.object({ profileId: z.string().min(1) }).strict();

/** What the tool routes borrow from the server. */
export interface ToolsRouteDeps {
  adapters: Map<string, ToolAdapter>;
  store: EventStore;
  /** Harness/account context (home = collectHome in tests, real home in prod). */
  harnessCtx(): HarnessContext;
  /** The server's single permission decision point (bound closure). */
  gate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    action: string,
    opts: { params?: unknown; execute: (actor: Actor) => Promise<GateResult> },
  ): Promise<void>;
}

/**
 * Extract a plain LocalizedText from an adapter note. Codex wraps its stale
 * caveat as `{key, text: {en, ko}}` (i18n-keyed); others may pass `{en, ko}`
 * directly. Anything else is dropped — never coerced into fake prose.
 */
function localizedNote(raw: unknown): LocalizedText | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o['en'] === 'string' && typeof o['ko'] === 'string') {
    return { en: o['en'], ko: o['ko'] };
  }
  const inner = o['text'];
  if (inner !== null && typeof inner === 'object') {
    const t = inner as Record<string, unknown>;
    if (typeof t['en'] === 'string' && typeof t['ko'] === 'string') {
      return { en: t['en'], ko: t['ko'] };
    }
  }
  return undefined;
}

/** Fold an adapter's `UsageInfo` (+ codex extensions) into a `UsageGaugeDto`. */
function foldUsage(toolId: string, value: UsageInfo): UsageGaugeDto {
  const v = value as UsageInfo & { windows?: unknown; asOf?: unknown; note?: unknown };
  const windows: UsageWindowDto[] = [];
  if (Array.isArray(v.windows)) {
    for (const w of v.windows) {
      if (w === null || typeof w !== 'object') continue;
      const o = w as Record<string, unknown>;
      if (typeof o['label'] !== 'string' || typeof o['usedPercent'] !== 'number') continue;
      windows.push({
        label: o['label'],
        usedPercent: o['usedPercent'],
        ...(typeof o['resetsAt'] === 'number' ? { resetsAt: o['resetsAt'] } : {}),
        ...(typeof o['slot'] === 'string' ? { slot: o['slot'] } : {}),
      });
    }
  } else if (typeof v.used === 'number' && typeof v.limit === 'number' && v.limit > 0) {
    windows.push({ label: 'total', usedPercent: (v.used / v.limit) * 100 });
  }
  // Codex only refreshes rate limits when a turn runs (contract-pinned); every
  // other adapter's numbers are read live at request time.
  const freshness: UsageFreshness = toolId === 'codex' ? 'stale-turn-gated' : 'live';
  const note = localizedNote(v.note);
  return {
    toolId,
    available: true,
    windows,
    freshness,
    ...(typeof v.asOf === 'number' ? { asOf: v.asOf } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/** Register every `/api/tools*` route on the server's router. */
export function registerToolsRoutes(r: Router, deps: ToolsRouteDeps): void {
  const adapterOr404 = (
    res: http.ServerResponse,
    toolId: string | undefined,
  ): ToolAdapter | null => {
    const adapter = deps.adapters.get(toolId ?? '');
    if (!adapter) {
      fail(res, 404, 'not_found', { toolId: toolId ?? '' });
      return null;
    }
    return adapter;
  };

  r.add('GET', '/api/tools', (_req, res) => {
    const tools = [...deps.adapters.values()].map((a) => ({
      id: a.id,
      displayName: a.displayName,
      // DECLARED capabilities only. Presence is deliberately not reported here:
      // probing shells out to the tool binary, and an unprobed tool must read
      // as "not checked", never as a fabricated true/false.
      capabilities: a.capabilities,
    }));
    json(res, 200, { tools });
  });

  r.add('GET', '/api/tools/:toolId/usage', async (_req, res, params) => {
    const adapter = adapterOr404(res, params['toolId']);
    if (!adapter) return;
    if (!adapter.accounts) {
      fail(res, 422, 'adapter_unsupported', { operation: 'usage' });
      return;
    }
    const result = await adapter.accounts.usage(deps.harnessCtx());
    if (!result.available) {
      const dto: UsageGaugeDto = {
        toolId: adapter.id,
        available: false,
        windows: [],
        freshness: 'live',
        reason: result.reason,
      };
      json(res, 200, dto);
      return;
    }
    json(res, 200, foldUsage(adapter.id, result.value));
  });

  r.add('GET', '/api/tools/:toolId/account', async (_req, res, params) => {
    const adapter = adapterOr404(res, params['toolId']);
    if (!adapter) return;
    if (!adapter.accounts) {
      fail(res, 422, 'adapter_unsupported', { operation: 'account' });
      return;
    }
    // Pure passthrough of the adapter's honest AccountResults — identity is
    // whatever the adapter is WILLING to read (codex: presence only, never
    // credential bodies).
    const ctx = deps.harnessCtx();
    const [whoami, profiles] = await Promise.all([
      adapter.accounts.whoami(ctx),
      adapter.accounts.listProfiles(ctx),
    ]);
    json(res, 200, { toolId: adapter.id, whoami, profiles });
  });

  r.add('POST', '/api/tools/:toolId/account/switch', async (req, res, params) => {
    const adapter = adapterOr404(res, params['toolId']);
    if (!adapter) return;
    const body = SwitchProfileSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    await deps.gate(req, res, 'account.switch', {
      params: { toolId: adapter.id, profileId: body.data.profileId },
      execute: async (actor) => {
        if (!adapter.accounts) {
          return { status: 422, body: { code: 'adapter_unsupported', operation: 'account.switch' } };
        }
        const result = await adapter.accounts.switchProfile(body.data.profileId, deps.harnessCtx());
        if (!result.available) {
          return {
            status: 422,
            body: {
              code: 'adapter_unsupported',
              operation: 'account.switch',
              reason: result.reason,
            },
          };
        }
        deps.store.append('account.profile_switched', {
          actor,
          tool: adapter.id,
          payload: { toolId: adapter.id, profileId: result.value.id },
        });
        return { status: 200, body: { switched: true, profile: result.value } };
      },
    });
  });

  r.add('GET', '/api/tools/:toolId/harness', async (_req, res, params) => {
    const adapter = adapterOr404(res, params['toolId']);
    if (!adapter) return;
    const ctx = deps.harnessCtx();
    let injectorStatus: HarnessStatus | null = null;
    let preview: unknown;
    if (adapter.injector) {
      // verify() is the honest state: a pending/hash-trust condition surfaces
      // as installed:false + detail — never silent-green.
      injectorStatus = await adapter.injector.verify(ctx);
      const planFn = (adapter.injector as HarnessInjector & {
        plan?: (c: HarnessContext) => Promise<unknown>;
      }).plan;
      if (typeof planFn === 'function') {
        try {
          preview = await planFn.call(adapter.injector, ctx);
        } catch {
          // A preview failure must not take down the status read.
          preview = undefined;
        }
      }
    }
    const files = (adapter.harnessFiles ?? []).map((spec) => {
      let resolved: string | undefined;
      try {
        resolved = spec.path ?? spec.pathResolver?.(ctx);
      } catch {
        resolved = undefined;
      }
      return {
        id: spec.id,
        label: spec.label,
        description: spec.description,
        format: spec.format,
        scope: spec.scope,
        riskLevel: spec.riskLevel,
        ...(resolved !== undefined ? { path: resolved, exists: fs.existsSync(resolved) } : {}),
        ...(spec.mayNotExist !== undefined ? { mayNotExist: spec.mayNotExist } : {}),
      };
    });
    json(res, 200, {
      toolId: adapter.id,
      injector: injectorStatus,
      files,
      ...(preview !== undefined ? { preview } : {}),
    });
  });

  const harnessEdit = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    toolId: string | undefined,
    op: 'install' | 'uninstall',
  ): Promise<void> => {
    const adapter = adapterOr404(res, toolId);
    if (!adapter) return;
    await deps.gate(req, res, 'harness.edit', {
      params: { toolId: adapter.id, op },
      execute: async (actor) => {
        const injector = adapter.injector;
        if (!injector) {
          return { status: 422, body: { code: 'adapter_unsupported', operation: 'harness.edit' } };
        }
        const ctx = deps.harnessCtx();
        const status = op === 'install' ? await injector.install(ctx) : await injector.uninstall(ctx);
        deps.store.append('harness.edited', {
          actor,
          tool: adapter.id,
          payload: {
            toolId: adapter.id,
            op,
            installed: status.installed,
            ...(status.detail !== undefined ? { detail: status.detail } : {}),
          },
        });
        return { status: 200, body: { toolId: adapter.id, op, ...status } };
      },
    });
  };

  r.add('POST', '/api/tools/:toolId/harness', (req, res, params) =>
    harnessEdit(req, res, params['toolId'], 'install'),
  );
  r.add('DELETE', '/api/tools/:toolId/harness', (req, res, params) =>
    harnessEdit(req, res, params['toolId'], 'uninstall'),
  );
}
