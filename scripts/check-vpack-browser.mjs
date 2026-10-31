import fs from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import path from "node:path";
import assert from "node:assert/strict";
const server = await createServer({
  root: path.resolve(import.meta.dirname, ".."),
  server: { host: "127.0.0.1", port: 1423, strictPort: true, hmr: false },
  logLevel: "error",
});
await server.listen();
let browser;
try {
  const out = path.resolve(import.meta.dirname, "../.local/browser-check");
  await fs.mkdir(out, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.VLAUNCHER_CHROME_PATH,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.route("https://**/*", (r) =>
    r.fulfill({
      json: r.request().url().includes("/projects")
        ? { items: [], total: 0 }
        : [],
    }),
  );
  const mock = `
import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
localStorage.setItem('vlauncher.analytics.enabled','false');
localStorage.setItem('vlauncher.experimental.joint-catalog','true');
window.qa={mode:'missing',installed:false,running:false,calls:[],pending:[],next:0,records:[]};
const profile={id:'11111111-1111-4111-8111-111111111111',name:'VoxelCore',voxelcore_version:'0.32.7',active_revision:'initial',roots:[],root_requirements:{},packages:[],external_packages:[],manual_packages:[]};
window.qa.profile=profile;window.qa.profiles=[profile];
const runtime={version:'0.32.7',platform:'macos',architecture:'aarch64',path:'/tmp/runtime'};
mockWindows('main');
mockIPC(async(cmd,args)=>{
 window.qa.calls.push(cmd);window.qa.records.push({cmd,args});
 switch(cmd){
 case 'list_profiles':return window.qa.profiles;
 case 'list_runtimes':return window.qa.installed?[{...runtime,version:profile.main_build?'0.0.0-main.'+profile.main_build.artifact_id+'+g'+profile.main_build.sha:runtime.version}]:[];
 case 'list_official_runtimes':return [{version:'0.32.7',channel:'stable',artifact_size:100}];
 case 'running_profiles':return window.qa.running?[window.qa.runningProfile??profile.id]:[];
 case 'launcher_info':return {version:'1.6.0',platform:'macos',architecture:'aarch64'};
 case 'check_profile_health':if(window.qa.mode==='stale')return [{kind:'runtime_missing',component:'runtime',message:'Не установлена',repairable:true}];return window.qa.mode==='external'?[{kind:'runtime',component:'runtime',message:'Не найдена подключённая папка игры.',repairable:false}]:window.qa.installed&&window.qa.mode!=='broken'?[]:[{kind:window.qa.mode==='broken'?'runtime':'runtime_missing',component:'runtime',message:'Не найдены файлы',repairable:true}];
 case 'install_mainline_build':window.qa.installed=true;window.qa.mode='ready';return runtime;
 case 'reconnect_profile_source':window.qa.mode='ready';window.qa.installed=true;return profile;
 case 'install_official_runtime':await new Promise(r=>setTimeout(r,500));if(window.qa.mode==='network')throw 'network unavailable';if(window.qa.mode==='cancel')throw 'download paused by user';window.qa.installed=true;window.qa.mode='ready';return runtime;
 case 'launch_profile':window.qa.running=true;window.qa.runningProfile=args.profileId;return 42;
 case 'cancel_transfer':window.qa.mode='cancel';return;
 case 'list_worlds':return [];
 case 'profile_storage':return {total_bytes:0,game_bytes:0,snapshot_bytes:0,reclaimable_bytes:0,snapshot_count:0};
 case 'plugin:dialog|open':return '/tmp/demo.vpack';
 case 'plugin:dialog|save':return window.qa.saveCancelled?null:'/tmp/export.vpack';
 case 'pending_vpack_files':{const snapshot=structuredClone(window.qa.pending);if(window.qa.delayNextRead){const delay=window.qa.delayNextRead;window.qa.delayNextRead=0;window.qa.delayedReadStarted=true;await new Promise(resolve=>setTimeout(resolve,delay));}return snapshot;}
 case 'acknowledge_vpack_file':window.qa.pending=window.qa.pending.filter(p=>p.id!==args.id);return;
 case 'prepare_vpack_export':return {token:'prepared-'+(++window.qa.next),archive_size:3072,preview:{manifest:{name:profile.name,voxelcore_version:'0.32.7',worlds:args.worlds,settings:args.settings,packages:[{id:'reference_mod',version:'1.0.0',embedded:null},{id:'modified_mod',version:'2.0.0',embedded:'packages/1.zip'}]},local_mods:1,download_size:1024}};
 case 'save_vpack_export':return;
 case 'discard_vpack_export':return;
 case 'plugin:opener|reveal_item_in_dir':return;
 case 'plugin:app|version':return '1.6.0';
 case 'cache_status':return {artifacts:0,artifact_bytes:0,partial_downloads:0,partial_bytes:0};
 case 'library_location':return '/tmp/library';
 case 'mainline_status':return {enabled:false};
 case 'profile_settings_info':return {controls:false,settings:false,can_restore:false};

 case 'inspect_vpack':if(args.path.includes('invalid'))throw 'invalid ZIP archive';return {manifest:{name:'Демо-сборка',voxelcore_version:'0.32.7',packages:[{id:'demo',version:'1.0.0',embedded:null}],worlds:true,settings:false,local_runtime:null},archive_sha256:'a'.repeat(64),download_size:1024,embedded_size:2048,local_mods:1};
 case 'import_vpack':{const p={...profile,id:'22222222-2222-4222-8222-222222222222',name:'Демо-сборка'};window.qa.profiles.push(p);return p;}
 case 'plugin:deep-link|get_current':return [];
 case 'load_access_token':return null;
 case 'discord_presence_status':return {enabled:false};
 default:return null;
 }
},{shouldMockEvents:true});
if(location.search.includes('stale')){window.qa.mode='stale';window.qa.installed=true;}
if(location.search.includes('startup'))window.qa.pending=[{id:'cold',path:'/tmp/cold.vpack'}];
await import('/src/main.tsx');`;
  await context.route("**/qa-bootstrap.js", (r) =>
    r.fulfill({ contentType: "application/javascript", body: mock }),
  );
  await context.route(/http:\/\/127\.0\.0\.1:1423\/(\?.*)?$/, async (r) => {
    const response = await r.fetch();
    await r.fulfill({
      response,
      body: (await response.text()).replace(
        /src="\/src\/main\.tsx[^"]*"/,
        'src="/qa-bootstrap.js"',
      ),
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("ERROR", e.message);
  });

  await page.goto("http://127.0.0.1:1423/?startup");
  await page.getByRole("dialog").waitFor();
  await page.waitForFunction(() =>
    window.qa.calls.includes("acknowledge_vpack_file"),
  );
  console.log("PASS: startup file is queued until the UI is ready");
  assert.equal(
    await page
      .getByRole("dialog")
      .getByText(/VSpace/)
      .count(),
    0,
  );
  await page.evaluate(async () => {
    window.qa.pending.push({ id: "warm", path: "/tmp/warm.vpack" });
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("vpack-open-requested", null);
  });
  await page.waitForTimeout(500);
  if (
    (await page.evaluate(
      () => window.qa.calls.filter((c) => c === "inspect_vpack").length,
    )) !== 1
  )
    throw Error("Incoming file replaced an open dialog");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.waitForFunction(
    () => window.qa.calls.filter((c) => c === "inspect_vpack").length === 2,
  );
  console.log("PASS: a second file waits for the first dialog to close");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Импортировать", exact: true })
    .click();
  await page.getByRole("heading", { name: "Сборка добавлена" }).waitFor();
  await page.screenshot({ path: out + "/import-success.png" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Играть", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Завершить игру", exact: true })
    .waitFor();
  console.log("PASS: imported profile has an explicit Play action");
  await page.goto("http://127.0.0.1:1423/");
  await page.getByRole("tab", { name: "Управление", exact: true }).click();
  await page
    .getByRole("button", { name: "Экспортировать vpack", exact: true })
    .click();
  await page.getByLabel("Включить миры").check();
  await page
    .getByRole("button", { name: "Подготовить архив", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Сборка готова к экспорту" })
    .waitFor();
  await page.getByText("3 КБ", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByText(/VSpace/)
      .count(),
    0,
  );
  await page.screenshot({ path: out + "/export-preview.png" });
  await page.evaluate(() => (window.qa.saveCancelled = true));
  await page
    .getByRole("button", { name: "Сохранить vpack", exact: true })
    .click();
  if (await page.evaluate(() => window.qa.calls.includes("save_vpack_export")))
    throw Error("Cancelled file dialog saved the archive");
  await page.evaluate(() => (window.qa.saveCancelled = false));
  await page
    .getByRole("button", { name: "Сохранить vpack", exact: true })
    .click();
  await page.getByRole("heading", { name: "Архив сохранён" }).waitFor();
  await page
    .getByRole("button", { name: "Показать файл", exact: true })
    .click();
  const commands = await page.evaluate(() => window.qa.records);
  if (commands.filter((c) => c.cmd === "prepare_vpack_export").length !== 1)
    throw Error("Archive was prepared more than once");
  if (
    commands.find((c) => c.cmd === "save_vpack_export")?.args.token !==
    "prepared-1"
  )
    throw Error("Saved archive differs from preview");
  if (
    !commands.some(
      (c) =>
        c.cmd === "plugin:opener|reveal_item_in_dir" &&
        c.args.paths[0] === "/tmp/export.vpack",
    )
  )
    throw Error("Saved file was not revealed");
  console.log(
    "PASS: export preview, cancelled save, exact prepared archive and reveal file",
  );
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await page
    .getByRole("button", { name: "Экспортировать vpack", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Подготовить архив", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Изменить состав", exact: true })
    .click();
  await page.getByLabel("Включить настройки").check();
  await page
    .getByRole("button", { name: "Подготовить архив", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Сборка готова к экспорту" })
    .waitFor();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.waitForFunction(() =>
    window.qa.records.some(
      (r) => r.cmd === "discard_vpack_export" && r.args.token === "prepared-3",
    ),
  );
  console.log(
    "PASS: changing options and closing preview discard staged exports",
  );
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    window.qa.profile.name = "ОченьДлинноеНазваниеСборки".repeat(3);
  });
  await page.getByRole("button", { name: "Библиотека", exact: true }).click();
  await page.getByRole("tab", { name: /Контент/ }).click();
  const findings = [];
  for (const screen of ["Библиотека", "Каталог", "Настройки", "Мастерская"]) {
    await page.getByRole("button", { name: screen, exact: true }).click();
    await page.locator("main").evaluate((e) => {
      e.scrollTop = 0;
    });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          "main, main > div:not([hidden]), .game-heading, .page-heading",
        ),
      )
        .filter(
          (e) =>
            e.getBoundingClientRect().width > 0 &&
            e.scrollWidth > e.clientWidth + 2,
        )
        .map((e) => ({
          class: e.className,
          width: e.clientWidth,
          scroll: e.scrollWidth,
        })),
    );
    if (overflow.length) findings.push({ screen, overflow });
    await page.screenshot({ path: out + "/audit-" + screen + ".png" });
  }
  console.log("UI findings:", JSON.stringify(findings));
  assert.deepEqual(
    findings,
    [],
    "Main screens must fit the smallest supported window",
  );
  await page.goto("http://127.0.0.1:1423/");
  await page
    .getByRole("button", { name: "Установить и играть", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Отменить загрузку", exact: true })
    .waitFor();
  await page.evaluate(async () => {
    window.qa.pending = [{ id: "busy", path: "/tmp/busy.vpack" }];
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("vpack-open-requested", null);
  });
  assert.equal(
    await page.getByRole("dialog").count(),
    0,
    "Incoming file must wait during installation",
  );
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  console.log("PASS: incoming file waits for the current operation");
  const busyCalls = await page.evaluate(() => window.qa.calls);
  assert.ok(
    busyCalls.indexOf("inspect_vpack") > busyCalls.indexOf("launch_profile"),
  );
  await page.evaluate(async () => {
    window.qa.pending = [{ id: "invalid", path: "/tmp/invalid.vpack" }];
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("vpack-open-requested", null);
  });
  await page.getByText("Не удалось открыть сборку", { exact: true }).waitFor();
  await page.waitForFunction(() => window.qa.pending.length === 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.evaluate(async () => {
    window.qa.pending = [{ id: "after-error", path: "/tmp/retry.vpack" }];
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("vpack-open-requested", null);
  });
  await page.getByRole("dialog").waitFor();
  console.log(
    "PASS: a malformed file is acknowledged and the next file still opens",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  await page.evaluate(async () => {
    window.qa.delayNextRead = 350;
    window.qa.pending = [{ id: "race-first", path: "/tmp/race-first.vpack" }];
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("vpack-open-requested", null);
  });
  await page.waitForFunction(() => window.qa.delayedReadStarted);
  await page.evaluate(async () => {
    window.qa.pending.push({
      id: "race-second",
      path: "/tmp/race-second.vpack",
    });
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("vpack-open-requested", null);
  });
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(450);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.qa.records.some(
      (record) =>
        record.cmd === "inspect_vpack" &&
        record.args.path === "/tmp/race-second.vpack",
    ),
  );
  await page.getByRole("dialog").waitFor();
  console.log("PASS: stale queue responses cannot lose a newer file");
  await page.goto("http://127.0.0.1:1423/?stale");
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await page
    .getByRole("button", { name: "Завершить игру", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page.evaluate(
      () =>
        window.qa.calls.filter((c) => c === "install_official_runtime").length,
    ),
    1,
  );
  console.log("PASS: runtime health overrides a stale installed-version list");
  if (errors.length) throw Error(JSON.stringify(errors));
} finally {
  await browser?.close();
  await server.close();
}
