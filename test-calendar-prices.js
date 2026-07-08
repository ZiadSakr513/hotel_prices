const { chromium } = require('playwright');

const TEST_URL = process.argv[2] || 'https://www.google.com/travel/hotels/entity/ChgIw7779IiWieTcARoLL2cvMXdoZGp4cXoQAQ?utm_campaign=sharing&utm_medium=link&utm_source=htls&ved=0CAAQ5JsGahcKEwiIg5z1s-SUAxUAAAAAHQAAAAAQAg&ts=CAEaIAoCGgASGhIUCgcI6g8QCRgFEgcI6g8QCRgGGAEyAggCKgkKBToDVVNEGgA&gl=US&hl=en-US';

const WEEK_DAYS_OUT = 7;

function getWeekDateRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + WEEK_DAYS_OUT);
  const dates = [];
  const d = new Date(start);
  while (d <= end) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function buildWeekPrices(priceMap) {
  return getWeekDateRange().map(date => ({
    date,
    price: priceMap[date] ?? null,
  }));
}

function fmtShortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function hasCalendarPrices(page, timeout = 2000) {
  try {
    return await page.evaluate((timeoutMs) => {
      return new Promise(resolve => {
        const check = () => {
          for (const el of document.querySelectorAll('[role="gridcell"]')) {
            const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (/^\d{1,2}\s+\$\d+/.test(text)) return resolve(true);
          }
          return false;
        };
        if (check()) return;
        const start = Date.now();
        const interval = setInterval(() => {
          if (check() || Date.now() - start > timeoutMs) {
            clearInterval(interval);
            resolve(false);
          }
        }, 300);
      });
    }, timeout);
  } catch (_) {
    return false;
  }
}

async function openCalendarPicker(page) {
  if (await hasCalendarPrices(page, 1000)) return true;

  const selectors = [
    page.locator('input[aria-label="Check-in"]').first(),
    page.locator('input[aria-label="Check in"]').first(),
    page.locator('[aria-label="Check-in"]').first(),
    page.locator('[aria-label="Check in"]').first(),
    page.getByRole('button', { name: /check.?in/i }).first(),
    page.locator('input[placeholder*="Check-in"]').first(),
    page.locator('input[placeholder*="Check in"]').first(),
    page.locator('input[aria-label="Check-out"]').first(),
    page.locator('input[aria-label="Check out"]').first(),
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    for (const loc of selectors) {
      try {
        if (await loc.isVisible({ timeout: 1500 })) {
          await loc.click();
          const waitTime = 3000 + attempt * 2000;
          if (await hasCalendarPrices(page, waitTime)) {
            return true;
          }
        }
      } catch (_) {}
    }
    if (attempt < 2) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return false;
}

async function extractCalendarPriceMap(page) {
  return page.evaluate(() => {
    const MONTHS = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const priceMap = {};
    const now = new Date();
    let currentMonth = null;
    let year = now.getFullYear();
    let lastMonth = now.getMonth();

    for (const el of document.body.querySelectorAll('*')) {
      const t = (el.innerText || '').trim();
      const monthMatch = /^(January|February|March|April|May|June|July|August|September|October|November|December)(\s*\d{4})?$/i.exec(t);
      if (monthMatch && el.children.length <= 4) {
        currentMonth = MONTHS[monthMatch[1].toLowerCase()];
        if (currentMonth < lastMonth) year++;
        lastMonth = currentMonth;
        continue;
      }

      if (el.getAttribute('role') !== 'gridcell') continue;
      const cellText = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const m = cellText.match(/^(\d{1,2})\s+\$(\d+)/);
      if (!m || currentMonth === null) continue;

      const day = parseInt(m[1], 10);
      const price = parseInt(m[2], 10);
      const key = `${year}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      priceMap[key] = price;
    }
    return priceMap;
  });
}

async function scrollCalendarToMonth(page, monthName) {
  await page.evaluate((month) => {
    const regex = new RegExp('^' + month + '(\\s*\\d{4})?$', 'i');
    const el = Array.from(document.querySelectorAll('*')).find(e => {
      const t = (e.innerText || '').trim();
      return regex.test(t) && e.children.length <= 4;
    });
    if (el) el.scrollIntoView({ block: 'center' });
  }, monthName);
  await new Promise(r => setTimeout(r, 2000));
}

async function waitForMonthDayPrices(page, monthName, minDay, maxDay) {
  try {
    await page.waitForFunction(({ monthName, minDay, maxDay }) => {
      const MONTHS = {
        january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
      };
      let inTarget = false;
      let found = 0;
      for (const el of document.body.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (/^(January|February|March|April|May|June|July|August|September|October|November|December)(\s*\d{4})?$/i.test(t) && el.children.length <= 4) {
          const match = /^(January|February|March|April|May|June|July|August|September|October|November|December)/i.exec(t);
          inTarget = match && match[1].toLowerCase() === monthName.toLowerCase();
          continue;
        }
        if (!inTarget || el.getAttribute('role') !== 'gridcell') continue;
        const cellText = (el.innerText || '').replace(/\s+/g, ' ').trim();
        const m = cellText.match(/^(\d{1,2})\s+\$(\d+)/);
        if (m) {
          const day = parseInt(m[1], 10);
          if (day >= minDay && day <= maxDay) found++;
        }
      }
      return found >= Math.min(maxDay - minDay + 1, 3);
    }, { monthName, minDay, maxDay }, { timeout: 12000 });
  } catch (_) {}
}

async function prepareCalendarForWeek(page) {
  const weekDates = getWeekDateRange();
  const monthDays = new Map();
  for (const dateStr of weekDates) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const monthName = new Date(y, m - 1, d).toLocaleString('en-US', { month: 'long' });
    if (!monthDays.has(monthName)) monthDays.set(monthName, []);
    monthDays.get(monthName).push(d);
  }
  for (const [monthName, days] of monthDays) {
    await scrollCalendarToMonth(page, monthName);
    await waitForMonthDayPrices(page, monthName, Math.min(...days), Math.max(...days));
  }
}

async function main() {
  const weekDates = getWeekDateRange();
  console.log(`Week window: ${fmtShortDate(weekDates[0])} → ${fmtShortDate(weekDates[weekDates.length - 1])}\n`);

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await (await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })).newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise(r => setTimeout(r, 7000));
  
  const opened = await openCalendarPicker(page);
  console.log(`Calendar opened status: ${opened}`);
  if (opened) {
    await new Promise(r => setTimeout(r, 2000));
    await prepareCalendarForWeek(page);
  }

  const weekPrices = buildWeekPrices(await extractCalendarPriceMap(page));
  console.log('=== NIGHTLY PRICES (this week) ===');
  weekPrices.forEach(d => {
    console.log(`  ${fmtShortDate(d.date).padEnd(10)} ${d.price !== null ? '$' + d.price : 'N/A'}`);
  });
  console.log(`\nFound ${weekPrices.filter(d => d.price !== null).length}/${weekPrices.length} nights.`);

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
