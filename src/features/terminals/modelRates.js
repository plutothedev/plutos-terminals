// (C)
// What the live cost estimate charges per million tokens, by Claude model.
//
// The estimate (TerminalPane's checkCost, rules in costScan.js) multiplies the
// tokens Claude Code reports by one blended rate, because the inline status
// banner shows tokens climbing but never the dollar figure. Until 2026-10 the
// rate was one number per FAMILY (opus 12.0, sonnet 2.5, haiku 0.7), which
// matched Opus 4/4.1, Sonnet 4 and Haiku 3.5. Opus 4.5 cut Opus prices by two
// thirds and Opus 5.5 cut them again, so the default Claude Code model was
// estimated at about 3.7 times its real cost, and Fable had no family at all
// (it read as Opus). The rate now follows the version as well.
//
// Prices are Anthropic's list prices per million tokens (input, cache read,
// output), from https://platform.claude.com/docs/en/about-claude/pricing as
// read on 2026-10-05. The blend keeps the mix the estimate has always assumed
// for a Claude Code session: 75% cache reads, 12% fresh input, 13% output.
// Real cost depends on the actual split, so this is an estimate; an explicit
// "Total cost: $X.XX" line from /cost replaces it whenever one appears.
// Update the table when Anthropic reprices; nothing else needs to change.

const MIX = { cacheRead: 0.75, input: 0.12, output: 0.13 };

// Newest first within each family. `from` is the first version a row prices;
// a version newer than every row takes the first row (a release this table has
// not met yet is priced like the newest one it knows). `retired` rows still
// price old sessions but never serve as a family's unversioned rate.
const PRICES = [
  { family: "fable", from: [5, 1], input: 10, cacheRead: 0.25, output: 50 }, // Fable 5.1
  { family: "fable", from: [5, 0], input: 10, cacheRead: 1, output: 50 }, // Fable 5
  { family: "opus", from: [5, 5], input: 4, cacheRead: 0.2, output: 20 }, // Opus 5.5
  { family: "opus", from: [4, 5], input: 5, cacheRead: 0.5, output: 25 }, // Opus 4.5 to 5
  { family: "opus", from: [4, 0], input: 15, cacheRead: 1.5, output: 75, retired: true }, // Opus 4, 4.1
  { family: "sonnet", from: [5, 0], input: 2, cacheRead: 0.2, output: 10 }, // Sonnet 5, 5.5
  { family: "sonnet", from: [4, 0], input: 3, cacheRead: 0.3, output: 15 }, // Sonnet 4 to 4.6
  { family: "haiku", from: [4, 5], input: 1, cacheRead: 0.1, output: 5 }, // Haiku 4.5
  { family: "haiku", from: [3, 5], input: 0.8, cacheRead: 0.08, output: 4, retired: true }, // Haiku 3.5
];
// The Claude 3 models price as each family's oldest row: Sonnet 3.5 and 3.7
// cost what Sonnet 4 does and Opus 3 what Opus 4 does, so those read right.
// Haiku 3 is no longer on the pricing page and reads as Haiku 3.5, about three
// times its old price.

// Mythos is priced exactly as Fable, version for version.
const FAMILY_ALIAS = { mythos: "fable" };

// What the estimate assumes before any model has been named in the pane: an
// Opus session (most Claude Code sessions are), at its family's unversioned
// rate below. That is the typical case, no longer the worst one (the old
// family table charged Opus 4's rate here): a Fable session whose banner never
// showed would read at about half its cost, and fast mode's higher price is
// not modelled at all. The banner names the model on the first screen of a
// session, and the reading sticks, so this rarely lasts.
export const DEFAULT_MODEL = "opus";

const blend = (row) => MIX.cacheRead * row.cacheRead + MIX.input * row.input + MIX.output * row.output;

const atOrAfter = (v, from) => v[0] > from[0] || (v[0] === from[0] && v[1] >= from[1]);

// Parse a model key from costScan.detectModel: "opus 4.7", "fable 5.1", or a
// bare family ("opus") when the text named no version.
function parseKey(key) {
  const m = /^([a-z]+)(?: (\d+)\.(\d+))?$/.exec(typeof key === "string" ? key : "");
  if (!m) return null;
  const family = FAMILY_ALIAS[m[1]] || m[1];
  return { family, version: m[2] === undefined ? null : [Number(m[2]), Number(m[3])] };
}

// Blended USD per million tokens for a model key, or for DEFAULT_MODEL when
// the key is missing or names no family this table prices. A bare family is
// charged at the dearest rate still sold in it, so an unknown version
// overestimates rather than under.
export function blendedRatePerM(key) {
  const parsed = parseKey(key) || parseKey(DEFAULT_MODEL);
  let rows = PRICES.filter((r) => r.family === parsed.family);
  if (rows.length === 0) rows = PRICES.filter((r) => r.family === parseKey(DEFAULT_MODEL).family);
  if (!parsed.version) {
    return Math.max(...rows.filter((r) => !r.retired).map(blend));
  }
  const row = rows.find((r) => atOrAfter(parsed.version, r.from)) || rows[rows.length - 1];
  return blend(row);
}
