import fs from "node:fs/promises";
import { chromium } from "playwright";
import { evaluateInventory, formatNotification } from "./rules.mjs";

const BOOKING_URL = "https://roamtransit.betterez.com/cart/607a075d39c0361ea1fe027a/reservation/64593b39b59d9c077f9bee55";
const STATE_PATH = "state.json";
const OUTPUT_PATH = "notification.md";
const DATES = ["2026-09-10", "2026-09-11"];

const ariaDate = (date) => {
  const value = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "2-digit", year: "numeric", timeZone: "UTC"
  }).format(value).replace(",", "");
};

const parseTime = (text) => {
  const match = text.match(/Departure\s+(\d{1,2}:\d{2})(AM|PM)/i);
  if (!match) return null;
  let [hours, minutes] = match[1].split(":").map(Number);
  const period = match[2].toUpperCase();
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

export function parseTrips(cards) {
  return cards.map(({ text, selectable }) => {
    const departure = parseTime(text);
    const seatsMatch = text.match(/Only\s+(\d+)\s+seats?\s+available/i);
    const soldOut = /SOLD OUT/i.test(text) || Number(seatsMatch?.[1]) === 0;
    return {
      departure,
      available: Boolean(departure && selectable && !soldOut),
      seats: seatsMatch ? Number(seatsMatch[1]) : null
    };
  }).filter((trip) => trip.departure);
}

async function selectDate(page, inputId, date) {
  await page.locator(`#${inputId}`).click();
  const root = page.locator(`#${inputId}_root`);
  const label = ariaDate(date);
  const targetMonth = new Date(`${date}T12:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

  for (let attempts = 0; attempts < 14; attempts += 1) {
    const month = (await root.locator(".picker__month").textContent())?.trim();
    const year = (await root.locator(".picker__year").textContent())?.trim();
    if (month === targetMonth && year === date.slice(0, 4)) break;
    await root.getByRole("button", { name: "Next month", exact: true }).click();
  }

  const cell = root.getByRole("gridcell", { name: label, exact: true });
  if (await cell.count() !== 1) throw new Error(`Date cell not found: ${label}`);
  await cell.click();
}

async function readTripCards(page) {
  await page.locator(".trip-list [role=listitem]").first().waitFor({ state: "visible", timeout: 30000 });
  const cards = await page.locator(".trip-list [role=listitem]").evaluateAll((items) => items.map((item) => ({
    text: item.innerText,
    selectable: Boolean(item.querySelector('input[type="radio"]'))
  })));
  return parseTrips(cards);
}

async function searchDate(browser, date) {
  const page = await browser.newPage();
  try {
    await page.goto(BOOKING_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator('select[name="from"]').waitFor({ state: "visible", timeout: 30000 });
    await page.locator('select[name="from"]').selectOption({ label: "Banff High School Transit Hub" });
    await page.locator('select[name="to"]').selectOption({ label: "Lake Louise Lakeshore" });
    await selectDate(page, "departureDatePicker", date);
    await selectDate(page, "returnDatePicker", date);

    const adult = page.locator(".fare-item").filter({ hasText: "RES SUPER PASS - Adult" });
    if (await adult.count() !== 1) throw new Error("Adult fare control not found");
    await adult.locator("button.plus-icon").click();
    await page.getByRole("button", { name: "Your trips will load after you press this button.", exact: true }).click();

    const outbound = await readTripCards(page);
    const selectable = page.locator('.trip-list [role=listitem] input[type="radio"]');
    const selectableCount = await selectable.count();
    if (selectableCount === 0) throw new Error(`No selectable outbound trip on ${date}; return inventory cannot be checked`);

    await selectable.first().check();
    const next = page.getByRole("button", { name: "Next", exact: false });
    await next.click();
    const inbound = await readTripCards(page);
    return { outbound, inbound };
  } finally {
    await page.close();
  }
}

async function main() {
  await fs.writeFile(OUTPUT_PATH, "", "utf8");
  const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  const browser = await chromium.launch({ headless: true });
  try {
    const inventory = {};
    for (const date of DATES) inventory[date] = await searchDate(browser, date);
    const result = evaluateInventory(inventory, state);
    await fs.writeFile(STATE_PATH, `${JSON.stringify(result.state, null, 2)}\n`, "utf8");
    if (result.notices.length) {
      await fs.writeFile(OUTPUT_PATH, `${formatNotification(result.notices, BOOKING_URL)}\n`, "utf8");
      console.log(`Found ${result.notices.length} notification item(s).`);
    } else {
      console.log("::SKIP_COMPLETION::");
    }
  } finally {
    await browser.close();
  }
}

main().catch(async (error) => {
  await fs.writeFile(OUTPUT_PATH, "", "utf8").catch(() => {});
  console.error(`Monitor unavailable: ${error.message}`);
  console.log("::SKIP_COMPLETION::");
  process.exitCode = 0;
});
