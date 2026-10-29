/**
 * A self-contained stand-in for Klaviyo's Subscriber growth page (https://www.klaviyo.com/people/subscribers), served
 * by the Section 10 extension E2E in a real Chromium. It starts in the live state seen on 2026-10-29 — Overview
 * selected, "Last 7 days", "Subscriber overview" / "Subscriber trends" — and behaves like React: a tab click removes the
 * view at once and renders the new one after a delay, charts plot after the numbers, and a floating composer sits over
 * the card. Like the live page (run a42cdfd6), a "Last updated now" refresh icon spins forever (a looping CSS
 * animation) beside the date range. It has real layout, so crop geometry is the browser's own.
 */
export function subscriberGrowthE2ePage(accountName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Subscriber growth | Klaviyo</title><style>
  body{margin:0;font:14px/1.4 system-ui,sans-serif;color:#1c1c1c;background:#fafafa}
  header{height:48px;display:flex;align-items:center;justify-content:flex-end;padding:0 16px;background:#fff;border-bottom:1px solid #ddd}
  main{margin:12px 16px;padding:12px 16px;background:#fff;border:1px solid #ddd;border-radius:6px}
  h1{font-size:20px;margin:0 0 8px} h2{font-size:15px;margin:10px 0 6px}
  [role=tablist]{display:flex;gap:6px;margin:6px 0} [role=tab]{padding:6px 12px;border:1px solid #bbb;background:#fff;border-radius:4px;cursor:pointer}
  [role=tab][aria-selected=true]{background:#1c1c1c;color:#fff}
  #date{padding:6px 10px;border:1px solid #bbb;background:#fff;border-radius:4px}
  .metrics{display:flex;gap:24px;margin:8px 0}.metric{display:flex;flex-direction:column}.metric strong{font-size:20px}
  svg{display:block;width:100%;height:150px;margin:6px 0;background:#fcfcff}
  [role=dialog]{position:fixed;top:120px;left:200px;padding:12px;background:#fff;border:1px solid #888;box-shadow:0 4px 16px #0003}
  .updated{display:inline-flex;gap:6px;align-items:center;margin-left:16px;color:#555}
  .refresh{display:inline-block;animation:spin 1.2s linear infinite} @keyframes spin{to{transform:rotate(360deg)}}
  #composer{position:fixed;right:24px;bottom:150px;width:320px;height:70px;background:#efe9ff;border:1px solid #b9a6ff;border-radius:8px;padding:8px}
</style></head><body>
<header><button aria-label="Account menu">${accountName}</button></header>
<main id="page"></main>
<aside id="composer">Which segments am I over-sending to?</aside>
<script>
  const state = { channel: "Overview", view: "Growth", period: "Last 7 days" };
  const main = document.getElementById("page");
  const tab = (name, on, group) => '<button role="tab" data-group="' + group + '" aria-selected="' + on + '">' + name + '</button>';
  function growth(content) {
    content.innerHTML = '<h2>Email subscribers</h2><div role="tablist" id="views">' + ["Growth", "Opt-in sources", "Exclusion sources"].map((name) => tab(name, state.view === name, "view")).join("") + '</div><div class="metrics" id="metrics"></div><div id="charts"></div>';
    if (state.view !== "Growth") { content.querySelector("#metrics").innerHTML = "<p>" + state.view + " table</p>"; return; }
    setTimeout(() => { const m = content.querySelector("#metrics"); if (m) m.innerHTML = '<div class="metric"><span>Email subscribers</span><strong>17,698</strong><span>+2.1%</span></div><div class="metric"><span>New subscribers</span><strong>943</strong><span>-3%</span></div><div class="metric"><span>Exclusions</span><strong>499</strong></div>'; }, 250);
    setTimeout(() => { const c = content.querySelector("#charts"); if (c) c.innerHTML =
      '<svg id="line" viewBox="0 0 600 150" preserveAspectRatio="none"><path d="M0 120 L100 110 L200 95 L300 90 L400 70 L500 60 L600 40" stroke="#3355ff" stroke-width="2" fill="none"></path></svg>' +
      '<svg id="bar" viewBox="0 0 600 150" preserveAspectRatio="none">' + Array.from({ length: 12 }, (_, i) => '<rect x="' + (i * 50 + 5) + '" y="' + (40 + (i % 4) * 15) + '" width="14" height="' + (110 - (i % 4) * 15) + '" fill="#3355ff"></rect><rect x="' + (i * 50 + 22) + '" y="120" width="14" height="30" fill="#ff7744"></rect>').join("") + '</svg>'; }, 700);
  }
  function render() {
    main.innerHTML = '<h1>Subscriber growth</h1><div role="tablist" id="channels">' + ["Overview", "Email", "Text message"].map((name) => tab(name, state.channel === name, "channel")).join("") + '</div><button id="date">' + state.period + '</button><span class="updated">Last updated now <span class="refresh" aria-hidden="false">↻</span></span><section id="content"></section>';
    const content = main.querySelector("#content");
    if (state.channel === "Overview") content.innerHTML = '<h2>Subscriber overview</h2><p>Email 17,698 · Text message 2,104</p><h2>Subscriber trends</h2>';
    else if (state.channel === "Text message") content.innerHTML = '<h2>Text message subscribers</h2><p>2,104</p>';
    else growth(content);
  }
  function rerender() { main.innerHTML = ""; setTimeout(render, 200); }
  document.addEventListener("click", (event) => {
    const target = event.target;
    const group = target.getAttribute && target.getAttribute("data-group");
    if (group) { if (group === "channel") state.channel = target.textContent; else state.view = target.textContent; rerender(); return; }
    if (target.id === "date") { document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><input aria-label="Start date" placeholder="MM/DD/YYYY"> <input aria-label="End date" placeholder="MM/DD/YYYY"> <button id="apply">Apply</button></div>'); return; }
    if (target.id === "apply") { const [start, end] = Array.from(document.querySelectorAll("[role=dialog] input")).map((input) => input.value); document.querySelector("[role=dialog]").remove(); state.period = start + " – " + end; rerender(); }
  });
  render();
</script></body></html>`;
}
