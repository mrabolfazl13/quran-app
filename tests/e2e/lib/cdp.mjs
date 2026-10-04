/**
 * tests/e2e/lib/cdp.mjs — a minimal Chrome DevTools Protocol client.
 *
 * Plain Node 24: global `fetch` for `/json/list`, global `WebSocket` for the
 * page target. No Playwright, no new dependency — the point of this suite is to
 * drive the *packaged* app, and the packaged app already speaks CDP through
 * WebView2 as soon as it is launched with `--remote-debugging-port`.
 *
 * Things this file exists to remember (each cost a manual round):
 *  - `Runtime.evaluate` must be wrapped as `(async function(){ return (<expr>) })()`
 *    for an expression and `(async function(){ <stmts> })()` for statements;
 *    mixing the two silently yields `undefined`.
 *  - The target list contains more than one page; the app's own page is picked by
 *    URL, and after a reload the socket is dead, so every call may reconnect once.
 *  - A navigation that differs from the current URL only in the hash is a
 *    same-document navigation: the old bundle stays. The router here is hash
 *    based, which is what we want — but `reload()` must use `ignoreCache`.
 */

import { writeFileSync } from 'node:fs';
import vm from 'node:vm';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpError extends Error {}

/**
 * Compile the code locally before sending it to the page. An unbalanced quote in
 * an injected selector used to arrive as `page exception: SyntaxError: Invalid or
 * unexpected token` after the app had already been driven for minutes; parsed
 * here it fails on the spot, with the offending source in the message.
 */
function parseCheck(wrapped, expression) {
  try {
    new vm.Script(wrapped);
  } catch (error) {
    const where = String(error.stack || '').split('\n').slice(1, 4).join('\n');
    const failure = new CdpError(`injected code does not parse: ${error.message}\n${where}\n--- sent ---\n${expression}`);
    failure.parseError = true;
    throw failure;
  }
}

export class Cdp {
  constructor({ port, urlMatch, name = 'cdp' }) {
    this.port = port;
    this.urlMatch = urlMatch;
    this.name = name;
    this.ws = null;
    this.target = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.requests = [];
    this.blocked = [];
    this.loadingFailures = [];
    this.exceptions = [];
    this.consoleErrors = [];
    this.intercept = false;
  }

  /** Listen to a CDP event (fire and forget; errors are swallowed by design). */
  on(method, handler) {
    this.handlers.set(method, handler);
  }

  static async attach(options) {
    const cdp = new Cdp(options);
    await cdp.connect();
    return cdp;
  }

  async connect({ timeoutMs = 90_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = 'no response';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { headers: { host: '127.0.0.1' } });
        const list = await res.json();
        const target = list.find((t) => t.type === 'page' && this.urlMatch(t.url || ''));
        if (target) {
          this.target = target;
          await this.#open(target.webSocketDebuggerUrl);
          return this;
        }
        last = `targets: ${list.map((t) => `${t.type} ${String(t.url).slice(0, 60)}`).join(' | ') || '(none)'}`;
      } catch (error) {
        last = error.message;
      }
      await sleep(750);
    }
    throw new CdpError(`no CDP page target on port ${this.port} after ${timeoutMs} ms — ${last}`);
  }

  async #open(url) {
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('CDP handshake timeout')), 15_000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = (event) => {
        clearTimeout(timer);
        reject(new CdpError(`websocket error: ${event?.message || 'unknown'}`));
      };
    });
    this.ws.onmessage = (event) => this.#onMessage(event);
    this.ws.onclose = () => {
      for (const [, waiter] of this.pending) waiter.reject(new CdpError('CDP socket closed'));
      this.pending.clear();
    };
    this.pending = new Map();
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new CdpError(`${message.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    switch (message.method) {
      case 'Network.requestWillBeSent':
        this.requests.push({ url: message.params.request.url, type: message.params.type, at: Date.now() });
        break;
      case 'Network.loadingFailed':
        this.loadingFailures.push(message.params.errorText);
        break;
      case 'Runtime.exceptionThrown': {
        const details = message.params.exceptionDetails;
        this.exceptions.push(String(details?.exception?.description || details?.text || 'exception').split('\n')[0].slice(0, 300));
        break;
      }
      case 'Runtime.consoleAPICalled':
        if (message.params.type === 'error') {
          this.consoleErrors.push(
            (message.params.args || []).map((a) => a.value ?? a.description ?? a.type ?? '').join(' ').slice(0, 240),
          );
        }
        break;
      default:
        break;
    }
    const handler = this.handlers.get(message.method);
    if (handler) {
      Promise.resolve()
        .then(() => handler(message))
        .catch(() => undefined);
    }
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(new CdpError(`send ${method} failed: ${error.message}`));
      }
    });
  }

  /** One automatic reconnect: a reload throws away the target we are on. */
  async call(method, params) {
    try {
      return await this.send(method, params);
    } catch (error) {
      if (!(error instanceof CdpError) || !/socket closed|handshake/i.test(error.message)) throw error;
      await sleep(1200);
      await this.connect({ timeoutMs: this.reconnectTimeoutMs ?? 60_000 });
      await this.#enableDomains();
      return this.send(method, params);
    }
  }

  async #enableDomains() {
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Network.enable', { maxTotalBufferSize: 20 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 });
    if (this.intercept) await this.enableRequestInterception();
  }

  async startCapture({ intercept = false } = {}) {
    this.intercept = intercept;
    await this.#enableDomains();
    if (intercept) {
      // Fail every request that is not on the local allowlist, at request level,
      // inside this page only. Nothing on the machine is touched.
      this.on('Fetch.requestPaused', (message) => this.handleFetchPaused(message));
    }
  }

  async enableRequestInterception() {
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }

  /**
   * Called from `run.mjs` for every intercepted request: continue the local ones,
   * refuse the rest and record the refusal as an offline-gate offender.
   */
  async handleFetchPaused(event) {
    const { requestId, request } = event.params;
    const local = this.isLocal(request.url);
    if (local) await this.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
    else {
      this.blocked.push(request.url);
      await this.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => undefined);
    }
  }

  /** Set by run.mjs so the client can classify without importing the gate module. */
  setLocalTest(fn) {
    this.isLocal = fn;
  }

  isLocal() {
    throw new CdpError('Cdp.isLocal was never configured');
  }

  async evaluate(expression, { retry = true } = {}) {
    const wrapped = `(async function(){ return (${expression}); })()`;
    parseCheck(wrapped, expression);
    const result = await (retry ? this.call('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true, timeout: 30_000 }) : this.send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true }));
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new CdpError(`page exception: ${details.exception?.description || details.text}`.split('\n')[0].slice(0, 300));
    }
    return result.result?.value;
  }

  async run(code) {
    const wrapped = `(async function(){ ${code} })()`;
    parseCheck(wrapped, code);
    const result = await this.call('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true, timeout: 60_000 });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new CdpError(`page exception: ${details.exception?.description || details.text}`.split('\n')[0].slice(0, 300));
    }
    return result.result?.value;
  }

  /** Poll a page-side boolean expression until it is true. */
  async waitFor(predicateExpression, { timeoutMs = 20_000, intervalMs = 400, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(predicateExpression);
      } catch (error) {
        // A predicate that cannot compile is a bug in this suite, not a state the
        // page might reach: fail now instead of polling it for the whole timeout.
        if (error.parseError) throw error;
        last = `error: ${error.message}`;
      }
      if (last === true) return true;
      await sleep(intervalMs);
    }
    throw new CdpError(`timed out after ${timeoutMs} ms waiting for ${label} (last value: ${JSON.stringify(last)})`);
  }

  async bodyText(limit = 4000) {
    return this.evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(0, ${limit})`);
  }

  /** Hash navigation: the router is hash based, so this is a real user click. */
  async go(route) {
    await this.run(`location.hash = '#${route}';`);
    await sleep(250);
  }

  async reload({ ignoreCache = true } = {}) {
    await this.send('Page.reload', { ignoreCache }).catch(() => undefined);
    await sleep(2500);
    await this.connect({ timeoutMs: this.reconnectTimeoutMs ?? 60_000 });
    await this.#enableDomains();
  }

  /** Click the first button whose text or title matches. Returns its label. */
  async clickText(regexSource, { flags = '', within = 'document', timeoutMs = 0 } = {}) {
    const expression = `(function(){
      const re = new RegExp(${JSON.stringify(regexSource)}, ${JSON.stringify(flags)});
      const root = ${within};
      const els = Array.from(root.querySelectorAll('button, a.linkbtn, [role=button]'));
      const hit = els.find((el) => re.test((el.textContent || '').trim()) || re.test(el.title || '') || re.test(el.getAttribute('aria-label') || ''));
      if (!hit) return null;
      hit.click();
      return (hit.textContent || hit.title || hit.getAttribute('aria-label') || '').trim().slice(0, 60);
    })()`;
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    for (;;) {
      const label = await this.evaluate(expression);
      if (label !== null) return label;
      if (Date.now() >= deadline) throw new CdpError(`no control matching /${regexSource}/`);
      await sleep(400);
    }
  }

  /** Click a control inside the element that itself matches a text pattern. */
  async clickInRow(rowSelector, rowTextSource, buttonSource) {
    const expression = `(function(){
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(rowSelector)}));
      const re = ${rowTextSource === null ? 'null' : `new RegExp(${JSON.stringify(rowTextSource)})`};
      const row = re ? rows.find((r) => re.test(r.textContent || '')) : rows[0];
      if (!row) return 'row-missing';
      const bre = new RegExp(${JSON.stringify(buttonSource)});
      const btn = Array.from(row.querySelectorAll('button, a.linkbtn')).find((b) => bre.test((b.textContent || '').trim()) || bre.test(b.title || ''));
      if (!btn) return 'button-missing';
      btn.click();
      return (btn.textContent || btn.title || '').trim().slice(0, 60);
    })()`;
    const out = await this.evaluate(expression);
    if (out === 'row-missing' || out === 'button-missing') throw new CdpError(`clickInRow(${rowSelector}, /${rowTextSource}/, /${buttonSource}/): ${out}`);
    return out;
  }

  /**
   * Write into an input/textarea the React way: the native setter, then an
   * `input` event. Setting `.value` alone leaves React's state untouched.
   */
  async type(selector, value, { kind = 'input' } = {}) {
    const expression = `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'missing';
      const proto = ${kind === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'};
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`;
    const out = await this.evaluate(expression);
    if (out !== 'ok') throw new CdpError(`type(${selector}): element not found`);
    return true;
  }

  async typeFirst(whereSelector, value, { kind = 'textarea', index = 0 } = {}) {
    const expression = `(function(){
      const els = Array.from(document.querySelectorAll(${JSON.stringify(whereSelector)}));
      const el = els[${index}];
      if (!el) return 'missing';
      const proto = ${kind === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'};
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`;
    const out = await this.evaluate(expression);
    if (out !== 'ok') throw new CdpError(`typeFirst(${whereSelector}): no element`);
    return true;
  }

  /** Number of elements matching a selector, once a condition holds. */
  async count(selector, { within = 'document' } = {}) {
    return Number(await this.evaluate(`(function(){ return Array.from(${within}.querySelectorAll(${JSON.stringify(selector)})).length; })()`));
  }

  async textOf(selector, { index = 0, within = 'document' } = {}) {
    return this.evaluate(`(function(){
      const els = Array.from(${within}.querySelectorAll(${JSON.stringify(selector)}));
      return els[${index}] ? els[${index}].textContent.trim() : null;
    })()`);
  }

  async screenshot(file) {
    const result = await this.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}
