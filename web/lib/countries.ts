// Country choices for addresses. Stored as ISO 3166-1 alpha-2 (the
// employee_private.country_code column); shown as names, because nobody
// thinks of their own country as "JM".

const CODES = (
  "AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BQ BR BS BT BW BY BZ " +
  "CA CD CF CG CH CI CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH " +
  "GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC " +
  "LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MS MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR " +
  "NZ OM PA PE PG PH PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SX SY " +
  "SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WS YE ZA ZM ZW"
).split(" ");

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

// Jamaica first (most HaloManage organizations are Jamaican), then A–Z.
export const COUNTRIES: { code: string; name: string }[] = [
  { code: "JM", name: countryName("JM") },
  ...CODES.filter((c) => c !== "JM").map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name)),
];

export const JAMAICA_PARISHES = [
  "Kingston", "St. Andrew", "St. Thomas", "Portland", "St. Mary", "St. Ann", "Trelawny",
  "St. James", "Hanover", "Westmoreland", "St. Elizabeth", "Manchester", "Clarendon", "St. Catherine",
];
