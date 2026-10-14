const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  ConfigStore,
  defaultKeys,
  mobileProfile,
  resolveSiteMode,
  toggledSiteMode,
} = require("../dist/index.js");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-site-"));
  return new ConfigStore({
    settings: path.join(dir, "settings.json"),
    shortcuts: path.join(dir, "shortcuts.json"),
  });
}

const LAUNCHER = { TERM_PROGRAM: "termux-launcher" };
const DESKTOP = { TERM_PROGRAM: "kitty" };

test("site mode defaults to auto and accepts only auto, mobile, desktop", () => {
  const store = tempStore();
  assert.equal(store.load().settings["site.mode"], "auto");
  store.setSetting("site.mode", "mobile");
  assert.equal(store.load().settings["site.mode"], "mobile");

  fs.writeFileSync(store.files.settings, JSON.stringify({ "site.mode": "tablet" }));
  const loaded = store.load();
  assert.equal(loaded.settings["site.mode"], "auto");
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0], /site\.mode/);
});

test("auto resolves to mobile only inside termux-launcher", () => {
  assert.equal(resolveSiteMode("auto", LAUNCHER), "mobile");
  assert.equal(resolveSiteMode("auto", DESKTOP), "desktop");
  assert.equal(resolveSiteMode("auto", {}), "desktop");
  assert.equal(resolveSiteMode("desktop", LAUNCHER), "desktop");
  assert.equal(resolveSiteMode("mobile", DESKTOP), "mobile");
});

test("toggling flips what the mode resolves to", () => {
  assert.equal(toggledSiteMode("auto", LAUNCHER), "desktop");
  assert.equal(toggledSiteMode("auto", DESKTOP), "mobile");
  assert.equal(toggledSiteMode("mobile", LAUNCHER), "desktop");
  assert.equal(toggledSiteMode("desktop", LAUNCHER), "mobile");
});

test("the toggle has a default shortcut", () => {
  assert.deepEqual(defaultKeys("site.toggle", "linux"), ["ctrl+shift+m"]);
});

test("the mobile profile reports the running chrome as an android phone", () => {
  const profile = mobileProfile("138.0.7204.243");
  assert.equal(
    profile.userAgent,
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  );
  const metadata = profile.userAgentMetadata;
  assert.equal(metadata.platform, "Android");
  assert.equal(metadata.platformVersion, "16");
  assert.equal(metadata.model, "Pixel 9");
  assert.equal(metadata.mobile, true);
  assert.deepEqual(
    metadata.brands.find((entry) => entry.brand === "Chromium"),
    { brand: "Chromium", version: "138" },
  );
  assert.deepEqual(
    metadata.fullVersionList.find((entry) => entry.brand === "Google Chrome"),
    { brand: "Google Chrome", version: "138.0.7204.243" },
  );
});
