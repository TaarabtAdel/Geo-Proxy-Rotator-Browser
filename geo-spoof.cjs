function geoScript(location) {
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  return `(() => {
    const position = () => ({
      coords: { latitude: ${lat}, longitude: ${lng}, accuracy: 100, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now()
    });
    try {
      const geo = navigator.geolocation;
      geo.getCurrentPosition = (ok) => { try { ok(position()); } catch (e) {} };
      geo.watchPosition = (ok) => { try { ok(position()); } catch (e) {} return 1; };
    } catch (e) {}
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const original = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (params) => (
          params && params.name === "geolocation"
            ? Promise.resolve({ state: "granted", onchange: null })
            : original(params)
        );
      }
    } catch (e) {}
  })();`;
}

async function applyLocation(tab, location) {
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) throw Error('Tab đã đóng.');
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach('1.3');
    tab.geoScript = null;
  }
  await wc.debugger.sendCommand('Emulation.setGeolocationOverride', {
    latitude: Number(location.lat),
    longitude: Number(location.lng),
    accuracy: 100,
  });
  await wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: location.timezone });
  const key = `${location.lat}:${location.lng}`;
  if (tab.geoScript?.key !== key) {
    if (tab.geoScript?.id) {
      await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: tab.geoScript.id }).catch(() => {});
    }
    tab.geoScript = null;
    try {
      const r = await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: geoScript(location) });
      tab.geoScript = { key, id: r?.identifier };
    } catch {
      /* optional */
    }
  }
}

module.exports = { applyLocation, geoScript };
