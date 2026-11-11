/** Leitor de RSS/Atom mínimo, sem DOM (roda igual no app, no celular e nos testes). */

export interface RawItem {
  title: string;
  link: string;
  time: number; // ms; NaN se a fonte não informar
  /** Só para etiquetar e achar ativos relacionados. Nunca exibido por inteiro (regra 6). */
  summary: string;
  categories: string[];
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function stripTags(s: string): string {
  return decode(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

export function parseFeed(xml: string): RawItem[] {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return blocks
    .map((b) => {
      let link = stripTags(tag(b, 'link'));
      if (!link) link = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '';
      if (!link) link = stripTags(tag(b, 'guid'));
      const when = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
      const cats = [...b.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
      return {
        title: stripTags(tag(b, 'title')),
        link: link.trim(),
        time: Date.parse(stripTags(when)),
        summary: stripTags(tag(b, 'description') || tag(b, 'summary')).slice(0, 400),
        categories: cats,
      };
    })
    .filter((i) => i.title && /^https?:\/\//.test(i.link));
}
