/**
 * Todas as requisições HTTP do core passam por aqui.
 * No app, `setFetch` recebe o fetch nativo do Tauri (sem CORS); nos testes, um fetch falso.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let impl: FetchLike = (input, init) => fetch(input, init);

export function setFetch(f: FetchLike): void {
  impl = f;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, body: string) {
    super(`HTTP ${status} em ${new URL(url).host}: ${body.slice(0, 120)}`);
  }
}

export async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await impl(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new HttpError(r.status, url, await r.text().catch(() => ''));
    return (await r.json()) as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Tempo esgotado (${timeoutMs / 1000} s) em ${new URL(url).host}`);
    if (e instanceof TypeError || /failed to fetch|network/i.test((e as Error).message)) throw new Error(`Sem conexão com ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function getText(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await impl(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new HttpError(r.status, url, await r.text().catch(() => ''));
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

export async function getBytes(url: string, timeoutMs = 60_000): Promise<{ bytes: Uint8Array; lastModified?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await impl(url, { signal: ctrl.signal });
    if (!r.ok) throw new HttpError(r.status, url, '');
    return { bytes: new Uint8Array(await r.arrayBuffer()), lastModified: r.headers.get('last-modified') ?? undefined };
  } finally {
    clearTimeout(t);
  }
}
