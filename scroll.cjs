const SCROLL_PRESETS = {
  slow: { tickMin: 1600, tickMax: 3400, stepMin: 50, stepMax: 120 },
  normal: { tickMin: 900, tickMax: 2600, stepMin: 85, stepMax: 210 },
  fast: { tickMin: 500, tickMax: 1400, stepMin: 110, stepMax: 260 },
};

function scrollSource(settings) {
  const depth = settings.depth;
  return `(function(){
    if(window.__usaScrollTimer){clearTimeout(window.__usaScrollTimer);window.__usaScrollTimer=null;}
    window.__usaScrollStop=false;
    function rnd(a,b){return a+Math.random()*(b-a);}
    function maxY(){var d=document.documentElement,b=document.body,h=d&&d.scrollHeight||0,hb=b&&b.scrollHeight||0;
      return Math.max(0,Math.max(h,hb)-window.innerHeight)*${depth};}
    function topY(){return window.scrollY||document.documentElement.scrollTop||document.body.scrollTop||0;}
    function tick(){if(window.__usaScrollStop)return;var target=maxY(),y=topY();
      if(y>=target-4){window.scrollTo({top:target,behavior:'smooth'});return;}
      var step=rnd(${settings.stepMin},${settings.stepMax});
      window.scrollTo({top:Math.min(target,y+step),behavior:'smooth'});
      window.__usaScrollTimer=setTimeout(tick,rnd(${settings.tickMin},${settings.tickMax}));}
    window.__usaScrollTimer=setTimeout(tick,rnd(500,1600));
  })();`;
}

function resolveScrollSettings(config) {
  if (!config || config.scrollEnabled === false) return null;
  const preset = SCROLL_PRESETS[config.scrollSpeed] || SCROLL_PRESETS.normal;
  const depth = Math.min(100, Math.max(50, Number(config.scrollDepthPercent) || 95)) / 100;
  return { depth, tickMin: preset.tickMin, tickMax: preset.tickMax, stepMin: preset.stepMin, stepMax: preset.stepMax };
}

// executeJavaScript không tự hết hạn: trang còn đang tải, đang hiện alert()
// hoặc JS bị treo thì lệnh chờ mãi và làm kẹt cả vòng chạy bài.
const SCRIPT_TIMEOUT_MS = 3000;

function runScript(webContents, source, timeoutMs = SCRIPT_TIMEOUT_MS) {
  if (webContents.isDestroyed()) return Promise.resolve();
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  const run = webContents.executeJavaScript(source, true).catch(() => {});
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

async function beginHumanScroll(webContents, config) {
  const settings = resolveScrollSettings(config);
  if (!settings) return;
  await runScript(webContents, scrollSource(settings));
}

async function stopHumanScroll(webContents) {
  await runScript(webContents, 'window.__usaScrollStop=true;if(window.__usaScrollTimer){clearTimeout(window.__usaScrollTimer);}');
}

module.exports = { beginHumanScroll, stopHumanScroll, resolveScrollSettings, runScript };
