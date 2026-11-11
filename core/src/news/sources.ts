import { unzipSync } from 'fflate';
import { getBytes, getJson, getText } from '../http';
import { parseFeed, type RawItem } from './rss';

/** Feeds confirmados na Fase 0 (respondem e estão atualizados). Parados ou fora do ar ficaram de fora. */
export const FEEDS = [
  { id: 'infomoney', name: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/', cls: 'br' },
  { id: 'valor', name: 'Valor Econômico', url: 'https://pox.globo.com/rss/valor/', cls: 'br' },
  { id: 'moneytimes', name: 'Money Times', url: 'https://www.moneytimes.com.br/feed/', cls: 'br' },
  { id: 'suno', name: 'Suno', url: 'https://www.suno.com.br/noticias/feed/', cls: 'br' },
  { id: 'exame', name: 'Exame Invest', url: 'https://exame.com/invest/feed/', cls: 'br' },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', cls: 'crypto' },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', cls: 'crypto' },
  { id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', cls: 'us', official: true },
] as const;

export const yahooFeedUrl = (sym: string) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`;

export async function fetchFeed(url: string): Promise<RawItem[]> {
  return parseFeed(await getText(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } }, 20_000));
}

/* ---------- Copom (comunicados oficiais do Banco Central) ---------- */

interface CopomResp {
  conteudo: { nro_reuniao: number; dataReferencia: string; titulo: string }[];
}
export function parseCopom(j: CopomResp): RawItem[] {
  return j.conteudo.map((c) => ({
    title: c.titulo.replace(/\s+/g, ' '),
    link: `https://www.bcb.gov.br/publicacoes/comunicadoscopom/cop${c.nro_reuniao}`,
    // A fonte informa só a data; o comunicado sai após as 18h30 no 2º dia da reunião.
    time: Date.parse(`${c.dataReferencia}T18:30:00-03:00`),
    summary: '',
    categories: ['Copom'],
  }));
}
export async function fetchCopom(): Promise<RawItem[]> {
  return parseCopom(await getJson<CopomResp>('https://www.bcb.gov.br/api/servico/sitebcb/copom/comunicados?quantidade=6'));
}

/* ---------- Fatos relevantes (CVM, dados abertos IPE) ---------- */

export interface CvmDoc {
  company: string;
  subject: string;
  date: string; // aaaa-mm-dd (a CVM informa só o dia da entrega)
  link: string;
  protocol: string;
}

/** Lê o CSV do IPE (separador ;) e devolve só os Fatos Relevantes. */
export function parseIpe(csv: string): CvmDoc[] {
  const lines = csv.split(/\r?\n/);
  const h = lines[0].split(';');
  const i = (n: string) => h.indexOf(n);
  const [iNome, iCat, iAss, iData, iLink, iProt] = [i('Nome_Companhia'), i('Categoria'), i('Assunto'), i('Data_Entrega'), i('Link_Download'), i('Protocolo_Entrega')];
  const out: CvmDoc[] = [];
  for (const l of lines.slice(1)) {
    const c = l.split(';');
    if (c[iCat] !== 'Fato Relevante') continue;
    out.push({ company: c[iNome], subject: c[iAss], date: c[iData], link: c[iLink], protocol: c[iProt] });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Baixa o arquivo do ano (~1,8 MB compactado). A CVM atualiza o arquivo periodicamente, não em tempo real. */
export async function fetchCvmFacts(year = new Date().getFullYear()): Promise<{ docs: CvmDoc[]; updated?: string }> {
  const { bytes, lastModified } = await getBytes(`https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_${year}.zip`);
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((n) => n.endsWith('.csv'));
  if (!name) throw new Error('CVM: arquivo sem CSV');
  const csv = new TextDecoder('latin1').decode(files[name]);
  return { docs: parseIpe(csv), updated: lastModified };
}
