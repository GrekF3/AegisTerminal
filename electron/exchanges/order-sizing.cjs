function stepPrecision(step) {
  const value = String(step).toLowerCase();
  const [mantissa, exponent = "0"] = value.split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length || 0) - Number(exponent));
}

function floorToStep(value, step) {
  const numericValue = Number(value);
  const numericStep = Number(step);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericStep) || numericStep <= 0) return NaN;
  const ratio = numericValue / numericStep;
  const steps = Math.floor(ratio + Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4);
  return Number((steps * numericStep).toFixed(stepPrecision(numericStep)));
}

function roundToStep(value, step) {
  const numericValue = Number(value);
  const numericStep = Number(step);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericStep) || numericStep <= 0) return NaN;
  const steps = Math.round((numericValue + Number.EPSILON) / numericStep);
  return Number((steps * numericStep).toFixed(stepPrecision(numericStep)));
}

// Least common multiple in decimal units: both venues must accept exactly the same base amount.
function commonStep(...steps) {
  if (steps.some((step) => !Number.isFinite(step) || step <= 0)) throw new Error("Некорректный шаг объёма биржи");
  const precision = Math.max(...steps.map(stepPrecision));
  if (precision > 14) throw new Error("Слишком высокая точность контракта");
  const scale = 10 ** precision;
  const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
  const result = steps.map((step) => BigInt(Math.round(step * scale))).reduce((a, b) => a / gcd(a, b) * b);
  return Number(result) / scale;
}

module.exports = { floorToStep, roundToStep, stepPrecision, commonStep };
