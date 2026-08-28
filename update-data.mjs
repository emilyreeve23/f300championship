import fs from "node:fs";

const url = process.env.F300_DATA_URL;

if (!url) {
  throw new Error("F300_DATA_URL has not been configured in GitHub Actions secrets.");
}

const response = await fetch(url, {
  cache: "no-store",
  redirect: "follow"
});

if (!response.ok) {
  throw new Error(`Championship data download failed: HTTP ${response.status}`);
}

const data = await response.json();

if (
  !data ||
  !Array.isArray(data.standings) ||
  !Array.isArray(data.calendar) ||
  !Array.isArray(data.raceResults)
) {
  throw new Error("F300 data feed returned an unexpected format.");
}

const output =
  "window.F300_DATA = " +
  JSON.stringify(data, null, 2) +
  ";\n";

fs.writeFileSync("data.js", output, "utf8");

console.log(
  `F300 data updated: ${data.standings.length} standings rows, ` +
  `${data.calendar.length} calendar rows, ` +
  `${data.raceResults.length} race-result rows.`
);
