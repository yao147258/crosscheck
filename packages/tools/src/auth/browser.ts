/// <reference lib="dom" />
import type { Actor } from '@crosscheck/core';
import type { EvidenceRedactor } from '../evidence/redactor';
import type { EvidenceMeta } from '../network/http-client';
import type { BrowserSession } from '../browser/session';
import { BrowserHost } from '../browser/actions';

/** 只接收宿主批准配置；不向模型暴露会话或凭证。 */
export class BrowserAuthenticationAdapter {
  private readonly origin: string;
  constructor(private readonly browser: BrowserHost, baseURL: string, private readonly redactor: EvidenceRedactor, private readonly perform?: BrowserHost['perform']) {
    this.origin = new URL(baseURL).origin;
  }
  async actions(actor: Extract<Actor, { kind: 'form' | 'replay' }>, meta: EvidenceMeta, signal: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    for (const action of actor.actions) {
      const input = action.kind === 'goto' ? { kind: 'navigate' as const, url: action.url }
        : action.kind === 'fill' ? { kind: 'fill' as const, locator: { strategy: 'css' as const, value: action.selector }, env: action.env }
        : action.kind === 'waitFor' ? { kind: 'wait' as const, locator: { strategy: 'css' as const, value: action.selector }, state: 'visible' as const }
        : { kind: 'click' as const, locator: { strategy: 'css' as const, value: action.selector } };
      ids.push(...(await (this.perform ?? this.browser.perform.bind(this.browser))(input, meta, signal)).evidenceIds);
    }
    return ids;
  }
  async storage(inject: Extract<Extract<Actor, { kind: 'token' }>['inject'], { kind: 'storage' }>, value: string, signal: AbortSignal): Promise<void> {
    this.redactor.addSecrets([value]);
    const session = await this.browser.getSession(signal);
    const config = { origin: this.origin, kind: inject.storage, name: inject.name, value };
    const apply = (c: typeof config) => { if (location.origin === c.origin) (c.kind === 'local' ? localStorage : sessionStorage).setItem(c.name, c.value); };
    await session.context.addInitScript(apply, config);
    if (new URL(session.page.url()).origin === this.origin) await session.page.evaluate(apply, config);
  }
  async headers(headers: [string, string][]): Promise<void> {
    if (!headers.length) return;
    await this.browser.onSession(async session => {
      const cookies = headers.filter(([name]) => name.toLowerCase() === 'cookie').flatMap(([, value]) => value.split(';').map(pair => {
        const index = pair.indexOf('='); return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), url: this.origin };
      }));
      if (cookies.length) await session.context.addCookies(cookies);
      const identity = headers.filter(([name]) => name.toLowerCase() !== 'cookie');
      if (identity.length) await this.installHeaders(session, identity);
    });
  }
  get hasSession(): boolean { return this.browser.currentSession !== undefined; }
  async cookies(url: string): Promise<[string, string][]> {
    if (new URL(url).origin !== this.origin) return [];
    const session = this.browser.currentSession;
    if (!session) return [];
    const cookies = await (await session).context.cookies([url]);
    this.redactor.addSecrets(cookies.map(c => c.value));
    return cookies.length ? [['Cookie', cookies.map(c => `${c.name}=${c.value}`).join('; ')]] : [];
  }
  private async installHeaders(session: BrowserSession, identity: [string, string][]): Promise<void> {
    const cdp = await session.context.newCDPSession(session.page);
    const names = new Set(identity.map(([name]) => name.toLowerCase()));
    const pending = new Set<Promise<void>>();
    let failure: unknown;
    cdp.on('Fetch.requestPaused', event => {
      const task = (async () => {
        const headers = Object.entries(event.request.headers).filter(([name]) => !names.has(name.toLowerCase())).map(([name, value]) => ({ name, value: String(value) }));
        if (new URL(event.request.url).origin === this.origin) headers.push(...identity.map(([name, value]) => ({ name, value })));
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId, headers });
      })().catch(error => { failure ??= error; void session.close().catch(() => {}); });
      pending.add(task); void task.finally(() => pending.delete(task));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    this.browser.onBeforeCapture(async () => { if (failure) throw failure; });
    this.browser.onClose(async () => { await Promise.all(pending); if (failure) throw failure; });
  }
}
