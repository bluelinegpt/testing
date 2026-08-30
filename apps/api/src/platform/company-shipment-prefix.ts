/**
 * Deterministic, name-derived PSystem prefix candidates.
 *
 * Only English A-Z letters participate. Candidates preserve the order of
 * letters in the Company English name; no random or unrelated fallback is
 * possible. The first candidate is therefore the familiar first three
 * letters ("Lahza" -> "LAH"), followed by other ordered combinations.
 */
export function companyShipmentPrefixCandidates(name: string): readonly string[] {
  const letters = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toUpperCase()
    .replace(/[^A-Z]/gu, "");
  if (letters.length < 3) return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (let first = 0; first < letters.length - 2; first += 1) {
    for (let second = first + 1; second < letters.length - 1; second += 1) {
      for (let third = second + 1; third < letters.length; third += 1) {
        const candidate = `${letters[first]}${letters[second]}${letters[third]}`;
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}
