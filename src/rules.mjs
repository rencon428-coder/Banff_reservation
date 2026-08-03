const toMinutes = (time) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const seatText = (seats) => seats == null ? "残席数表示なし" : `残り${seats}席`;

const tripKey = (date, direction, trip) =>
  `${date}|${direction}|${trip.departure}|${trip.available ? "available" : "sold-out"}|${trip.seats ?? "unknown"}`;

const comboKey = (date, outbound, inbound) =>
  `${date}|combo|${outbound.departure}|${inbound.departure}|${outbound.seats ?? "unknown"}|${inbound.seats ?? "unknown"}`;

export function evaluateInventory(inventory, state) {
  const seen = new Set(state.notifiedSignatures ?? []);
  const isInitialRun = !state.lastSuccessfulCheck;
  const sep11ReportedSeats = new Map([
    ["09:27", 23],
    ["13:52", 15],
    ["14:47", 23],
    ["15:44", 1]
  ]);
  const newSignatures = [];
  const notices = [];

  const remember = (signature) => {
    if (seen.has(signature)) return false;
    seen.add(signature);
    newSignatures.push(signature);
    return true;
  };

  const sep11 = inventory["2026-09-11"];
  if (sep11) {
    for (const trip of sep11.outbound.filter((trip) => trip.available && toMinutes(trip.departure) < toMinutes("10:15"))) {
      const signature = tripKey("2026-09-11", "outbound", trip);
      if (remember(signature)) {
        notices.push({
          date: "2026-09-11",
          kind: "outbound",
          text: `往路 ${trip.departure}（${seatText(trip.seats)}）`
        });
      }
    }

    for (const trip of sep11.inbound.filter((trip) => trip.available && toMinutes(trip.departure) < toMinutes("21:00"))) {
      const signature = tripKey("2026-09-11", "inbound", trip);
      // The supplied baseline says every selectable return from 07:05 through
      // 15:44 was already reported. On the first live run, learn their exact
      // schedule without generating a duplicate notification. A displayed
      // seat count above the supplied baseline is still a meaningful increase.
      if (isInitialRun && toMinutes(trip.departure) <= toMinutes("15:44")) {
        const reportedSeats = sep11ReportedSeats.get(trip.departure);
        if (reportedSeats == null || trip.seats == null || trip.seats <= reportedSeats) {
          remember(signature);
          continue;
        }
      }
      if (remember(signature)) {
        notices.push({
          date: "2026-09-11",
          kind: "inbound",
          text: `復路 ${trip.departure}（${seatText(trip.seats)}）`
        });
      }
    }
  }

  const sep10 = inventory["2026-09-10"];
  if (sep10) {
    const outbounds = sep10.outbound.filter((trip) => trip.available && toMinutes(trip.departure) <= toMinutes("10:15"));
    const inbounds = sep10.inbound.filter((trip) => trip.available && toMinutes(trip.departure) <= toMinutes("21:00"));

    for (const outbound of outbounds) {
      for (const inbound of inbounds) {
        if (toMinutes(outbound.departure) >= toMinutes(inbound.departure)) continue;
        if (outbound.departure === "10:15" && inbound.departure === "21:00") continue;
        const signature = comboKey("2026-09-10", outbound, inbound);
        if (remember(signature)) {
          notices.push({
            date: "2026-09-10",
            kind: "combination",
            text: `往路 ${outbound.departure}（${seatText(outbound.seats)}）／復路 ${inbound.departure}（${seatText(inbound.seats)}）`
          });
        }
      }
    }
  }

  return {
    notices,
    state: {
      ...state,
      lastSuccessfulCheck: new Date().toISOString(),
      lastInventory: inventory,
      notifiedSignatures: [...seen]
    }
  };
}

export function formatNotification(notices, bookingUrl) {
  const groups = new Map();
  for (const notice of notices) {
    if (!groups.has(notice.date)) groups.set(notice.date, []);
    groups.get(notice.date).push(notice.text);
  }

  const lines = ["## Roam Transit 8X 空席通知", ""];
  for (const [date, entries] of groups) {
    lines.push(`### ${date}`, "", ...entries.map((entry) => `- ${entry}`), "");
  }
  lines.push(`[予約変更・空席確認ページ](${bookingUrl})`);
  return lines.join("\n");
}
