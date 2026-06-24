// Display helpers shared by CLI and web. Pure, no I/O.

/** ms -> "HH:MM:SS" (or "MM:SS" under an hour). Hundredths optional. */
export function fmtDuration(ms        , withHundredths = false)         {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n        ) => String(n).padStart(2, "0");
  const base = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (!withHundredths) return base;
  const cs = Math.floor((ms % 1000) / 10);
  return `${base}.${pad(cs)}`;
}
