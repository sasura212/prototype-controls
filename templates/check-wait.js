// For checking a script from a browser tool: evaluate this in the page after starting something
// (`__prototype.play()`, `__prototype.showPath(id)`, `__prototype.goTo(n)`). It waits, in real time,
// until the player stops (paused, done, or waiting on something it can't find) and says where.
// The page's own timers belong to the player and may be frozen, so it ticks on a MessageChannel.
async () => {
  const channel = new MessageChannel();
  let next;
  channel.port1.onmessage = () => next();
  const tick = () => new Promise((resolve) => ((next = resolve), channel.port2.postMessage(0)));
  const sleep = async (ms) => {
    const started = performance.now();
    while (performance.now() - started < ms) await tick();
  };
  const started = performance.now();
  let result = null;
  // "Waiting for" shows after 20s, which a slow step (a video, a search) can reach while still on
  // track: count it as stuck only once it has lasted another 30s.
  let waitingSince = null;
  while (performance.now() - started < 120_000) {
    result = window.__prototype?.result() ?? null;
    waitingSince = result?.waitingFor ? (waitingSince ?? performance.now()) : null;
    const isStuck = waitingSince !== null && performance.now() - waitingSince > 30_000;
    if (result && !result.skipping && (result.paused || result.done || isStuck)) break;
    await sleep(250);
  }
  return { seconds: Math.round((performance.now() - started) / 1000), url: location.pathname, ...result };
};
