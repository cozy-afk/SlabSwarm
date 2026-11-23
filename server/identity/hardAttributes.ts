// Deterministic hard-attribute extraction from noisy listing titles.
//
// No model, no network and no clock. Every value is copied from the title at a
// recorded span with an explicit per-attribute confidence; ambiguous digits
// are never promoted into a different attribute (a cert is not a card number,
// a grade is not a serial run, and a date is not a print run). Missing values
// stay null (UNKNOWN), never zero.

export type HardAttributeName =
  | 'gradingCompany'
  | 'numericGrade'
  | 'certNumber'
  | 'serialRun'
  | 'cardNumber';

export interface HardAttribute {
  name: HardAttributeName;
  /** Normalized value (company uppercased; digits copied verbatim). */
  value: string;
  /** Exact substring of the title that produced the value. */
  raw: string;
  start: number;
  end: number;
  /** Deterministic pattern quality in [0, 1]; never a model probability. */
  confidence: number;
  source: 'TITLE';
}

export interface HardAttributeSet {
  gradingCompany: string | null;
  numericGrade: string | null;
  certNumber: string | null;
  serialRun: string | null;
  cardNumber: string | null;
  /** All extracted attributes, ordered by their span in the title. */
  attributes: HardAttribute[];
  warnings: string[];
}

const COMPANY_BY_TOKEN: Record<string, string> = {
  PSA: 'PSA', BGS: 'BGS', BECKETT: 'BGS', CGC: 'CGC', SGC: 'SGC', RAW: 'RAW',
};
const GRADE_COMPANY = '(?:PSA|BGS|CGC|SGC|Beckett)';
const GRADE_QUALIFIER = '(?:GEM\\s*(?:MT|MINT)|GEMMT|NM-?MT|NM|MINT|PRISTINE)';

function attributesOf(set: HardAttributeSet): HardAttribute[] {
  return set.attributes.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

/** Last-write rule: the strongest pattern wins; earliest span breaks ties. */
function offer(
  set: HardAttributeSet,
  name: HardAttributeName,
  value: string,
  raw: string,
  start: number,
  end: number,
  confidence: number,
): void {
  const existing = set.attributes.find((attribute) => attribute.name === name);
  if (existing && (existing.confidence > confidence
    || (existing.confidence === confidence && existing.start <= start))) return;
  const attribute: HardAttribute = {
    name, value, raw, start, end, confidence, source: 'TITLE',
  };
  set.attributes = [...set.attributes.filter((item) => item.name !== name), attribute];
  set[name] = value;
}

/** Extract every recognizable hard attribute from one listing title. */
export function extractHardAttributes(title: string): HardAttributeSet {
  const text = typeof title === 'string' ? title : '';
  const set: HardAttributeSet = {
    gradingCompany: null,
    numericGrade: null,
    certNumber: null,
    serialRun: null,
    cardNumber: null,
    attributes: [],
    warnings: [],
  };
  if (text.trim() === '') return set;

  // --- Grading company -----------------------------------------------------
  const company = /\b(PSA|BGS|Beckett|CGC|SGC|RAW)\b/gi;
  for (let match = company.exec(text); match; match = company.exec(text)) {
    const token = match[1]!.toUpperCase();
    offer(set, 'gradingCompany', COMPANY_BY_TOKEN[token]!, match[0], match.index,
      match.index + match[0].length, token === 'RAW' ? 0.82 : 0.96);
  }

  // --- Numeric grade -------------------------------------------------------
  // Company-adjacent grades are strongest. A bare grade keyword is weaker but
  // still deterministic; a random two-digit number is never a grade.
  const companyGrade = new RegExp(`\\b${GRADE_COMPANY}\\b(?:\\s+${GRADE_QUALIFIER})?\\s*#?\\s*(\\d{1,2}(?:\\.\\d)?)\\b`, 'gi');
  for (let match = companyGrade.exec(text); match; match = companyGrade.exec(text)) {
    offer(set, 'numericGrade', match[1]!, match[0], match.index,
      match.index + match[0].length, 0.97);
  }
  const keywordGrade = new RegExp(`\\b(?:grade|graded|${GRADE_QUALIFIER})\\s*[:#]?\\s*(\\d{1,2}(?:\\.\\d)?)\\b`, 'gi');
  for (let match = keywordGrade.exec(text); match; match = keywordGrade.exec(text)) {
    offer(set, 'numericGrade', match[1]!, match[0], match.index,
      match.index + match[0].length, 0.88);
  }

  // --- Certificate number --------------------------------------------------
  const labeledCert = /\b(?:cert(?:ificate)?\s*(?:number|no\.?|#|:)?|certno)\s*[:#]?\s*(\d{6,10})\b/gi;
  for (let match = labeledCert.exec(text); match; match = labeledCert.exec(text)) {
    offer(set, 'certNumber', match[1]!, match[0], match.index,
      match.index + match[0].length, 0.96);
  }
  const companyCert = new RegExp(`\\b${GRADE_COMPANY}\\s*#\\s*(\\d{6,10})\\b`, 'gi');
  for (let match = companyCert.exec(text); match; match = companyCert.exec(text)) {
    offer(set, 'certNumber', match[1]!, match[0], match.index,
      match.index + match[0].length, 0.93);
  }
  const bareCert = /\b\d{6,10}\b/g;
  for (let match = bareCert.exec(text); match; match = bareCert.exec(text)) {
    const before = match.index > 0 ? text[match.index - 1] : '';
    if (before === '$' || /[A-Za-z]/.test(before)) continue;
    offer(set, 'certNumber', match[0], match[0], match.index,
      match.index + match[0].length, 0.55);
  }

  // --- Serial run ----------------------------------------------------------
  // A run needs a '/' (or an explicit "of N"); a date such as 11/23/2026 is
  // rejected by the trailing-digit guard and the bare-rule leading-digit guard.
  const run = /(?<![\d/])(\d{1,4})\s*\/\s*(\d{1,4})(?!\d)(?!\s*\/\s*\d)/g;
  for (let match = run.exec(text); match; match = run.exec(text)) {
    offer(set, 'serialRun', `${match[1]}/${match[2]}`, match[0], match.index,
      match.index + match[0].length, 0.95);
  }
  const bareRun = /\/\s*(\d{1,4})\b(?!\s*\/\s*\d)/g;
  for (let match = bareRun.exec(text); match; match = bareRun.exec(text)) {
    const before = match.index > 0 ? text[match.index - 1] : '';
    if (/\d/.test(before)) continue;
    offer(set, 'serialRun', `/${match[1]}`, match[0], match.index,
      match.index + match[0].length, 0.8);
  }
  const ofRun = /\b(?:of|serial(?:\s*(?:run|number))?)\s*#?\s*(\d{1,4})\b/gi;
  for (let match = ofRun.exec(text); match; match = ofRun.exec(text)) {
    offer(set, 'serialRun', `/${match[1]}`, match[0], match.index,
      match.index + match[0].length, 0.75);
  }

  // --- Card number ---------------------------------------------------------
  // An explicit marker is required. The trailing guard keeps a serialized
  // '#23/99' as a serial run instead of inventing card number 23.
  const markedNumber = /(?:card\s*)?(?:no\.?|number|#)\s*?(\d{1,4})\b(?!\s*\/\s*\d)/gi;
  for (let match = markedNumber.exec(text); match; match = markedNumber.exec(text)) {
    offer(set, 'cardNumber', match[1]!, match[0], match.index,
      match.index + match[0].length, 0.9);
  }

  if (set.attributes.length === 0) set.warnings.push('NO_HARD_ATTRIBUTES');
  attributesOf(set);
  return set;
}

export default extractHardAttributes;
