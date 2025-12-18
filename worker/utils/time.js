export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function throttle(delayMs) {
  const ms = Number(delayMs);
  if (Number.isFinite(ms) && ms > 0) {
    await sleep(ms);
  }
}
