import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ACTIONS,
  AgentPermissionMutationError,
  InvalidPermissionClassError,
  PermissionSettings,
  UnknownActionError,
} from '../src/permissions';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminull-perms-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AGENT_ACTIONS catalogue', () => {
  it('carries the expected default classes and risks', () => {
    const byId = new Map(AGENT_ACTIONS.map((a) => [a.id, a]));
    expect(byId.get('directive.send')?.defaultClass).toBe('autonomous');
    expect(byId.get('session.spawn')?.defaultClass).toBe('confirm');
    expect(byId.get('ask.answer')?.defaultClass).toBe('forbidden');
    expect(byId.get('plan.approve')?.defaultClass).toBe('forbidden');
    expect(byId.get('permission.grant')?.defaultClass).toBe('forbidden');
    expect(byId.get('account.switch')?.defaultClass).toBe('forbidden');
    expect(byId.get('board.edit')?.defaultClass).toBe('autonomous');
    // session.delete carries its floor + mandatory two-step
    const del = byId.get('session.delete');
    expect(del?.floor).toBe('confirm');
    expect(del?.requiresTwoStep).toBe(true);
    // every action exposes an i18n label key
    for (const a of AGENT_ACTIONS) expect(a.labelKey.startsWith('perm.')).toBe(true);
  });
});

describe('PermissionSettings.check', () => {
  it('resolves defaults for an agent', () => {
    const ps = new PermissionSettings();
    expect(ps.check('directive.send', 'agent').allowed).toBe('yes');
    expect(ps.check('session.spawn', 'agent').allowed).toBe('confirm');
    expect(ps.check('ask.answer', 'agent').allowed).toBe('no');
  });

  it('always yes for the user, regardless of class', () => {
    const ps = new PermissionSettings();
    expect(ps.check('ask.answer', 'user').allowed).toBe('yes');
    expect(ps.check('account.switch', 'user').allowed).toBe('yes');
    expect(ps.check('session.delete', 'user').allowed).toBe('yes');
  });

  it('fails closed for an unknown action', () => {
    const ps = new PermissionSettings();
    expect(ps.check('nope.nope', 'agent').allowed).toBe('no');
  });

  it('surfaces enough context to build an audit event', () => {
    const ps = new PermissionSettings();
    const r = ps.check('session.spawn', 'agent');
    expect(r).toMatchObject({
      actionId: 'session.spawn',
      actor: 'agent',
      resolvedClass: 'confirm',
      requiresTwoStep: false,
    });
  });
});

describe('PermissionSettings — session.delete floor', () => {
  it('never resolves below confirm for an agent even if the file widens it', () => {
    const wide = new PermissionSettings({ 'session.delete': 'autonomous' });
    const r = wide.check('session.delete', 'agent');
    expect(r.allowed).toBe('confirm'); // floored up from autonomous
    expect(r.resolvedClass).toBe('confirm');
    expect(r.requiresTwoStep).toBe(true);
    // the user still bypasses to yes
    expect(wide.check('session.delete', 'user').allowed).toBe('yes');
  });

  it('keeps a stricter setting strict (floor only raises restrictiveness)', () => {
    const strict = new PermissionSettings({ 'session.delete': 'forbidden' });
    expect(strict.check('session.delete', 'agent').allowed).toBe('no');
  });
});

describe('PermissionSettings.set', () => {
  it('throws when an agent tries to change its own permissions', () => {
    const ps = new PermissionSettings();
    expect(() => ps.set('directive.send', 'forbidden', 'agent')).toThrow(AgentPermissionMutationError);
    // the setting did not change
    expect(ps.check('directive.send', 'agent').allowed).toBe('yes');
  });

  it('throws on an unknown action or invalid class', () => {
    const ps = new PermissionSettings();
    expect(() => ps.set('nope.nope', 'confirm', 'user')).toThrow(UnknownActionError);
    expect(() => ps.set('directive.send', 'bogus' as any, 'user')).toThrow(InvalidPermissionClassError);
  });

  it('a user set persists and survives a save/reload round-trip', () => {
    const ps = new PermissionSettings();
    const res = ps.set('directive.send', 'confirm', 'user');
    expect(res).toMatchObject({ actionId: 'directive.send', previous: 'autonomous', next: 'confirm', actor: 'user' });
    expect(ps.check('directive.send', 'agent').allowed).toBe('confirm');

    const file = path.join(dir, 'perms.json');
    ps.save(file);
    expect(fs.existsSync(file)).toBe(true);

    const reloaded = PermissionSettings.load(file);
    expect(reloaded.check('directive.send', 'agent').allowed).toBe('confirm');
  });
});

describe('PermissionSettings.load — fail-closed', () => {
  it('a missing file falls back to defaults', () => {
    const ps = PermissionSettings.load(path.join(dir, 'does-not-exist.json'));
    expect(ps.check('directive.send', 'agent').allowed).toBe('yes');
    expect(ps.check('ask.answer', 'agent').allowed).toBe('no');
  });

  it('a corrupt file falls back to defaults, not a widened state', () => {
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, '{ this is not valid json ]');
    const ps = PermissionSettings.load(file);
    // defaults hold: forbidden actions stay forbidden, autonomous stays yes
    expect(ps.check('ask.answer', 'agent').allowed).toBe('no');
    expect(ps.check('directive.send', 'agent').allowed).toBe('yes');
  });

  it('drops bad entries but keeps valid overrides', () => {
    const file = path.join(dir, 'partial.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        actions: { 'directive.send': 'confirm', 'unknown.action': 'autonomous', 'ask.answer': 'not-a-class' },
      }),
    );
    const ps = PermissionSettings.load(file);
    expect(ps.check('directive.send', 'agent').allowed).toBe('confirm'); // valid override kept
    expect(ps.check('ask.answer', 'agent').allowed).toBe('no'); // bad value dropped → default forbidden
  });
});
