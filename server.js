const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const INTERVAL = 60 * 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HOTELS_FILE = path.join(__dirname, 'hotel links.txt');
const HISTORY_FILE = path.join(__dirname, 'hotel-history.json');

let hotels = [];
let pwBrowser = null;

async function getPW() {
  if (!pwBrowser) {
    pwBrowser = await chromium.launch({
      channel: 'chrome', headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080']
    });
    process.on('exit', () => { if (pwBrowser) pwBrowser.close(); });
  }
  return pwBrowser;
}

const ROOM_TYPES = ['2 Queen', 'Queen', 'Suite', 'Other'];
const WEEK_DAYS_OUT = 7; // today through today + 7 days (e.g. Jun 18 → Jun 25)

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

async function hasCalendarPrices(page, timeout = 2000) {
  // Check for gridcells that actually contain day + price data (e.g. "18 $89")
  // NOT just any [role="gridcell"] — Google Travel has non-calendar gridcells like "View all photos"
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
  // First check if price calendar is genuinely already visible
  if (await hasCalendarPrices(page, 1000)) return true;

  const selectors = [
    page.locator('input[aria-label="Check-in"]').first(),
    page.locator('input[aria-label="Check in"]').first(),
    page.locator('[aria-label="Check-in"]').first(),
    page.locator('[aria-label="Check in"]').first(),
    page.getByRole('button', { name: /check.?in/i }).first(),
    page.locator('input[placeholder*="Check-in"]').first(),
    page.locator('input[placeholder*="Check in"]').first(),
    // Fallback: try Check-out which also opens the calendar
    page.locator('input[aria-label="Check-out"]').first(),
    page.locator('input[aria-label="Check out"]').first(),
  ];

  // Try up to 3 attempts with increasing wait times
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const loc of selectors) {
      try {
        if (await loc.isVisible({ timeout: 1500 })) {
          await loc.click();
          // Wait for actual price-bearing gridcells to appear
          const waitTime = 3000 + attempt * 2000;
          if (await hasCalendarPrices(page, waitTime)) {
            return true;
          }
        }
      } catch (_) {}
    }
    // Between attempts, wait a bit and try scrolling up to make sure the check-in is in view
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

async function scrapeCalendarWeekPricesPW(url) {
  const browser = await getPW();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  try {
    // Try up to 2 full page loads if calendar fails to open
    for (let pageAttempt = 0; pageAttempt < 2; pageAttempt++) {
      if (pageAttempt > 0) {
        console.log('    Retrying calendar scrape (attempt 2)...');
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise(r => setTimeout(r, 7000 + pageAttempt * 3000));

      const calendarOpened = await openCalendarPicker(page);
      if (!calendarOpened) {
        console.log('    Calendar picker did not open' + (pageAttempt === 0 ? ', will retry...' : ''));
        if (pageAttempt === 0) continue;
        return buildWeekPrices({});
      }

      await new Promise(r => setTimeout(r, 2000));
      await prepareCalendarForWeek(page);
      const priceMap = await extractCalendarPriceMap(page);
      const priceCount = Object.keys(priceMap).length;

      if (priceCount > 0 || pageAttempt > 0) {
        return buildWeekPrices(priceMap);
      }
      // Got 0 prices on first attempt — retry with fresh page load
      console.log('    Extracted 0 prices, retrying...');
    }
    return buildWeekPrices({});
  } finally {
    await page.close();
    await ctx.close();
  }
}

async function scrapeRoomsPW(url) {
  const browser = await getPW();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  try {
    const pricesUrl = url.includes('/prices?') ? url : url.replace(/\?(.*)/, '/prices?$1');
    await page.goto(pricesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 6000));
    try {
      const more = page.getByText(/more room rates/i).first();
      if (await more.isVisible({ timeout: 3000 })) {
        await more.click();
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (_) {}
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 1000));
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const rooms = [];
    const seen = new Set();
    const roomKeywords = /(Queen|King|Double|Twin|Suite|Room|Bed|Standard|Deluxe|Premium|Superior|Executive|Accessible|Junior|Grand|Presidential|Family|Studio)/i;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const pm = l.match(/\$(\d+)/);
      if (!pm) continue;
      const price = parseInt(pm[1]);
      if (price < 30 || price > 2000) continue;
      if (roomKeywords.test(l)) {
        const cleanName = l.replace(/\$[\d,]+(\s*\$[\d,]+)*/g, '').replace(/\s+/g, ' ').trim();
        if (cleanName.length >= 3) {
          const key = cleanName.replace(/[^a-z0-9]/gi, '').toLowerCase();
          if (!seen.has(key)) { seen.add(key); rooms.push({ name: cleanName, price }); }
        }
        continue;
      }
      let found = false;
      for (let d = 1; d <= 10; d++) {
        for (const idx of [i - d, i + d]) {
          if (idx < 0 || idx >= lines.length) continue;
          const nl = lines[idx];
          if (nl.length < 3 || nl.length > 200) continue;
          if (!roomKeywords.test(nl)) continue;
          if (!/\b[A-Z]/.test(nl)) continue;
          if (/·|\b\d+\s*(guests?|adults?)\b/i.test(nl)) continue;
          if (/\b(breakfast|free cancellation|cancel|pool|wifi|parking)\b/i.test(nl)) continue;
          const key = nl.replace(/[^a-z0-9]/gi, '').toLowerCase();
          if (!seen.has(key)) { seen.add(key); rooms.push({ name: nl, price }); }
          found = true; break;
        }
        if (found) break;
      }
    }
    return rooms;
  } finally {
    await page.close(); await ctx.close();
  }
}

function saveHistory() {
  const data = {};
  for (const h of hotels) {
    for (const a of h.adults) {
      data[a.url] = { rooms: a.rooms, previousPrice: a.previousPrice, weekPricesHistory: a.weekPricesHistory || {} };
    }
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch (_) {
    return {};
  }
}

function categorizeRoom(name) {
  const n = name.toLowerCase();
  if (/\bsuite\b/.test(n)) return 'Suite';
  if (/\bqueen\b/.test(n)) {
    if (/\b(2|two|double)\s+queen\b/.test(n) || /queen.*2\b|2\b.*queen/.test(n)) return '2 Queen';
    return 'Queen';
  }
  return 'Other';
}

function makeRoomMap(rooms) {
  const map = {};
  const seen = {};
  for (const r of rooms) {
    const cat = categorizeRoom(r.name);
    const key = `${cat}|${r.price}`;
    if (seen[key]) continue;
    seen[key] = true;
    if (!map[cat] || r.price < map[cat].price) {
      map[cat] = { displayName: r.name, price: r.price, previousPrice: null, error: null, history: [] };
    }
  }
  for (const t of ROOM_TYPES) {
    if (!map[t]) {
      map[t] = { displayName: null, price: null, previousPrice: null, error: null, history: [] };
    }
  }
  return map;
}

function extractRoomsFromHTML(html) {
  const rooms = [];
  const seen = new Set();
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const re = /([A-Z][A-Za-z0-9\s,;:'\-\(\)&\/\.!@]{8,160}?)\$(\d+)\$\d+\$/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    let name = match[1].trim();
    const price = parseInt(match[2]);
    name = name.replace(/[\s,;:]+$/, '').replace(/\s+/g, ' ').trim();
    if (name.length < 8 || price < 20 || price > 2000) continue;
    if (!/[A-Za-z]{3,}/.test(name)) continue;
    const hasKeyword = /\b(Room|Suite|Bed|Queen|King|Double|Twin|Deluxe|Standard|Premium|Superior|Executive|Accessible|Studio|Loft|Cabin|Villa|Bungalow|Chalet|Presidential|Family|Grand)\b/i.test(name);
    if (!hasKeyword) continue;
    const clean = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (seen.has(clean)) continue;
    seen.add(clean);
    rooms.push({ name, price });
  }
  return rooms;
}

function mergeSavedRooms(roomMap, saved) {
  for (const t of ROOM_TYPES) {
    if (saved && saved[t]) {
      const s = saved[t];
      if (!roomMap[t]) roomMap[t] = { displayName: null, price: null, previousPrice: null, error: null, history: [] };
      if (s.history) roomMap[t].history = s.history;
      if (s.previousPrice !== undefined) roomMap[t].previousPrice = s.previousPrice;
      if (s.price !== undefined && roomMap[t].price === null) roomMap[t].price = s.price;
      if (s.displayName && !roomMap[t].displayName) roomMap[t].displayName = s.displayName;
    }
  }
  return roomMap;
}

function parseHotelsFile(content) {
  const lines = content.split(/\r?\n/).map(l => l.trim());
  const result = [];
  let current = null;
  let expectAdult = null;

  for (const line of lines) {
    if (line.startsWith('http://') || line.startsWith('https://')) {
      if (current && expectAdult) {
        const adult = current.adults.find(a => a.count === expectAdult);
        if (adult) adult.url = line;
        expectAdult = null;
      }
    } else if (/^2\s*adult/i.test(line)) {
      expectAdult = 2;
    } else if (/^1\s*adult/i.test(line)) {
      expectAdult = 1;
    } else if (line.length > 0 && !line.startsWith('—')) {
      if (current && current.adults.every(a => a.url)) result.push(current);
      const isOwned = line.includes(' — ');
      let name = line;
      let note = null;
      if (isOwned) {
        const parts = line.split(' — ');
        name = parts[0].trim();
        note = parts.slice(1).join(' — ').trim();
      }
      current = {
        name,
        note,
        isOwned,
        adults: [
          { count: 1, url: null, rooms: {}, currentPrice: null, previousPrice: null, error: null, weekPricesHistory: {} },
        ],
      };
      expectAdult = null;
    }
  }
  if (current && current.adults.every(a => a.url)) result.push(current);
  return result;
}

function loadHotels() {
  try {
    const content = fs.readFileSync(HOTELS_FILE, 'utf-8');
    hotels = parseHotelsFile(content);
    for (const h of hotels) {
      for (const a of h.adults) {
        for (const t of ROOM_TYPES) {
          if (!a.rooms[t]) a.rooms[t] = { displayName: null, price: null, previousPrice: null, error: null, history: [] };
        }
        if (!a.weekPricesHistory) a.weekPricesHistory = {};
      }
    }
    const saved = loadHistory();
    for (const h of hotels) {
      for (const a of h.adults) {
        const s = saved[a.url];
        if (s) {
          if (s.rooms) a.rooms = mergeSavedRooms(a.rooms, s.rooms);
          if (s.previousPrice !== undefined) a.previousPrice = s.previousPrice;
          if (s.weekPricesHistory) a.weekPricesHistory = s.weekPricesHistory;
        }
      }
    }
    console.log(`Loaded ${hotels.length} hotels from file`);
  } catch (err) {
    console.error('Failed to load hotels file:', err.message);
    hotels = [];
  }
}

async function scrapePrice(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
        maxRedirects: 5,
      });
      return response.data;
    } catch (err) {
      if (attempt < retries) await new Promise(r => setTimeout(r, 3000));
      else throw err;
    }
  }
}

async function scrapeHotel(hotel) {
  for (const adult of hotel.adults) {
    try {
      const html = await scrapePrice(adult.url);
      const $ = cheerio.load(html);
      let rooms = [];
      let lowestPrice = null;

      const scripts = $('script[type="application/ld+json"]');
      for (let i = 0; i < scripts.length; i++) {
        try {
          const data = JSON.parse($(scripts[i]).html());
          const offers = data.offers || data.mainEntity?.offers;
          if (Array.isArray(offers)) {
            for (const o of offers) {
              if (o.name && o.price && !isNaN(o.price)) {
                rooms.push({ name: o.name, price: Math.round(parseFloat(o.price)) });
              }
            }
          } else if (offers?.price && !isNaN(offers.price) && data.name) {
            rooms.push({ name: data.name, price: Math.round(parseFloat(offers.price)) });
          }
        } catch (_) {}
      }

      if (rooms.length < 2) {
        const extracted = extractRoomsFromHTML(html);
        if (extracted.length > 0) rooms = extracted;
      }

      if (rooms.length < 2) {
        try {
          const pwRooms = await scrapeRoomsPW(adult.url);
          if (pwRooms.length > 0) rooms = pwRooms;
        } catch (_) {}
      }

      const singlePrice = extractSinglePrice(html);
      const now = new Date().toISOString();
      const newRooms = makeRoomMap(rooms);

      if (singlePrice !== null) {
        newRooms.Other.price = singlePrice;
        newRooms.Other.displayName = newRooms.Other.displayName || 'Standard Room';
        if (rooms.length === 0) rooms.push({ name: 'Standard Room', price: singlePrice });
      }

      for (const t of ROOM_TYPES) {
        const old = adult.rooms[t];
        if (newRooms[t].price !== null) {
          const prevPrice = old?.price !== null && old?.price !== undefined ? old.price : null;
          newRooms[t].previousPrice = prevPrice !== null ? prevPrice : (old?.previousPrice || null);
          newRooms[t].history = old?.history || [];
          newRooms[t].history.push({ price: newRooms[t].price, date: now });
        } else {
          Object.assign(newRooms[t], old || { displayName: null, price: null, previousPrice: null, error: null, history: [] });
        }
      }
      adult.rooms = newRooms;
      const prices = ROOM_TYPES.map(t => adult.rooms[t].price).filter(p => p !== null);
      adult.currentPrice = prices.length ? Math.min(...prices) : null;
      adult.previousPrice = (() => {
        const prevPrices = ROOM_TYPES.map(t => adult.rooms[t].previousPrice).filter(p => p !== null);
        return prevPrices.length ? Math.min(...prevPrices) : null;
      })();
      adult.error = null;
      const cheapest = ROOM_TYPES.filter(t => adult.rooms[t].price !== null).map(t => `${t}:$${adult.rooms[t].price}`);
      if (rooms.length > 0) {
        console.log(`  ${hotel.name} (${adult.count} adult): ${cheapest.join(', ') || 'no prices'}`);
      } else if (singlePrice !== null) {
        console.log(`  ${hotel.name} (${adult.count} adult): $${singlePrice}`);
      } else {
        adult.error = 'Price not found';
        console.log(`  ${hotel.name} (${adult.count} adult): price not found`);
      }
    } catch (err) {
      adult.error = err.message;
      console.log(`  ${hotel.name} (${adult.count} adult): error - ${err.message}`);
    }
  }
}

function extractSinglePrice(html) {
  let price = null;
  const m1 = html.match(/\$(\d+)\s*\$?\d*\s*total/i);
  if (m1) price = parseInt(m1[1]);
  if (!price) { const m2 = html.match(/\$(\d+)\s*\/\s*night/i); if (m2) price = parseInt(m2[1]); }
  if (!price) { const m3 = html.match(/"price"\s*:\s*"?\$?(\d+)/i); if (m3) price = parseInt(m3[1]); }
  if (!price) {
    const seen = new Set();
    const matches = html.matchAll(/\$(\d+)/g);
    for (const m of matches) {
      const val = parseInt(m[1]);
      if (val >= 30 && val <= 1000 && !seen.has(val)) { seen.add(val); if (seen.size === 1) price = val; }
    }
  }
  return price;
}

let isScraping = false;
let refreshQueue = null;

async function scrapeAllCalendars() {
  console.log('Scraping weekly calendar prices...');
  const now = new Date().toISOString();
  for (const hotel of hotels) {
    for (const adult of hotel.adults) {
      try {
        adult.weekPrices = await scrapeCalendarWeekPricesPW(adult.url);
        adult.weekPricesError = null;
        if (!adult.weekPricesHistory) adult.weekPricesHistory = {};
        for (const day of adult.weekPrices) {
          if (day.price === null) continue;
          const dateKey = day.date;
          if (!adult.weekPricesHistory[dateKey]) adult.weekPricesHistory[dateKey] = [];
          const hist = adult.weekPricesHistory[dateKey];
          const lastEntry = hist.length > 0 ? hist[hist.length - 1] : null;
          const lastPrice = lastEntry ? lastEntry.price : null;
          hist.push({ price: day.price, date: now });
          day.previousPrice = lastPrice;
        }
        const found = adult.weekPrices.filter(d => d.price !== null).length;
        console.log(`  ${hotel.name} (${adult.count} adult): week ${found}/${WEEK_DAYS_OUT + 1} nights`);
      } catch (err) {
        adult.weekPrices = buildWeekPrices({});
        adult.weekPricesError = err.message;
        console.log(`  ${hotel.name} (${adult.count} adult): week error - ${err.message}`);
      }
    }
  }
}

async function scrapeAll() {
  if (isScraping) {
    await new Promise(r => { refreshQueue = r; });
  }
  isScraping = true;
  try {
    console.log(`\n[${new Date().toLocaleTimeString()}] Scraping all hotels...`);
    await Promise.allSettled(hotels.map(h => scrapeHotel(h)));
    await scrapeAllCalendars();
    saveHistory();
    console.log(`Done. ${hotels.length} hotels scraped`);
  } finally {
    isScraping = false;
    if (refreshQueue) { const r = refreshQueue; refreshQueue = null; r(); }
  }
}

app.get('/api/hotels', (req, res) => {
  res.json({
    lastScrape: global.lastScrape || null,
    nextScrape: global.nextScrape || null,
    weekRange: {
      start: getWeekDateRange()[0],
      end: getWeekDateRange()[getWeekDateRange().length - 1],
    },
    hotels: hotels.map((h, i) => ({
      index: i,
      name: h.name,
      note: h.note,
      isOwned: h.isOwned,
      adults: h.adults.map(a => ({
        count: a.count,
        url: a.url,
        currentPrice: a.currentPrice,
        previousPrice: a.previousPrice,
        error: a.error,
        weekPrices: a.weekPrices || buildWeekPrices({}),
        weekPricesError: a.weekPricesError || null,
        rooms: a.rooms,
        weekPricesHistory: a.weekPricesHistory || {},
      })),
    })),
  });
});

app.get('/api/refresh', async (req, res) => {
  await scrapeAll();
  global.lastScrape = new Date().toISOString();
  global.nextScrape = new Date(Date.now() + INTERVAL).toISOString();
  res.json({ status: 'ok', time: global.lastScrape });
});

app.delete('/api/history/:hotelIndex/adult/:adultCount/room/:roomType/entry/:entryIndex', (req, res) => {
  const hIdx = parseInt(req.params.hotelIndex);
  const aCount = parseInt(req.params.adultCount);
  const rType = req.params.roomType;
  const eIdx = parseInt(req.params.entryIndex);
  if (isNaN(hIdx) || hIdx < 0 || hIdx >= hotels.length) return res.status(400).json({ error: 'Invalid hotel index' });
  const adult = hotels[hIdx].adults.find(a => a.count === aCount);
  if (!adult) return res.status(400).json({ error: 'Invalid adult count' });
  const room = adult.rooms[rType];
  if (!room) return res.status(400).json({ error: 'Invalid room type' });
  if (isNaN(eIdx) || eIdx < 0 || eIdx >= room.history.length) return res.status(400).json({ error: 'Invalid entry index' });
  room.history.splice(eIdx, 1);
  saveHistory();
  res.json({ status: 'ok' });
});

app.delete('/api/history/:hotelIndex/adult/:adultCount/room/:roomType', (req, res) => {
  const hIdx = parseInt(req.params.hotelIndex);
  const aCount = parseInt(req.params.adultCount);
  const rType = req.params.roomType;
  if (isNaN(hIdx) || hIdx < 0 || hIdx >= hotels.length) return res.status(400).json({ error: 'Invalid hotel index' });
  const adult = hotels[hIdx].adults.find(a => a.count === aCount);
  if (!adult) return res.status(400).json({ error: 'Invalid adult count' });
  const room = adult.rooms[rType];
  if (!room) return res.status(400).json({ error: 'Invalid room type' });
  room.history = [];
  room.previousPrice = null;
  saveHistory();
  res.json({ status: 'ok' });
});

app.delete('/api/history/:hotelIndex/adult/:adultCount/weekday/:dateStr/entry/:entryIndex', (req, res) => {
  const hIdx = parseInt(req.params.hotelIndex);
  const aCount = parseInt(req.params.adultCount);
  const dateStr = req.params.dateStr;
  const eIdx = parseInt(req.params.entryIndex);
  if (isNaN(hIdx) || hIdx < 0 || hIdx >= hotels.length) return res.status(400).json({ error: 'Invalid hotel index' });
  const adult = hotels[hIdx].adults.find(a => a.count === aCount);
  if (!adult) return res.status(400).json({ error: 'Invalid adult count' });
  const hist = adult.weekPricesHistory?.[dateStr];
  if (!hist) return res.status(400).json({ error: 'Invalid date' });
  if (isNaN(eIdx) || eIdx < 0 || eIdx >= hist.length) return res.status(400).json({ error: 'Invalid entry index' });
  hist.splice(eIdx, 1);
  if (hist.length === 0) delete adult.weekPricesHistory[dateStr];
  saveHistory();
  res.json({ status: 'ok' });
});

app.delete('/api/history/:hotelIndex/adult/:adultCount/weekday/:dateStr', (req, res) => {
  const hIdx = parseInt(req.params.hotelIndex);
  const aCount = parseInt(req.params.adultCount);
  const dateStr = req.params.dateStr;
  if (isNaN(hIdx) || hIdx < 0 || hIdx >= hotels.length) return res.status(400).json({ error: 'Invalid hotel index' });
  const adult = hotels[hIdx].adults.find(a => a.count === aCount);
  if (!adult) return res.status(400).json({ error: 'Invalid adult count' });
  if (adult.weekPricesHistory) delete adult.weekPricesHistory[dateStr];
  saveHistory();
  res.json({ status: 'ok' });
});

app.delete('/api/history/:hotelIndex/adult/:adultCount', (req, res) => {
  const hIdx = parseInt(req.params.hotelIndex);
  const aCount = parseInt(req.params.adultCount);
  if (isNaN(hIdx) || hIdx < 0 || hIdx >= hotels.length) return res.status(400).json({ error: 'Invalid hotel index' });
  const adult = hotels[hIdx].adults.find(a => a.count === aCount);
  if (!adult) return res.status(400).json({ error: 'Invalid adult count' });
  for (const t of ROOM_TYPES) { adult.rooms[t].history = []; adult.rooms[t].previousPrice = null; }
  adult.weekPricesHistory = {};
  saveHistory();
  res.json({ status: 'ok' });
});

app.delete('/api/history/:hotelIndex', (req, res) => {
  const hIdx = parseInt(req.params.hotelIndex);
  if (isNaN(hIdx) || hIdx < 0 || hIdx >= hotels.length) return res.status(400).json({ error: 'Invalid hotel index' });
  for (const a of hotels[hIdx].adults) {
    for (const t of ROOM_TYPES) { a.rooms[t].history = []; a.rooms[t].previousPrice = null; }
    a.weekPricesHistory = {};
  }
  saveHistory();
  res.json({ status: 'ok' });
});

app.delete('/api/history', (req, res) => {
  for (const h of hotels) {
    for (const a of h.adults) {
      for (const t of ROOM_TYPES) { a.rooms[t].history = []; a.rooms[t].previousPrice = null; }
      a.weekPricesHistory = {};
    }
  }
  saveHistory();
  res.json({ status: 'ok', message: 'All history cleared' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  loadHotels();
  if (hotels.length === 0) { console.error('No hotels loaded. Check hotel links.txt'); process.exit(1); }
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  await scrapeAll();
  global.lastScrape = new Date().toISOString();
  scheduleNext();
}

function scheduleNext() {
  global.nextScrape = new Date(Date.now() + INTERVAL).toISOString();
  setTimeout(async () => {
    await scrapeAll();
    global.lastScrape = new Date().toISOString();
    scheduleNext();
  }, INTERVAL);
}

start();
