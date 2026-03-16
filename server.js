import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;

const URL_BOI = 'https://www.scotconsultoria.com.br/cotacoes/boi-gordo/?ref=foo';
const URL_GRAOS = 'https://www.scotconsultoria.com.br/cotacoes/graos/?ref=foo';
const URL_FUTURO = 'https://www.scotconsultoria.com.br/cotacoes/mercado-futuro/?ref=foo';
const URL_NEWS =
  'https://news.google.com/rss/search?q=pecu%C3%A1ria+de+corte+OR+boi+gordo+OR+mercado+do+boi+OR+milho+OR+soja+Brasil&hl=pt-BR&gl=BR&ceid=BR:pt-419';

function decodeEntities(text = '') {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&ccedil;/gi, 'ç')
    .replace(/&atilde;/gi, 'ã')
    .replace(/&otilde;/gi, 'õ')
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&agrave;/gi, 'à')
    .replace(/&ecirc;/gi, 'ê')
    .replace(/&ocirc;/gi, 'ô')
    .replace(/&uuml;/gi, 'ü');
}

function stripHtml(text = '') {
  return decodeEntities(
    text
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function toLines(text = '') {
  return decodeEntities(text)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function brToNumber(value) {
  if (!value) return null;
  const num = Number(String(value).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function moneyArroba(value) {
  if (value == null) return null;
  return `R$ ${Number(value).toFixed(2).replace('.', ',')}/@`;
}

function moneySaca(value) {
  if (value == null) return null;
  return `R$ ${Number(value).toFixed(2).replace('.', ',')}/sc`;
}

function percentText(value) {
  if (value == null) return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const signal = num > 0 ? '+' : '';
  return `${signal}${num.toFixed(2).replace('.', ',')}%`;
}

async function scrapePageText(browser, url) {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'pt-BR',
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);

    const content = await page.content();
    const bodyText = await page.locator('body').innerText().catch(() => '');

    return {
      html: decodeEntities(content),
      text: decodeEntities(bodyText || ''),
    };
  } finally {
    await page.close();
  }
}

async function fetchNewsXml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`Falha ao buscar notícias: ${res.status}`);
  }

  return res.text();
}

function extractNewsItems(xml, maxItems = 6) {
  const items = [];
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  for (const block of blocks.slice(0, maxItems)) {
    const raw = block[1] || '';
    const title = stripHtml((raw.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = stripHtml((raw.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const source = stripHtml((raw.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '') || 'Google News';

    if (title && link) {
      items.push({ title, link, source });
    }
  }

  return items;
}

function parsePublishedAt(lines) {
  const line = lines.find((item) =>
    /[A-Za-zçÇãõáéíóúâêô-]+,\s*\d{1,2}\s+de\s+[A-Za-zçÇãõáéíóúâêô]+\s+de\s+\d{4}\s*-\s*\d{2}h\d{2}/i.test(item)
  );
  return line || null;
}

function parseBoiByPlaza(lines, plaza) {
  if (plaza === 'sao-paulo') {
    const fisico = lines.find((line) => /^SP Barretos\s+\d{1,3},\d{2}\s+\d{1,3},\d{2}$/.test(line));
    if (fisico) {
      const m = fisico.match(/^SP Barretos\s+(\d{1,3},\d{2})\s+(\d{1,3},\d{2})$/);
      if (m) {
        return {
          region: 'SP Barretos',
          value: brToNumber(m[1]),
          term: brToNumber(m[2]),
          note: 'Última cotação publicada do mercado físico em São Paulo',
        };
      }
    }

    const china = lines.find((line) => /^São Paulo\s+\d{1,3},\d{2}\s+\d{1,3},\d{2}$/.test(line));
    if (china) {
      const m = china.match(/^São Paulo\s+(\d{1,3},\d{2})\s+(\d{1,3},\d{2})$/);
      if (m) {
        return {
          region: 'São Paulo',
          value: brToNumber(m[1]),
          term: brToNumber(m[2]),
          note: 'Última cotação publicada para boi China a prazo em São Paulo',
        };
      }
    }

    return null;
  }

  const fisico = lines.find((line) => /^GO Goiânia\s+\d{1,3},\d{2}\s+\d{1,3},\d{2}$/.test(line));
  if (fisico) {
    const m = fisico.match(/^GO Goiânia\s+(\d{1,3},\d{2})\s+(\d{1,3},\d{2})$/);
    if (m) {
      return {
        region: 'GO Goiânia',
        value: brToNumber(m[1]),
        term: brToNumber(m[2]),
        note: 'Última cotação publicada do mercado físico em Goiás',
      };
    }
  }

  const china = lines.find((line) => /^Goiás\s+\d{1,3},\d{2}\s+\d{1,3},\d{2}$/.test(line));
  if (china) {
    const m = china.match(/^Goiás\s+(\d{1,3},\d{2})\s+(\d{1,3},\d{2})$/);
    if (m) {
      return {
        region: 'Goiás',
        value: brToNumber(m[1]),
        term: brToNumber(m[2]),
        note: 'Última cotação publicada para boi China a prazo em Goiás',
      };
    }
  }

  return null;
}

function parseGraosByPlaza(lines, plaza) {
  if (plaza === 'sao-paulo') {
    const milhoLine = lines.find((line) => /^SP\s+São Paulo\s+\d{1,3},\d{2}$/.test(line));
    const sojaLine = lines.find((line) => /^SP\s+Santos\s+\d{1,3},\d{2}$/.test(line));

    return {
      milho: milhoLine
        ? {
            value: brToNumber(milhoLine.match(/(\d{1,3},\d{2})$/)?.[1]),
            praca: 'São Paulo (SP)',
            note: 'Última cotação publicada de milho para São Paulo',
          }
        : null,
      soja: sojaLine
        ? {
            value: brToNumber(sojaLine.match(/(\d{1,3},\d{2})$/)?.[1]),
            praca: 'Santos (SP)',
            note: 'Última cotação publicada de soja para Santos (SP)',
          }
        : null,
    };
  }

  const milhoLine = lines.find((line) => /^GO\s+Itumbiara\s+\d{1,3},\d{2}$/.test(line));
  const sojaLine =
    lines.find((line) => /^Jata[ií]\s+\d{1,3},\d{2}$/.test(line)) ||
    lines.find((line) => /^GO\s+Jata[ií]\s+\d{1,3},\d{2}$/.test(line));

  return {
    milho: milhoLine
      ? {
          value: brToNumber(milhoLine.match(/(\d{1,3},\d{2})$/)?.[1]),
          praca: 'Itumbiara (GO)',
          note: 'Última cotação publicada de milho disponível em Goiás',
        }
      : null,
    soja: sojaLine
      ? {
          value: brToNumber(sojaLine.match(/(\d{1,3},\d{2})$/)?.[1]),
          praca: 'Jataí (GO)',
          note: 'Última cotação publicada de soja para Jataí (GO)',
        }
      : null,
  };
}

function parseFuturo(lines) {
  const line = lines.find((item) =>
    /^(Mar|Abr|Mai|Jun|Jul|Ago)\/\d{2}\s+\d{1,3},\d{2}\s+\d{1,3},\d{2}\s+\d+\s+-?\d{1,3},\d{2}\s+\d{1,3},\d{2}\s+\d{1,3},\d{2}$/.test(item)
  );

  if (!line) return null;

  const m = line.match(
    /^(Mar|Abr|Mai|Jun|Jul|Ago)\/(\d{2})\s+(\d{1,3},\d{2})\s+(\d{1,3},\d{2})\s+(\d+)\s+(-?\d{1,3},\d{2})\s+(\d{1,3},\d{2})\s+(\d{1,3},\d{2})$/
  );

  if (!m) return null;

  return {
    contract: `${m[1]}/${m[2]}`,
    prevAdjust: brToNumber(m[3]),
    adjust: brToNumber(m[4]),
    openInterest: Number(m[5]),
    changePercent: brToNumber(m[6]),
    usd: brToNumber(m[7]),
    projection: brToNumber(m[8]),
    note: 'Último ajuste publicado do mercado futuro do boi gordo',
  };
}

function buildPayload(plaza, boi, futuro, graos, noticias, sourceUpdatedAt) {
  return {
    collectedAt: new Date().toISOString(),
    sourceUpdatedAt: sourceUpdatedAt || null,
    updatedAt: new Date().toISOString(),
    status: 'Atualizado',
    location: plaza === 'sao-paulo' ? 'São Paulo' : 'Goiás',
    arroba: boi
      ? {
          value: moneyArroba(boi.value),
          term: moneyArroba(boi.term),
          source: 'Scot Consultoria',
          region: boi.region,
          note: boi.note,
        }
      : null,
    futuro: futuro
      ? {
          contract: futuro.contract,
          value: moneyArroba(futuro.adjust),
          change: percentText(futuro.changePercent),
          projection: moneyArroba(futuro.projection),
          source: 'Scot Consultoria / B3',
          note: futuro.note,
        }
      : null,
    graos: {
      milho: graos.milho ? moneySaca(graos.milho.value) : null,
      milhoPraca: graos.milho?.praca || null,
      milhoNote: graos.milho?.note || '',
      soja: graos.soja ? moneySaca(graos.soja.value) : null,
      sojaPraca: graos.soja?.praca || null,
      sojaNote: graos.soja?.note || '',
      source: 'Scot Consultoria / AgRural',
    },
    noticias,
    sources: [
      { name: 'Scot Consultoria - Boi gordo', url: URL_BOI },
      { name: 'Scot Consultoria - Grãos', url: URL_GRAOS },
      { name: 'Scot Consultoria - Mercado futuro', url: URL_FUTURO },
      { name: 'Google News', url: 'https://news.google.com/' },
    ],
    warning: '',
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'boi-agora-backend', now: new Date().toISOString() });
});

app.get('/cotacoes', async (req, res) => {
  const plaza = req.query.plaza === 'sao-paulo' ? 'sao-paulo' : 'goias';
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const [boiPage, graosPage, futuroPage, newsXml] = await Promise.all([
      scrapePageText(browser, URL_BOI),
      scrapePageText(browser, URL_GRAOS),
      scrapePageText(browser, URL_FUTURO),
      fetchNewsXml(URL_NEWS),
    ]);

    const boiLines = toLines(boiPage.text);
    const graosLines = toLines(graosPage.text);
    const futuroLines = toLines(futuroPage.text);

    const sourceUpdatedAt = parsePublishedAt(boiLines);
    const boi = parseBoiByPlaza(boiLines, plaza);
    const graos = parseGraosByPlaza(graosLines, plaza);
    const futuro = parseFuturo(futuroLines);
    const noticias = extractNewsItems(newsXml, 6);

    res.json(buildPayload(plaza, boi, futuro, graos, noticias, sourceUpdatedAt));
  } catch (error) {
    res.status(200).json({
      collectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'Contingência',
      location: plaza === 'sao-paulo' ? 'São Paulo' : 'Goiás',
      warning: 'Não foi possível buscar as cotações no momento.',
      debug: error instanceof Error ? error.message : 'Erro desconhecido',
      arroba: null,
      futuro: null,
      graos: {
        milho: null,
        milhoPraca: null,
        milhoNote: '',
        soja: null,
        sojaPraca: null,
        sojaNote: '',
        source: 'Scot Consultoria / AgRural',
      },
      noticias: [],
      sources: [
        { name: 'Scot Consultoria - Boi gordo', url: URL_BOI },
        { name: 'Scot Consultoria - Grãos', url: URL_GRAOS },
        { name: 'Scot Consultoria - Mercado futuro', url: URL_FUTURO },
      ],
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`Boi Agora backend running on port ${PORT}`);
});