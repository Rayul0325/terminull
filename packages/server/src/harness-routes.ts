/**
 * `/api/harness/*` — the harness-file editor surface (M9 §3 rows 1–6): the
 * per-tool file manifest, read/write with the CORE-owned pipeline
 * ({@link HarnessFileEngine}: jail → format validation → sha lock → backup →
 * atomic write → audit facts), backups list + restore, and the read-only
 * '내 커스텀' detection group.
 *
 * Actor gating: a write to a riskLevel-`high` file (settings.json,
 * config.toml, .mcp.json, …) resolves through `harness.write_danger`, whose
 * `confirm` floor is immutable in core — an agent write can never bypass the
 * confirmation queue. Everything else resolves through `harness.write`.
 *
 * Audit events carry shas/sizes ONLY — file content and diffs are never
 * persisted in the event log.
 */
import fs from 'node:fs';
import type http from 'node:http';
import type { HarnessContext, HarnessFileSpec, ToolAdapter } from '@terminull/adapter-sdk';
import {
  BackupNotFoundError,
  FileTooLargeError,
  ParseInvalidError,
  PathJailError,
  ShaMismatchError,
  validatorForFormat,
  type EventStore,
  type HarnessFileEngine,
} from '@terminull/core';
import {
  HarnessRestoreRequestSchema,
  HarnessWriteRequestSchema,
  type Actor,
  type HarnessFileDto,
  type HarnessGroupDto,
  type HarnessReadDto,
  type HarnessWriteResponse,
} from '@terminull/shared';
import type { GateResult } from './confirmations.js';
import { scanCustomHarness } from './custom-harness.js';
import { Router, fail, json, readJsonBody } from './http-util.js';

/** What the harness routes borrow from the server. */
export interface HarnessRouteDeps {
  adapters: Map<string, ToolAdapter>;
  store: EventStore;
  engine: HarnessFileEngine;
  /** Harness/account context (home = collectHome in tests, real home in prod). */
  harnessCtx(): HarnessContext;
  /** Project root for cwd-scoped files (defaults to process.cwd() upstream). */
  projectRoot(): string;
  /** The server's single permission decision point (bound closure). */
  gate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    action: string,
    opts: { params?: unknown; execute: (actor: Actor) => Promise<GateResult> },
  ): Promise<void>;
}

/** One catalog entry with its resolved path (undefined = resolver failed). */
interface ResolvedSpec {
  adapter: ToolAdapter;
  spec: HarnessFileSpec;
  path: string | undefined;
}

/** Directory-shaped specs are listed for orientation but never editable. */
function isDirectorySpec(spec: HarnessFileSpec): boolean {
  return spec.format === 'other';
}

function resolveSpec(
  adapter: ToolAdapter,
  spec: HarnessFileSpec,
  ctx: HarnessContext,
): ResolvedSpec {
  let resolved: string | undefined;
  try {
    resolved = spec.path ?? spec.pathResolver?.(ctx);
  } catch {
    resolved = undefined; // resolver threw — listed but not readable (honest)
  }
  return { adapter, spec, path: resolved };
}

/** Find one fileId across every adapter catalog. */
function findSpec(deps: HarnessRouteDeps, fileId: string): ResolvedSpec | null {
  const ctx = { ...deps.harnessCtx(), cwd: deps.projectRoot() };
  for (const adapter of deps.adapters.values()) {
    for (const spec of adapter.harnessFiles ?? []) {
      if (spec.id === fileId) return resolveSpec(adapter, spec, ctx);
    }
  }
  return null;
}

/** Map a typed pipeline error onto its wire status/body, or rethrow. */
function pipelineErrorResult(e: unknown): GateResult {
  if (e instanceof ShaMismatchError) {
    return { status: 409, body: { code: 'sha_mismatch', currentSha: e.currentSha } };
  }
  if (e instanceof ParseInvalidError) {
    return {
      status: 422,
      body: {
        code: 'parse_invalid',
        format: e.format,
        detail: e.detail,
        ...(e.line !== undefined ? { line: e.line } : {}),
      },
    };
  }
  if (e instanceof PathJailError) {
    return { status: 400, body: { code: 'path_jailbreak' } };
  }
  if (e instanceof FileTooLargeError) {
    return { status: 413, body: { code: 'file_too_large', bytes: e.bytes } };
  }
  if (e instanceof BackupNotFoundError) {
    return { status: 404, body: { code: 'backup_not_found', backupId: e.backupId } };
  }
  throw e;
}

/** Register every `/api/harness*` route on the server's router. */
export function registerHarnessRoutes(r: Router, deps: HarnessRouteDeps): void {
  /**
   * Shared entry guard for the per-file routes: 404 for a fileId no adapter
   * catalogs (or whose resolver failed — an entry without a path is listed
   * but not readable), 422 for directory-shaped specs.
   */
  const editableOr4xx = (res: http.ServerResponse, fileId: string): ResolvedSpec | null => {
    const found = findSpec(deps, fileId);
    if (!found || found.path === undefined) {
      fail(res, 404, 'unknown_file', { fileId });
      return null;
    }
    if (isDirectorySpec(found.spec)) {
      fail(res, 422, 'directory_not_editable', { fileId });
      return null;
    }
    return found;
  };

  r.add('GET', '/api/harness/files', (_req, res) => {
    const ctx = { ...deps.harnessCtx(), cwd: deps.projectRoot() };
    const groups: HarnessGroupDto[] = [];
    for (const adapter of deps.adapters.values()) {
      const specs = adapter.harnessFiles ?? [];
      if (specs.length === 0) continue;
      const files: HarnessFileDto[] = specs.map((spec) => {
        const { path: resolved } = resolveSpec(adapter, spec, ctx);
        return {
          id: spec.id,
          toolId: adapter.id,
          label: spec.label,
          description: spec.description,
          format: spec.format,
          scope: spec.scope,
          riskLevel: spec.riskLevel,
          ...(resolved !== undefined ? { path: resolved, exists: fs.existsSync(resolved) } : {}),
          ...(spec.mayNotExist !== undefined ? { mayNotExist: spec.mayNotExist } : {}),
          ...(isDirectorySpec(spec) ? { directory: true } : {}),
        };
      });
      groups.push({ toolId: adapter.id, displayName: adapter.displayName, files });
    }
    json(res, 200, { groups });
  });

  r.add('GET', '/api/harness/files/:fileId', async (_req, res, params) => {
    const fileId = params['fileId'] ?? '';
    const found = editableOr4xx(res, fileId);
    if (!found) return;
    try {
      const state = await deps.engine.read(fileId, found.path!);
      const dto: HarnessReadDto = {
        fileId,
        toolId: found.adapter.id,
        path: found.path!,
        exists: state.exists,
        content: state.content,
        sha: state.sha,
        size: state.size,
        mtime: state.mtime,
      };
      json(res, 200, dto);
    } catch (e) {
      const mapped = pipelineErrorResult(e);
      json(res, mapped.status, mapped.body);
    }
  });

  r.add('PUT', '/api/harness/files/:fileId', async (req, res, params) => {
    const fileId = params['fileId'] ?? '';
    const body = HarnessWriteRequestSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    const found = editableOr4xx(res, fileId);
    if (!found) return;
    // Stateless format validation BEFORE gating: parse-invalid content must
    // never park a confirmation the user would approve into a 422. The engine
    // re-validates inside the pipeline (stage 2) — this is a fast pre-check.
    const preIssue = validatorForFormat(found.spec.format).validator(body.data.content);
    if (preIssue) {
      fail(res, 422, 'parse_invalid', {
        format: found.spec.format,
        detail: preIssue.detail,
        ...(preIssue.line !== undefined ? { line: preIssue.line } : {}),
      });
      return;
    }
    // Danger-risk files resolve through the floored action — server-side
    // action selection IS the enforcement (core keeps the floor immutable).
    const action = found.spec.riskLevel === 'high' ? 'harness.write_danger' : 'harness.write';
    await deps.gate(req, res, action, {
      params: { fileId, toolId: found.adapter.id, path: found.path },
      execute: async (actor) => {
        let facts;
        try {
          facts = await deps.engine.write(fileId, found.path!, {
            expectedSha: body.data.expectedSha,
            content: body.data.content,
            format: found.spec.format,
          });
        } catch (e) {
          return pipelineErrorResult(e);
        }
        deps.store.append('harness.file_written', {
          actor,
          tool: found.adapter.id,
          payload: {
            fileId,
            toolId: found.adapter.id,
            sha: facts.sha,
            backupId: facts.backupId,
            bytes: facts.bytes,
            validation: facts.validation,
          },
        });
        const response: HarnessWriteResponse = {
          written: true,
          fileId,
          sha: facts.sha,
          backupId: facts.backupId,
          validation: facts.validation,
        };
        return { status: 200, body: response };
      },
    });
  });

  r.add('GET', '/api/harness/files/:fileId/backups', async (_req, res, params) => {
    const fileId = params['fileId'] ?? '';
    const found = editableOr4xx(res, fileId);
    if (!found) return;
    json(res, 200, { backups: await deps.engine.listBackups(fileId) });
  });

  r.add('POST', '/api/harness/files/:fileId/restore', async (req, res, params) => {
    const fileId = params['fileId'] ?? '';
    const body = HarnessRestoreRequestSchema.safeParse(await readJsonBody(req));
    if (!body.success) {
      fail(res, 400, 'bad_request');
      return;
    }
    const found = editableOr4xx(res, fileId);
    if (!found) return;
    const action = found.spec.riskLevel === 'high' ? 'harness.write_danger' : 'harness.write';
    await deps.gate(req, res, action, {
      params: { fileId, toolId: found.adapter.id, backupId: body.data.backupId },
      execute: async (actor) => {
        let facts;
        try {
          // Restore = the backup's bytes through the FULL pipeline (the
          // current content is backed up first → undoable, byte-identical).
          facts = await deps.engine.restore(fileId, found.path!, {
            backupId: body.data.backupId,
            expectedSha: body.data.expectedSha,
            format: found.spec.format,
          });
        } catch (e) {
          return pipelineErrorResult(e);
        }
        deps.store.append('harness.file_restored', {
          actor,
          tool: found.adapter.id,
          payload: {
            fileId,
            toolId: found.adapter.id,
            sha: facts.sha,
            backupId: facts.backupId,
            restoredFrom: body.data.backupId,
            bytes: facts.bytes,
            validation: facts.validation,
          },
        });
        const response: HarnessWriteResponse = {
          written: true,
          fileId,
          sha: facts.sha,
          backupId: facts.backupId,
          validation: facts.validation,
        };
        return { status: 200, body: response };
      },
    });
  });

  r.add('GET', '/api/harness/custom', (_req, res) => {
    const ctx = deps.harnessCtx();
    json(res, 200, scanCustomHarness({ home: ctx.home ?? '', cwd: deps.projectRoot() }));
  });
}
