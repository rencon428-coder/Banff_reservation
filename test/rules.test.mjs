import test from "node:test";
import assert from "node:assert/strict";
import { evaluateInventory, formatNotification, formatStatusSummary } from "../src/rules.mjs";

const trip = (departure, available, seats = null) => ({ departure, available, seats });
const emptyState = { notifiedSignatures: [] };

test("9/11 only reports newly available trips earlier than the current reservation", () => {
  const result = evaluateInventory({
    "2026-09-11": {
      outbound: [trip("09:20", true, 2), trip("10:15", true, 2)],
      inbound: [trip("20:11", true, 1), trip("21:00", true, 1)]
    }
  }, emptyState);
  assert.deepEqual(result.notices.map((notice) => notice.text), [
    "往路 09:20（残り2席）",
    "復路 20:11（残り1席）"
  ]);
});

test("reported inventory signature is not reported again", () => {
  const state = { notifiedSignatures: ["2026-09-11|inbound|09:27|available|23"] };
  const inventory = { "2026-09-11": { outbound: [], inbound: [trip("09:27", true, 23)] } };
  assert.equal(evaluateInventory(inventory, state).notices.length, 0);
});

test("first live run silently learns all previously reported returns through 15:44", () => {
  const inventory = {
    "2026-09-11": {
      outbound: [],
      inbound: [trip("08:03", true), trip("09:27", true, 23), trip("15:44", true, 1)]
    }
  };
  const result = evaluateInventory(inventory, { notifiedSignatures: [], lastSuccessfulCheck: null });
  assert.equal(result.notices.length, 0);
  assert.equal(result.state.notifiedSignatures.length, 3);
});

test("first live run reports a known return only when seats exceed baseline", () => {
  const inventory = {
    "2026-09-11": { outbound: [], inbound: [trip("13:52", true, 16)] }
  };
  const result = evaluateInventory(inventory, { notifiedSignatures: [], lastSuccessfulCheck: null });
  assert.deepEqual(result.notices.map((notice) => notice.text), ["復路 13:52（残り16席）"]);
});

test("9/10 reports same-day combinations with at least one earlier leg", () => {
  const result = evaluateInventory({
    "2026-09-10": {
      outbound: [trip("10:15", true)],
      inbound: [trip("20:11", true), trip("21:00", true)]
    }
  }, emptyState);
  assert.deepEqual(result.notices.map((notice) => notice.text), [
    "往路 10:15（残席数表示なし）／復路 20:11（残席数表示なし）"
  ]);
});

test("notification includes date and booking link", () => {
  const text = formatNotification([{ date: "2026-09-11", text: "往路 09:20（残り2席）" }], "https://example.test/change");
  assert.match(text, /2026-09-11/);
  assert.match(text, /往路 09:20/);
  assert.match(text, /https:\/\/example\.test\/change/);
});

test("five-minute status includes available target trips and explicit empty states", () => {
  const text = formatStatusSummary({
    "2026-09-10": {
      outbound: [trip("09:20", true, 2), trip("11:02", true, 8)],
      inbound: []
    },
    "2026-09-11": {
      outbound: [],
      inbound: [trip("15:44", true, 1), trip("21:00", true, 4)]
    }
  }, "https://example.test/change", "2026-08-03 09:05");
  assert.match(text, /往路: 09:20（残り2席）/);
  assert.doesNotMatch(text, /11:02/);
  assert.match(text, /復路: 15:44（残り1席）、21:00（残り4席）/);
  assert.match(text, /対象時刻内の予約可能便なし/);
  assert.match(text, /5分ごとの空席状況/);
});
