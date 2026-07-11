// Real-browser smoke test for the browsing-context interaction boundary.
// Run with `npm run test:browser:firefox` or `npm run test:browser:chrome`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Builder, Button, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import firefox from "selenium-webdriver/firefox.js";

const root = process.cwd();
const browserName = process.argv[2];
const COLD_OPEN_BUDGET_MS = 250;
const WARM_OPEN_BUDGET_MS = 50;
if (browserName !== "firefox" && browserName !== "chrome") {
  throw new Error("Expected browser argument: firefox or chrome");
}

async function waitForNumericAttribute(driver, element, attribute, timeoutMs = 5000) {
  const rawValue = await driver.wait(async () => {
    const raw = await element.getAttribute(attribute);
    if (raw === null || raw.trim() === "") return false;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? raw : false;
  }, timeoutMs);
  return Number(rawValue);
}

function enforceLatencyBudget(label, measuredMs, budgetMs) {
  if (measuredMs > budgetMs) {
    throw new Error(`${label} took ${measuredMs.toFixed(2)} ms; budget is ${budgetMs} ms`);
  }
}

async function assertBarPresentation(driver) {
  const result = await driver.executeScript(`
    const panel = document.getElementById("ht-panel-host");
    const bar = panel && panel.shadowRoot && panel.shadowRoot.querySelector(".wf-bar");
    if (!bar) return null;
    const style = getComputedStyle(bar);
    return {
      opacity: style.opacity,
      borderWidths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth
      ],
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      animations: typeof bar.getAnimations === "function" ? bar.getAnimations().length : -1
    };
  `);
  if (
    !result ||
    result.opacity !== "1" ||
    result.animations !== 0 ||
    result.borderWidths.some((width) => width !== "0px") ||
    result.outlineStyle !== "none" ||
    result.boxShadow !== "none"
  ) {
    throw new Error(`Overlay bar retained motion or a decorative edge: ${JSON.stringify(result)}`);
  }
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
}

run("npm", ["run", `build:${browserName}`]);

const temporaryDirectory = mkdtempSync(join(tmpdir(), "tabtrail-browser-test-"));
const firefoxArchive = join(temporaryDirectory, "tabtrail.xpi");
if (browserName === "firefox") {
  run("zip", ["-r", "-q", firefoxArchive, "."], resolve(root, "dist"));
}

const hostilePage = `<!doctype html><html><body style="height:3000px;background:#35688f;color:#fff">
  <input id="pageInput" value="page-seed"><video id="video"></video>
  <button id="outside" style="position:fixed;left:8px;top:100px">outside</button>
  <script>
    window.pageEvents = { keys: 0, keyDetails: [], mouseDetails: [], wheels: 0, pointers: 0, videoF: 0 };
    for (const target of [window, document]) {
      target.addEventListener("keydown", (event) => {
        window.pageEvents.keys += 1;
        window.pageEvents.keyDetails.push({ key: event.key, code: event.code, alt: event.altKey });
        if (event.key.toLowerCase() === "f") window.pageEvents.videoF += 1;
      }, true);
      target.addEventListener("wheel", () => { window.pageEvents.wheels += 1; }, {
        capture: true,
        passive: false,
      });
      target.addEventListener("pointerdown", () => { window.pageEvents.pointers += 1; }, true);
      target.addEventListener("mousedown", (event) => {
        window.pageEvents.mouseDetails.push({ button: event.button, alt: event.altKey });
      }, true);
    }
    document.getElementById("pageInput").focus();
  </script>
</body></html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(hostilePage);
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Test server did not bind");
const pageUrl = `http://127.0.0.1:${address.port}/a`;

let driver;
let extensionOrigin = "";
let extensionControlHandle = "";
try {
  const builder = new Builder().forBrowser(browserName);
  if (browserName === "firefox") {
    const firefoxOptions = new firefox.Options()
      .addArguments("-headless")
      .setPreference("xpinstall.signatures.required", false)
      .setPreference("extensions.autoDisableScopes", 0)
      .setPreference("ui.key.menuAccessKey", 0)
      .setPreference("ui.key.menuAccessKeyFocuses", false);
    const binary = process.env.TABTRAIL_FIREFOX_BINARY;
    if (binary) firefoxOptions.setBinary(binary);
    builder.setFirefoxOptions(firefoxOptions);
    const driverBinary = process.env.TABTRAIL_GECKODRIVER;
    if (driverBinary) {
      const service = new firefox.ServiceBuilder(driverBinary);
      if (process.env.TABTRAIL_WEBDRIVER_DEBUG) {
        service
          .enableVerboseLogging(process.env.TABTRAIL_WEBDRIVER_DEBUG === "trace")
          .setStdio("inherit");
      }
      builder.setFirefoxService(service);
    }
    driver = await builder.build();
    const addonId = await driver.installAddon(firefoxArchive, true);
    console.log(`[browser:firefox] installed ${addonId}`);
    await driver.get("about:debugging#/runtime/this-firefox");
    await driver.sleep(750);
    const debuggingSource = await driver.getPageSource();
    extensionOrigin = debuggingSource.match(/moz-extension:\/\/[^/\"'&<]+/i)?.[0] ?? "";
    if (!extensionOrigin) throw new Error("Could not discover temporary extension origin");
    await driver.get(`${extensionOrigin}/optionsPage/optionsPage.html`);
    await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.set({
        tabtrailSettings: {
          trigger: {
            modifier: "super",
            withShift: false,
            kind: "key",
            keyCode: "KeyH",
            mouseButton: 0
          },
          overlayPosition: null,
          maxVisibleSegments: 8
        }
      }).then(() => done(true), (error) => done(String(error)));
    `);
    // Keep an extension-origin control tab alive for privileged tabs.sendMessage
    // calls, then create the actual page in a separate tab. Opening the control
    // tab after navigating to the page can replace the only page tab in Zen's
    // headless WebDriver implementation.
    extensionControlHandle = await driver.getWindowHandle();
    await driver.switchTo().newWindow("tab");
  } else {
    const chromeOptions = new chrome.Options().addArguments(
      "--headless=new",
      `--load-extension=${resolve(root, "dist")}`,
      "--disable-gpu",
      "--no-first-run",
    );
    const binary = process.env.TABTRAIL_CHROME_BINARY;
    if (binary) chromeOptions.setChromeBinaryPath(binary);
    driver = await builder.setChromeOptions(chromeOptions).build();
  }

  await driver.get(pageUrl);
  await driver.sleep(750);
  await driver.executeScript("history.pushState({}, '', '/b')");
  await driver.sleep(500);
  const pageInput = await driver.findElement(By.id("pageInput"));
  await pageInput.click();
  if (browserName === "firefox") {
    const pageHandle = await driver.getWindowHandle();
    await driver.switchTo().window(extensionControlHandle);
    const openResult = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.tabs.query({}).then((tabs) => {
        const target = tabs.find((tab) => typeof tab.url === "string" && tab.url.includes("127.0.0.1"));
        if (!target || target.id == null) {
          throw new Error("Hostile test tab not found: " + JSON.stringify(tabs));
        }
        return browser.tabs.update(target.id, { active: true }).then(() => (
          browser.tabs.sendMessage(target.id, {
            type: "TRAIL_SHOW",
            state: {
              entries: [{
                url: target.url,
                title: "Hostile page",
                favIconUrl: "",
                timestamp: Date.now(),
                transition: "spa",
                redirected: false,
                historyBacked: true
              }],
              cursor: 0
            }
          }, { frameId: 0 })
        ));
      }).then(done, (error) => done({ ok: false, reason: String(error) }));
    `);
    if (!openResult?.ok) throw new Error(`Could not open overlay: ${JSON.stringify(openResult)}`);
    await driver.switchTo().window(pageHandle);
  } else {
    await pageInput.sendKeys(Key.chord(Key.ALT, "h"));
  }

  let host;
  try {
    host = await driver.wait(
      until.elementLocated(By.id("tabtrail-isolated-overlay-host")),
      5000,
    );
  } catch (error) {
    const diagnostics = await driver.executeScript("return window.pageEvents");
    throw new Error(`Overlay did not open; page diagnostics: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
  const coldKind = await host.getAttribute("data-tabtrail-open-kind");
  const coldSequence = Number(await host.getAttribute("data-tabtrail-open-sequence"));
  const coldHostLatency = await waitForNumericAttribute(
    driver,
    host,
    "data-tabtrail-host-open-latency-ms",
  );
  if (coldKind !== "cold" || !Number.isInteger(coldSequence) || coldSequence < 1) {
    throw new Error(`Invalid cold-open diagnostics: kind=${coldKind}, sequence=${coldSequence}`);
  }
  enforceLatencyBudget("Cold host open", coldHostLatency, COLD_OPEN_BUDGET_MS);
  let coldToggleLatency = null;
  if (browserName === "chrome") {
    coldToggleLatency = await waitForNumericAttribute(
      driver,
      host,
      "data-tabtrail-toggle-latency-ms",
    );
    enforceLatencyBudget("Cold chord-to-visible open", coldToggleLatency, COLD_OPEN_BUDGET_MS);
  }
  await driver.executeScript(
    "window.pageEvents = { keys: 0, keyDetails: [], mouseDetails: [], wheels: 0, pointers: 0, videoF: 0 }",
  );
  const outerShadow = await host.getShadowRoot();
  const frame = await outerShadow.findElement(By.css("iframe"));
  await driver.wait(async () => (await frame.getCssValue("visibility")) === "visible", 5000);
  await driver.switchTo().frame(frame);
  let panelHost;
  try {
    panelHost = await driver.wait(until.elementLocated(By.id("ht-panel-host")), 5000);
  } catch (error) {
    const frameDiagnostics = await driver.executeScript(`return {
      url: location.href,
      readyState: document.readyState,
      body: document.body && document.body.innerHTML,
      error: window.__tabtrailOverlayError || null
    }`);
    throw new Error(`Overlay frame did not initialize: ${JSON.stringify(frameDiagnostics)}`, {
      cause: error,
    });
  }
  const panelShadow = await panelHost.getShadowRoot();
  await assertBarPresentation(driver);
  if (process.env.TABTRAIL_SCREENSHOT_PATH) {
    await driver.sleep(100);
    writeFileSync(process.env.TABTRAIL_SCREENSHOT_PATH, await driver.takeScreenshot(), "base64");
  }
  await (await panelShadow.findElement(By.css(".wf-library"))).click();
  const search = await panelShadow.findElement(By.css(".wf-library-search"));
  await search.sendKeys("f", Key.SPACE, Key.ARROW_DOWN);
  await driver.actions().scroll(0, 0, 0, 240, search).perform();
  const searchValue = await search.getAttribute("value");
  if (!searchValue.startsWith("f ")) {
    throw new Error(`Search did not receive isolated keys: ${searchValue}`);
  }

  await driver.switchTo().defaultContent();
  const pageResult = await driver.executeScript(`return {
    events: window.pageEvents,
    pageValue: document.getElementById("pageInput").value,
    activeId: document.activeElement && document.activeElement.id
  }`);
  if (pageResult.events.keys !== 0 || pageResult.events.videoF !== 0 || pageResult.events.wheels !== 0) {
    throw new Error(`The page observed overlay keys: ${JSON.stringify(pageResult)}`);
  }
  if (pageResult.pageValue !== "page-seed") {
    throw new Error(`The background input changed: ${pageResult.pageValue}`);
  }
  if (pageResult.activeId !== "tabtrail-isolated-overlay-host") {
    throw new Error(`The isolated frame did not own focus: ${JSON.stringify(pageResult)}`);
  }

  let warmHostLatency = null;
  let warmToggleLatency = null;
  {
    const toggleModifier = browserName === "firefox" ? Key.META : Key.ALT;
    await driver.switchTo().frame(frame);
    await search.sendKeys(Key.chord(toggleModifier, "h"));
    await driver.switchTo().defaultContent();
    await driver.wait(async () => (await frame.getCssValue("visibility")) === "hidden", 5000);

    await pageInput.click();
    await pageInput.sendKeys(Key.chord(toggleModifier, "h"));
    await driver.wait(async () => {
      const sequence = Number(await host.getAttribute("data-tabtrail-open-sequence"));
      return Number.isInteger(sequence) && sequence > coldSequence;
    }, 5000);
    warmHostLatency = await waitForNumericAttribute(
      driver,
      host,
      "data-tabtrail-host-open-latency-ms",
    );
    warmToggleLatency = await waitForNumericAttribute(
      driver,
      host,
      "data-tabtrail-toggle-latency-ms",
    );
    const warmKind = await host.getAttribute("data-tabtrail-open-kind");
    if (warmKind !== "warm") {
      throw new Error(`Expected warm reopen diagnostics, received kind=${warmKind}`);
    }
    enforceLatencyBudget("Warm host open", warmHostLatency, WARM_OPEN_BUDGET_MS);
    enforceLatencyBudget("Warm chord-to-visible open", warmToggleLatency, WARM_OPEN_BUDGET_MS);
    await driver.wait(async () => (await frame.getCssValue("visibility")) === "visible", 5000);
    await driver.switchTo().frame(frame);
    await driver.wait(until.elementLocated(By.id("ht-panel-host")), 5000);
    await assertBarPresentation(driver);
    await driver.switchTo().defaultContent();
  }

  await (await driver.findElement(By.id("outside"))).click();
  await driver.sleep(100);
  const outsidePointers = await driver.executeScript("return window.pageEvents.pointers");
  if (outsidePointers < 1) throw new Error("A click outside TabTrail did not reach the page");

  console.log(
    `[browser:${browserName}] overlay precedence and latency OK ` +
      `(cold host ${coldHostLatency.toFixed(2)} ms` +
      `${coldToggleLatency == null ? "" : `, cold toggle ${coldToggleLatency.toFixed(2)} ms`}, ` +
      `warm host ${warmHostLatency.toFixed(2)} ms, ` +
      `warm toggle ${warmToggleLatency.toFixed(2)} ms)`,
  );
} finally {
  if (driver) await driver.quit();
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
