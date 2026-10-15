// Puts the popup into a given state on load, so a screenshot can be taken
// without depending on synthetic clicks from outside the page.
// Usage: harness.html#ann | #ann,open | #bin
const want = decodeURIComponent(location.hash.slice(1)).split(',').filter(Boolean);
if (want.length) {
  const ready = setInterval(() => {
    const rows = document.querySelectorAll('#ann-list .row.ann');
    if (!rows.length) return;
    clearInterval(ready);
    const tab = (name) => document.querySelector(`.tab[data-tab="${name}"]`).click();
    if (want.includes('done')) {
      const heads = document.querySelectorAll('#pane-due .group-head');
      document.querySelectorAll('#pane-due .group-body .row')[2].querySelector('.check').click();
      setTimeout(() => document.querySelectorAll('#pane-due .group-head')[1].click(), 60);
    }
    if (want.includes('notes')) tab('notes');
    if (want.includes('ann') || want.includes('open')) tab('ann');
    if (want.includes('open')) document.querySelectorAll('#ann-list .row.ann')[1].click();
    if (want.includes('bin')) {
      document.querySelectorAll('#ann-list .row.ann')[0].querySelector('.x-btn').click();
      setTimeout(() => {
        document.querySelectorAll('#ann-list .row.ann')[2].querySelector('.x-btn').click();
        setTimeout(() => tab('bin'), 60);
      }, 60);
    }
  }, 30);
}
