import { fetchAgenda, IMPORTANT_THRESHOLD } from './canvas.js';

const ALARM = 'canvas-poll';

async function schedule() {
  const { intervalMin = 30, badgeOn = true } = await chrome.storage.local.get(['intervalMin', 'badgeOn']);
  await chrome.alarms.clear(ALARM);
  if (badgeOn) {
    chrome.alarms.create(ALARM, { periodInMinutes: Math.max(15, intervalMin), delayInMinutes: 1 });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

function countImportant(data, stars, dismissed) {
  if (!data) return 0;
  return data.announcements.filter(
    (a) => !dismissed[a.id] && (a.unread || stars[a.id]) && a.score >= IMPORTANT_THRESHOLD,
  ).length;
}

async function paintBadge(data) {
  const cfg = await chrome.storage.local.get(['badgeOn', 'stars', 'cache', 'dismissed']);
  if (cfg.badgeOn === false) return chrome.action.setBadgeText({ text: '' });
  const n = countImportant(data || cfg.cache, cfg.stars || {}, cfg.dismissed || {});
  await chrome.action.setBadgeBackgroundColor({ color: '#d0302a' });
  await chrome.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '' });
}

async function poll() {
  const cfg = await chrome.storage.local.get(['base', 'token', 'stars', 'badgeOn']);
  if (!cfg.base || !cfg.token || cfg.badgeOn === false) return;
  // Skip silently if the user hasn't granted this origin yet.
  if (!(await chrome.permissions.contains({ origins: [`${cfg.base}/*`] }))) return;
  try {
    const data = await fetchAgenda({ base: cfg.base, token: cfg.token, stars: cfg.stars || {} });
    await chrome.storage.local.set({ cache: data });
    await paintBadge(data);
  } catch {
    // Network blips and expired tokens surface in the popup, not the badge.
  }
}

chrome.runtime.onInstalled.addListener(() => { schedule(); paintBadge(); });
chrome.runtime.onStartup.addListener(() => { schedule(); paintBadge(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) poll(); });
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'reschedule') { schedule().then(poll).then(() => respond({ ok: true })); return true; }
  if (msg?.type === 'refreshBadge') { paintBadge().then(() => respond({ ok: true })); return true; }
  return false;
});
